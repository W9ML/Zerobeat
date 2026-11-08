/**
 * One FlexRadio GUI-client session: TCP command channel, a UDP socket for VITA-49, our
 * slice, DAX RX and TX streams, meters and transmit.
 *
 * Rules learned the hard way on the previous implementation:
 *  - `client gui` is required to transmit; a non-GUI client keys with no RF and no error.
 *  - `client gui` restores the client's profile, which can bring a slice with it: adopt
 *    a slice owned by our handle before creating one.
 *  - `slice tune` is not echoed to the connection that issued it: update our own model.
 *  - `stream remove` needs the `0x` prefix or the stream leaks.
 *  - Everything acquired in connect() is released by close(), including on failure.
 */
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import net from "node:net";

import {
  buildDaxTxPacket,
  CLASS_DAX_AUDIO,
  CLASS_DAX_REDUCED,
  CLASS_METER,
  DAX_RATE,
  daxAudioToMono,
  daxReducedToMono,
  FLEX_TCP_PORT,
  FLEX_VITA_PORT,
  mhzString,
  parseInfoReply,
  parseLine,
  parseMeterList,
  parseMeterPayload,
  parseStatusBody,
  parseVita,
  scaleMeter,
  TX_FRAMES_PER_PACKET,
  type MeterDef,
  type SliceMode,
} from "./protocol.ts";
import type { RadioInfo, Rig, RigEvents, SliceState, Telemetry, TxReport, TxRequest } from "../rig/types.ts";

export class FlexCommandError extends Error {
  constructor(
    readonly command: string,
    readonly status: number,
    message: string,
  ) {
    super(`"${command}" failed: 0x${status.toString(16).toUpperCase()}${message ? ` ${message}` : ""}`);
    this.name = "FlexCommandError";
  }
}

export type { RadioInfo, SliceState, Telemetry, TxRequest, TxReport } from "../rig/types.ts";
type Events = RigEvents;

export interface FlexRadioOptions {
  host: string;
  daxChannel: number;
  station?: string;
  defaultFreqHz: number;
  rxAntenna?: string;
  txAntenna?: string;
  log: (level: "info" | "warn", msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FlexRadio extends EventEmitter<Events> implements Rig {
  readonly host: string;
  info: RadioInfo = { model: "", serial: "", version: "", nickname: "", callsign: "", atu: false };
  handle = "";
  slice: SliceState | null = null;
  interlock = { state: "", txClient: "", reason: "", txAllowed: true };
  transmit = { rfpower: 0, dax: false, txFilterHi: 0 };
  telemetry: Telemetry = { fwdW: null, swr: null, paTempC: null, supplyV: null, sLevelDbm: null, at: 0 };

  private sock: net.Socket | null = null;
  private udp: dgram.Socket | null = null;
  private buf = "";
  private seq = 1;
  private pending = new Map<number, { cmd: string; resolve: (m: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private rxStream: number | null = null;
  private txStream: number | null = null;
  private txCounter = 0;
  private meters = new Map<number, MeterDef & { kind: keyof Omit<Telemetry, "at"> | null }>();
  private keyed = false;
  private watchdog: NodeJS.Timeout | null = null;
  private closing = false;
  private closed = false;
  private sliceRaw = new Map<number, Record<string, string>>();
  private peakFwd = 0;
  private peakSwr = 0;
  private seenClasses = new Set<string>();

  constructor(private readonly opts: FlexRadioOptions) {
    super();
    this.host = opts.host;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    try {
      await this.openTcp();
      await this.openUdp();
      await this.command("client gui");
      await this.command("client station Zerobeat").catch(() => {});
      await this.command(`client udpport ${this.udp!.address().port}`);
      for (const s of ["radio all", "tx all", "slice all", "atu all", "client all"]) {
        await this.command(`sub ${s}`).catch((e) => this.opts.log("warn", `sub ${s}: ${(e as Error).message}`));
      }
      const info = parseInfoReply(await this.command("info"));
      this.info = {
        model: info.model ?? "",
        serial: info.chassis_serial ?? "",
        version: info.software_ver ?? "",
        nickname: info.nickname ?? "",
        callsign: info.callsign ?? "",
        atu: info.atu_present === "1",
      };
      await this.acquireSlice();
      await this.setupDax();
      await this.setupMeters();
    } catch (err) {
      await this.close(err as Error);
      throw err;
    }
  }

  async close(reason: Error | null = null): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    try {
      if (this.keyed) await this.command("xmit 0", 2000).catch(() => {});
      if (this.sock && !this.sock.destroyed) {
        for (const id of [this.rxStream, this.txStream]) {
          if (id !== null) await this.command(`stream remove 0x${id.toString(16)}`, 2000).catch(() => {});
        }
      }
    } finally {
      if (this.watchdog) clearTimeout(this.watchdog);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("connection closed"));
      }
      this.pending.clear();
      this.sock?.destroy();
      this.udp?.close();
      this.sock = null;
      this.udp = null;
      this.closed = true;
      this.emit("closed", reason);
    }
  }

  get isOpen(): boolean {
    return !this.closed && !this.closing && !!this.sock;
  }

  private openTcp(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: FLEX_TCP_PORT });
      this.sock = sock;
      sock.setEncoding("utf8");
      sock.setNoDelay(true);
      sock.setKeepAlive(true, 15_000);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`no answer from ${this.host}:${FLEX_TCP_PORT} within 10s`));
      }, 10_000);
      let ready = false;
      sock.on("data", (chunk: string) => {
        this.buf += chunk;
        let i: number;
        while ((i = this.buf.indexOf("\n")) !== -1) {
          const line = this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          if (!line) continue;
          const parsed = parseLine(line);
          if (parsed.kind === "handle" && !ready) {
            this.handle = parsed.handle;
            ready = true;
            clearTimeout(timer);
            resolve();
          }
          this.onLine(parsed);
        }
      });
      sock.once("error", (e) => {
        if (!ready) {
          clearTimeout(timer);
          reject(e);
        }
      });
      sock.on("close", () => {
        if (!ready) return;
        if (!this.closing) void this.close(new Error("radio closed the connection"));
      });
    });
  }

  private openUdp(): Promise<void> {
    return new Promise((resolve, reject) => {
      const udp = dgram.createSocket({ type: "udp4", recvBufferSize: 4 * 1024 * 1024 });
      this.udp = udp;
      udp.once("error", reject);
      udp.on("message", (msg) => this.onUdp(msg));
      udp.bind(0, () => {
        udp.off("error", reject);
        udp.on("error", (e) => this.opts.log("warn", `udp: ${e.message}`));
        resolve();
      });
    });
  }

  // -------------------------------------------------------------------------
  // Commands and status
  // -------------------------------------------------------------------------

  command(cmd: string, timeoutMs = 8000): Promise<string> {
    const sock = this.sock;
    if (!sock || sock.destroyed) return Promise.reject(new Error("not connected"));
    const seq = this.seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`"${cmd}" timed out`));
      }, timeoutMs);
      this.pending.set(seq, { cmd, resolve, reject, timer });
      sock.write(`C${seq}|${cmd}\n`, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(seq);
          reject(err);
        }
      });
    });
  }

  private onLine(l: ReturnType<typeof parseLine>): void {
    if (l.kind === "reply") {
      const p = this.pending.get(l.seq);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(l.seq);
      if (l.status === 0) p.resolve(l.message);
      else p.reject(new FlexCommandError(p.cmd, l.status, l.message));
    } else if (l.kind === "status") {
      this.onStatus(l.body);
    } else if (l.kind === "message") {
      this.emit("message", `${l.code}: ${l.text}`);
    }
  }

  private onStatus(body: string): void {
    const s = parseStatusBody(body);
    if (s.object === "slice" && s.id !== null && /^\d+$/.test(s.id)) {
      const idx = Number(s.id);
      const raw = { ...(this.sliceRaw.get(idx) ?? {}), ...s.fields };
      if (raw.in_use === "0") {
        this.sliceRaw.delete(idx);
        if (this.slice?.index === idx) {
          this.opts.log("warn", `our slice ${idx} was removed on the radio`);
          this.slice = null;
        }
        return;
      }
      this.sliceRaw.set(idx, raw);
      if (this.slice?.index === idx) this.applySlice(idx, raw, this.slice.owned);
    } else if (s.object === "interlock") {
      const prev = this.interlock.state === "TRANSMITTING";
      if (s.fields.state) this.interlock.state = s.fields.state;
      if (s.fields.tx_client_handle !== undefined) this.interlock.txClient = s.fields.tx_client_handle.replace(/^0x/i, "").toUpperCase();
      const was = this.txProblem;
      if (s.fields.reason !== undefined) this.interlock.reason = s.fields.reason;
      if (s.fields.tx_allowed !== undefined) this.interlock.txAllowed = s.fields.tx_allowed !== "0";
      if (this.txProblem !== was) this.emit("txReady");
      const now = this.interlock.state === "TRANSMITTING";
      if (now !== prev) this.emit("transmitting", now);
      // Someone at the radio's own GUI keyed it: tell the station, which stands down.
      if (now && !prev && !this.keyed && this.interlock.txClient && this.handle && this.interlock.txClient !== this.handle) {
        this.emit("otherTx", this.interlock.txClient);
      }
    } else if (s.object === "transmit") {
      if (s.fields.rfpower) this.transmit.rfpower = Number(s.fields.rfpower);
      if (s.fields.dax !== undefined) this.transmit.dax = s.fields.dax === "1";
      if (s.fields.hi) this.transmit.txFilterHi = Number(s.fields.hi);
    }
  }

  private applySlice(idx: number, raw: Record<string, string>, owned: boolean): void {
    const prevFreq = this.slice?.freqHz;
    const freq = raw.RF_frequency !== undefined ? Math.round(Number(raw.RF_frequency) * 1_000_000) : (prevFreq ?? 0);
    this.slice = {
      index: idx,
      freqHz: freq,
      mode: raw.mode ?? "",
      rxAnt: raw.rxant ?? "",
      txAnt: raw.txant ?? "",
      antList: (raw.ant_list ?? "").split(",").filter(Boolean),
      txAntList: (raw.tx_ant_list ?? "").split(",").filter(Boolean),
      tx: raw.tx === "1",
      dax: Number(raw.dax ?? 0),
      owned,
    };
    this.emit("slice", this.slice);
  }

  // -------------------------------------------------------------------------
  // Slice, DAX, meters
  // -------------------------------------------------------------------------

  private async acquireSlice(): Promise<void> {
    const mine = [...this.sliceRaw.entries()].find(([, r]) => (r.client_handle ?? "").replace(/^0x/i, "").toUpperCase() === this.handle);
    let idx: number;
    let owned: boolean;
    if (mine) {
      idx = mine[0];
      owned = false;
      this.opts.log("info", `adopted slice ${idx} restored from the radio profile`);
    } else {
      const ant = this.opts.rxAntenna ? ` ant=${this.opts.rxAntenna}` : "";
      const reply = await this.command(`slice create freq=${mhzString(this.opts.defaultFreqHz)}${ant} mode=DIGU`);
      idx = Number(reply.trim());
      if (!Number.isInteger(idx)) throw new Error(`slice create returned "${reply}"`);
      owned = true;
      for (let i = 0; i < 30 && !this.sliceRaw.has(idx); i++) await sleep(100);
      this.opts.log("info", `created slice ${idx}`);
    }
    this.applySlice(idx, this.sliceRaw.get(idx) ?? { RF_frequency: String(this.opts.defaultFreqHz / 1e6), mode: "DIGU" }, owned);
    await this.command(`slice set ${idx} mode=DIGU`);
    await this.command(`slice set ${idx} dax=${this.opts.daxChannel}`);
    if (this.opts.rxAntenna || this.opts.txAntenna) {
      const parts = [this.opts.rxAntenna ? `rxant=${this.opts.rxAntenna}` : "", this.opts.txAntenna ? `txant=${this.opts.txAntenna}` : ""].filter(Boolean);
      await this.command(`slice set ${idx} ${parts.join(" ")}`).catch((e) => this.opts.log("warn", `antenna: ${(e as Error).message}`));
    }
    const raw = { ...(this.sliceRaw.get(idx) ?? {}), mode: "DIGU", dax: String(this.opts.daxChannel) };
    this.sliceRaw.set(idx, raw);
    this.applySlice(idx, raw, owned);
  }

  private async setupDax(): Promise<void> {
    const ch = this.opts.daxChannel;
    this.rxStream = parseInt((await this.command(`stream create type=dax_rx dax_channel=${ch}`)).trim(), 16);
    await this.command("client set send_reduced_bw_dax=1").catch((e) => this.opts.log("warn", `reduced-bw DAX: ${(e as Error).message}`));
    await this.command(`dax audio set ${ch} slice=${this.slice!.index} tx=1`);
    this.txStream = parseInt((await this.command(`stream create type=dax_tx dax_channel=${ch}`)).trim(), 16);
    if (!Number.isFinite(this.rxStream) || !Number.isFinite(this.txStream)) throw new Error("DAX stream ids not returned");
  }

  private async setupMeters(): Promise<void> {
    const list = parseMeterList(await this.command("meter list"));
    const want = (m: MeterDef): keyof Omit<Telemetry, "at"> | null => {
      const n = m.name.toUpperCase();
      if (m.src.startsWith("TX") && n === "FWDPWR") return "fwdW";
      if (m.src.startsWith("TX") && n === "SWR") return "swr";
      if (n === "PATEMP") return "paTempC";
      if (n === "+13.8A" || n === "+13.8B") return "supplyV";
      if (m.src === "SLC" && n === "LEVEL" && m.num === this.slice?.index) return "sLevelDbm";
      return null;
    };
    for (const m of list) this.meters.set(m.id, { ...m, kind: want(m) });
    await this.command("sub meter all").catch((e) => this.opts.log("warn", `meters: ${(e as Error).message}`));
  }

  private lastTelemetryEmit = 0;
  private lastRxCount: number | null = null;

  private onUdp(msg: Buffer): void {
    const p = parseVita(msg);
    if (!p) return;
    if (p.streamId === this.rxStream && (p.packetClass === CLASS_DAX_AUDIO || p.packetClass === CLASS_DAX_REDUCED)) {
      // With send_reduced_bw_dax set, receive audio also arrives as int16 mono.
      const audio = p.packetClass === CLASS_DAX_AUDIO ? daxAudioToMono(p.payload) : daxReducedToMono(p.payload);
      // The packet counter says how many packets the network lost (up to 15 in a row).
      // Arrival time can't: a burst that arrives late is late, not missing.
      const missed = this.lastRxCount === null ? 0 : (p.count - this.lastRxCount - 1 + 16) % 16;
      this.lastRxCount = p.count;
      this.emit("audio", audio, Date.now(), missed * audio.length);
    } else if (p.packetClass === CLASS_METER) {
      let touched = false;
      for (const { id, raw } of parseMeterPayload(p.payload)) {
        const m = this.meters.get(id);
        if (!m?.kind) continue;
        let v = scaleMeter(raw, m.unit);
        if (m.kind === "fwdW") {
          v = v > -50 ? 10 ** ((v - 30) / 10) : 0;
          if (this.keyed) this.peakFwd = Math.max(this.peakFwd, v);
        }
        if (m.kind === "swr" && this.keyed && v > 0) this.peakSwr = Math.max(this.peakSwr, v);
        this.telemetry[m.kind] = Math.round(v * 100) / 100;
        touched = true;
      }
      const now = Date.now();
      if (touched && now - this.lastTelemetryEmit >= 250) {
        this.lastTelemetryEmit = now;
        this.telemetry.at = now;
        this.emit("telemetry", { ...this.telemetry });
      }
    } else if (p.packetClass === 0x8003 || p.packetClass === 0x8004) {
      // Panadapter and waterfall frames for the profile's display; not used.
    } else {
      const key = `${p.packetClass.toString(16)}/${p.streamId.toString(16)}`;
      if (!this.seenClasses.has(key)) {
        this.seenClasses.add(key);
        this.opts.log("info", `VITA packet class 0x${key} (${msg.length} bytes) not handled; rx stream is 0x${this.rxStream?.toString(16)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Control
  // -------------------------------------------------------------------------

  private requireSlice(): SliceState {
    if (!this.slice) throw new Error("no slice on the radio");
    return this.slice;
  }

  async tune(hz: number): Promise<void> {
    const s = this.requireSlice();
    await this.command(`slice tune ${s.index} ${mhzString(hz)}`);
    const raw = { ...(this.sliceRaw.get(s.index) ?? {}), RF_frequency: (hz / 1e6).toFixed(6) };
    this.sliceRaw.set(s.index, raw);
    this.applySlice(s.index, raw, s.owned);
  }

  async setMode(mode: SliceMode): Promise<void> {
    const s = this.requireSlice();
    await this.command(`slice set ${s.index} mode=${mode}`);
  }

  async setRfPower(pct: number): Promise<void> {
    await this.command(`transmit set rfpower=${Math.max(0, Math.min(100, Math.round(pct)))}`);
  }

  async atuStart(): Promise<void> {
    await this.command("atu start");
  }

  // -------------------------------------------------------------------------
  // Transmit
  // -------------------------------------------------------------------------

  /** Everything that must be true before keying. Throws with an operator-facing reason. */
  private async preKey(): Promise<void> {
    const s = this.requireSlice();
    if (this.txStream === null) throw new Error("DAX TX stream is not set up");
    if (this.anotherClientKeyed()) throw new Error("another client is transmitting");
    if (!s.tx) await this.command(`slice set ${s.index} tx=1`);
    if (s.mode !== "DIGU" && s.mode !== "DIGL") await this.command(`slice set ${s.index} mode=DIGU`);
    if (s.dax !== this.opts.daxChannel) await this.command(`slice set ${s.index} dax=${this.opts.daxChannel}`);
    if (!this.transmit.dax) {
      await this.command("transmit set dax=1");
      // Put it back after the over: with DAX on, the operator's microphone is dead in
      // SmartSDR until they find the switch.
      this.daxSetByUs = true;
    }
  }

  /**
   * The radio refusing to transmit by itself: its interlock NOT_READY (or a fault state)
   * with transmit not allowed, e.g. reason PA_TIMEOUT on an Aurora. Every xmit then fails
   * with "The transmitter is not ready", so the station says so instead of trying.
   */
  get txProblem(): string | null {
    const st = this.interlock.state;
    if (!["NOT_READY", "TX_FAULT", "TIMEOUT", "STUCK_INPUT"].includes(st) || this.interlock.txAllowed) return null;
    const why = this.interlock.reason && this.interlock.reason !== "NONE" ? `: ${this.interlock.reason}` : "";
    return `the radio is not ready to transmit (Flex interlock ${st}${why})`;
  }

  /** True while we turned DAX transmit on for an over and owe the radio a dax=0. */
  private daxSetByUs = false;

  private anotherClientKeyed(): boolean {
    return !!this.interlock.txClient && this.interlock.txClient !== this.handle && this.interlock.state === "TRANSMITTING";
  }

  async transmitAudio(req: TxRequest): Promise<TxReport> {
    if (this.keyed) return { ok: false, detail: "already transmitting", startedLateMs: 0, packets: 0, peakFwdW: 0, peakSwr: 0 };
    await this.preKey();
    const keyLead = 40;
    const wait = req.startAt - keyLead - Date.now();
    if (wait > 0) await sleep(wait);
    const late = Date.now() + keyLead - req.startAt;
    if (late > req.lateLimitMs) return { ok: false, detail: `too late to start (${late} ms)`, startedLateMs: late, packets: 0, peakFwdW: 0, peakSwr: 0 };
    if (req.stillWanted && !req.stillWanted()) return { ok: false, detail: "cancelled", startedLateMs: 0, packets: 0, peakFwdW: 0, peakSwr: 0 };
    // Checked again at key-up: the slot wait can be most of a period, and someone may have
    // keyed from SmartSDR in the meantime.
    if (this.anotherClientKeyed()) {
      await this.restoreDax();
      return { ok: false, detail: "another client is transmitting", startedLateMs: 0, packets: 0, peakFwdW: 0, peakSwr: 0 };
    }

    const durationMs = (req.samples.length / DAX_RATE) * 1000;
    this.keyed = true;
    this.peakFwd = 0;
    this.peakSwr = 0;
    this.watchdog = setTimeout(() => {
      this.opts.log("warn", "transmit watchdog fired; unkeying");
      void this.unkey();
    }, durationMs + 2500);
    let packets = 0;
    try {
      await this.command("xmit 1", 3000);
      const start = Math.max(Date.now(), req.startAt);
      // Skip audio we are already late for, so the signal stays aligned to the slot.
      const skip = Math.max(0, Math.floor(((start - req.startAt) / 1000) * DAX_RATE));
      const total = req.samples.length;
      const packetMs = (TX_FRAMES_PER_PACKET / DAX_RATE) * 1000;
      const aheadMs = 60;
      let i = skip;
      while (i < total && this.keyed) {
        const dueBy = Date.now() + aheadMs;
        while (i < total && start + ((i - skip) / TX_FRAMES_PER_PACKET) * packetMs <= dueBy) {
          const chunk = req.samples.subarray(i, Math.min(total, i + TX_FRAMES_PER_PACKET));
          let frame = chunk;
          if (chunk.length !== TX_FRAMES_PER_PACKET) {
            frame = new Float32Array(TX_FRAMES_PER_PACKET);
            frame.set(chunk);
          }
          this.udp?.send(buildDaxTxPacket(this.txStream!, this.txCounter++, frame), FLEX_VITA_PORT, this.host);
          packets++;
          i += TX_FRAMES_PER_PACKET;
        }
        await sleep(10);
      }
      // Let the radio play out what it has buffered.
      await sleep(aheadMs + 30);
      const startedLateMs = Math.round(start - req.startAt);
      return { ok: this.keyed, detail: this.keyed ? "sent" : "interrupted", startedLateMs, packets, peakFwdW: Math.round(this.peakFwd * 10) / 10, peakSwr: Math.round(this.peakSwr * 100) / 100 };
    } finally {
      await this.unkey();
      await this.restoreDax();
    }
  }

  private async restoreDax(): Promise<void> {
    if (!this.daxSetByUs) return;
    this.daxSetByUs = false;
    if (this.sock && !this.sock.destroyed) await this.command("transmit set dax=0", 3000).catch(() => {});
  }

  async unkey(): Promise<void> {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    const was = this.keyed;
    this.keyed = false;
    if (this.sock && !this.sock.destroyed) {
      await this.command("xmit 0", 3000).catch((e) => {
        if (was) this.opts.log("warn", `xmit 0: ${(e as Error).message}`);
      });
    }
  }

  get isKeyed(): boolean {
    return this.keyed;
  }
}
