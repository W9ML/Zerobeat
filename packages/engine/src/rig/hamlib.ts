/**
 * Any radio Hamlib knows (Yaesu, Kenwood, Elecraft, Xiegu, older ICOMs and many more),
 * through rigctld, Hamlib's network daemon. Control goes over rigctld's TCP port in its
 * extended response protocol ("+\command"), where every reply ends with "RPRT n"; audio
 * goes through the radio's USB sound card (or an interface such as a SignaLink) with ALSA,
 * like the ICOM USB driver.
 *
 * rigctld can run anywhere (another machine with the radio on its serial port, say), or
 * the engine starts it itself when a Hamlib model number is set.
 *
 * Mode: PKTUSB, Hamlib's name for USB with the data input (USB-D, DATA-U, DIGU), falling
 * back to USB on radios that have no data mode. PTT: "data" PTT (3) where the radio
 * distinguishes, which keys from the rear/USB audio rather than the microphone.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";

import { linuxIo, type Capture, type IcomIo, type Playback } from "./icom-io.ts";
import type { RadioInfo, Rig, RigEvents, SliceState, Telemetry, TxReport, TxRequest } from "./types.ts";

export interface HamlibOptions {
  /** rigctld's address. */
  host: string;
  port: number;
  /** Start rigctld here with this model number (rigctl -l lists them); 0 = connect to one already running. */
  model: number;
  device: string;
  baud: number;
  /** How rigctld keys the radio: over CAT, or the serial port's DTR or RTS line. */
  pttMethod: "cat" | "dtr" | "rts";
  audioDevice: string;
  ratedWatts: number;
  defaultFreqHz: number;
  log: (level: "info" | "warn", msg: string) => void;
  io?: Pick<IcomIo, "startCapture" | "openPlayback">;
  /** For tests: how to start rigctld. */
  spawnRigctld?: (args: string[]) => ChildProcess;
}

const RATE = 24_000;
const CMD_TIMEOUT_MS = 2_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HamlibError extends Error {}

/** Hamlib's error codes (rig.h RIG_E*), for messages people can act on. */
const RPRT: Record<number, string> = {
  1: "invalid parameter",
  2: "invalid configuration",
  3: "out of memory",
  4: "not implemented by this radio's Hamlib driver",
  5: "communication timed out (is the radio on, and the baud rate right?)",
  6: "I/O error",
  7: "internal Hamlib error",
  8: "protocol error",
  9: "the radio rejected the command",
  10: "the command was truncated",
  11: "function not available on this radio",
  12: "VFO not targetable",
  13: "bus error",
  14: "bus collision",
  15: "NULL handle",
  16: "invalid VFO",
  17: "argument out of range",
};

export interface RigctldReply {
  /** "Key: value" lines, by key. */
  fields: Map<string, string>;
  /** Every line before RPRT, the echoed command first. */
  lines: string[];
  code: number;
}

/** One TCP connection to rigctld: one command at a time, each reply read up to its RPRT line. */
export class RigctldLink {
  private sock: net.Socket | null = null;
  private buf = "";
  private queue: Promise<unknown> = Promise.resolve();
  private waiting: { resolve: (r: RigctldReply) => void; reject: (e: Error) => void; lines: string[]; timer: NodeJS.Timeout } | null = null;
  private closers: ((e: Error | null) => void)[] = [];
  private closed = false;

  async open(host: string, port: number, timeoutMs = 3_000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const s = net.connect({ host, port });
      const t = setTimeout(() => {
        s.destroy();
        reject(new Error(`no rigctld at ${host}:${port}`));
      }, timeoutMs);
      s.once("connect", () => {
        clearTimeout(t);
        resolve();
      });
      s.once("error", (e) => {
        clearTimeout(t);
        reject(new Error(`rigctld at ${host}:${port}: ${e.message}`));
      });
      this.sock = s;
    });
    const s = this.sock!;
    s.setNoDelay(true);
    s.setEncoding("utf8");
    s.on("data", (d: string) => this.onData(d));
    s.on("close", () => this.end(new Error("rigctld closed the connection")));
    s.on("error", (e) => this.end(e));
  }

  onClose(fn: (e: Error | null) => void): void {
    this.closers.push(fn);
  }

  close(): void {
    this.end(null);
  }

  private end(e: Error | null): void {
    if (this.closed) return;
    this.closed = true;
    this.sock?.destroy();
    if (this.waiting) {
      clearTimeout(this.waiting.timer);
      this.waiting.reject(e ?? new Error("closed"));
      this.waiting = null;
    }
    for (const f of this.closers) f(e);
  }

  private onData(d: string): void {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      const w = this.waiting;
      if (!w) continue; // stray output
      const m = /^RPRT (-?\d+)$/.exec(line.trim());
      if (m) {
        this.waiting = null;
        clearTimeout(w.timer);
        const fields = new Map<string, string>();
        for (const l of w.lines.slice(1)) {
          const k = l.indexOf(":");
          if (k > 0) fields.set(l.slice(0, k).trim(), l.slice(k + 1).trim());
        }
        w.resolve({ fields, lines: w.lines, code: Math.abs(Number(m[1])) });
      } else w.lines.push(line);
    }
  }

  /** Send `\command args` and resolve with its reply; a non-zero RPRT rejects. */
  cmd(command: string, ...args: (string | number)[]): Promise<RigctldReply> {
    const run = () =>
      new Promise<RigctldReply>((resolve, reject) => {
        if (!this.sock || this.closed) return reject(new Error("rigctld not connected"));
        const timer = setTimeout(() => {
          if (this.waiting?.timer === timer) this.waiting = null;
          reject(new HamlibError(`rigctld did not answer ${command}`));
        }, CMD_TIMEOUT_MS);
        this.waiting = {
          resolve: (r) => (r.code === 0 ? resolve(r) : reject(new HamlibError(`${command}: ${RPRT[r.code] ?? `Hamlib error ${r.code}`}`))),
          reject,
          lines: [],
          timer,
        };
        this.sock.write(`+\\${command}${args.length ? " " + args.join(" ") : ""}\n`);
      });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}

/** A get command's value: its "Key: value" line, or the last line when rigctld prints the bare value. */
function value(r: RigctldReply, key?: string): string | null {
  if (key && r.fields.has(key)) return r.fields.get(key)!;
  const last = r.lines.at(-1);
  if (!last || r.lines.length < 2) return null;
  const k = last.indexOf(":");
  return (k > 0 ? last.slice(k + 1) : last).trim();
}

export class HamlibRadio extends EventEmitter<RigEvents> implements Rig {
  readonly host: string;
  info: RadioInfo = { model: "", serial: "", version: "", nickname: "", callsign: "", atu: false };
  slice: SliceState | null = null;
  telemetry: Telemetry = { fwdW: null, swr: null, paTempC: null, supplyV: null, sLevelDbm: null, at: 0 };
  transmit = { rfpower: 0 };

  private readonly io: Pick<IcomIo, "startCapture" | "openPlayback">;
  private link: RigctldLink | null = null;
  private daemon: ChildProcess | null = null;
  private capture: Capture | null = null;
  private playback: Playback | null = null;
  private keyed = false;
  private closed = false;
  private poll: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private peakFwd = 0;
  private peakSwr = 0;
  private dataMode = "PKTUSB";
  private pttOn = 3;
  private wattsMeter = true;
  /** Whether any power reading arrived during the current over. */
  private meterSeen = false;

  constructor(private readonly opts: HamlibOptions) {
    super();
    this.host = opts.model ? `${opts.device} (Hamlib model ${opts.model})` : `rigctld ${opts.host}:${opts.port}`;
    this.io = opts.io ?? linuxIo;
  }

  get isKeyed(): boolean {
    return this.keyed;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** rigctld arguments for the configured radio. */
  static rigctldArgs(o: Pick<HamlibOptions, "model" | "device" | "baud" | "pttMethod" | "port">): string[] {
    const a = ["-m", String(o.model), "-r", o.device, "-T", "127.0.0.1", "-t", String(o.port)];
    if (o.baud) a.push("-s", String(o.baud));
    if (o.pttMethod === "dtr") a.push("-P", "DTR", "-p", o.device);
    if (o.pttMethod === "rts") a.push("-P", "RTS", "-p", o.device);
    return a;
  }

  private async startDaemon(): Promise<void> {
    if (!this.opts.device) throw new Error("set the radio's serial port in Settings → Radio");
    const args = HamlibRadio.rigctldArgs(this.opts);
    const p = (this.opts.spawnRigctld ?? ((a) => spawn("rigctld", a, { stdio: ["ignore", "ignore", "pipe"] })))(args);
    this.daemon = p;
    let stderr = "";
    p.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-400)));
    const failed = new Promise<never>((_, reject) => {
      p.once("error", (e) => reject(new Error(`rigctld: ${e.message} (install Hamlib: deploy/enable-local-radio.sh)`)));
      p.once("exit", (code) => reject(new Error(`rigctld exited (${code})${stderr ? `: ${stderr.trim()}` : ""}`)));
    });
    failed.catch(() => {});
    // Wait for its port to open.
    for (let i = 0; i < 25; i++) {
      const link = new RigctldLink();
      const ok = await Promise.race([link.open("127.0.0.1", this.opts.port, 400).then(() => true, () => false), failed]);
      if (ok) {
        this.link = link;
        return;
      }
      await sleep(200);
    }
    throw new Error(`rigctld did not start listening on port ${this.opts.port}${stderr ? `: ${stderr.trim()}` : ""}`);
  }

  async connect(): Promise<void> {
    try {
      if (this.opts.model) await this.startDaemon();
      else {
        const link = new RigctldLink();
        await link.open(this.opts.host, this.opts.port);
        this.link = link;
      }
      const link = this.link!;
      link.onClose((e) => void this.close(e ?? new Error("rigctld connection closed")));

      const caps = await link.cmd("dump_caps").catch(() => null);
      const model = caps?.fields.get("Model name") ?? "";
      const mfg = caps?.fields.get("Mfg name") ?? "";
      this.info.model = [mfg, model].filter(Boolean).join(" ") || "Hamlib radio";
      this.info.version = caps?.fields.get("Hamlib version") ?? "";
      this.info.atu = /TUNE/.test(caps?.fields.get("VFO Ops") ?? "");
      // A radio left keyed by a program that died mid-over: unkey it first.
      await link.cmd("set_ptt", 0).catch(() => {});

      let freq = Number(value(await link.cmd("get_freq"), "Frequency"));
      if (!freq) {
        await this.tune(this.opts.defaultFreqHz);
        freq = this.opts.defaultFreqHz;
      }
      await this.setDataMode();
      const pwr = await link.cmd("get_level", "RFPOWER").catch(() => null);
      if (pwr) this.transmit.rfpower = Math.round(Number(value(pwr)) * 100) || 0;
      this.slice = { index: 0, freqHz: freq, mode: this.dataMode === "PKTUSB" ? "USB-D" : "USB", rxAnt: "", txAnt: "", antList: [], txAntList: [], tx: true, dax: 0, owned: true };
      this.emit("slice", this.slice);

      this.capture = this.io.startCapture(this.opts.audioDevice, RATE, (s) => this.emit("audio", s, Date.now()), (e) => void this.close(e));
      this.poll = setInterval(() => void this.pollTick(), 1_000);
    } catch (e) {
      await this.close(null, true);
      throw e;
    }
  }

  async close(reason: Error | null = null, quiet = false): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    if (this.keyed) await this.link?.cmd("set_ptt", 0).catch(() => {});
    this.keyed = false;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.playback?.kill();
    this.capture?.stop();
    this.link?.close();
    this.link = null;
    this.daemon?.kill("SIGTERM");
    this.daemon = null;
    if (!quiet) this.emit("closed", reason);
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  private async setDataMode(): Promise<void> {
    try {
      await this.link!.cmd("set_mode", "PKTUSB", 0);
      this.dataMode = "PKTUSB";
    } catch {
      await this.link!.cmd("set_mode", "USB", 0);
      if (this.dataMode !== "USB") this.opts.log("info", "this radio has no USB data mode in Hamlib; using USB (turn the microphone gain down or unplug it)");
      this.dataMode = "USB";
    }
    if (this.slice) this.slice = { ...this.slice, mode: this.dataMode === "PKTUSB" ? "USB-D" : "USB" };
  }

  private async pollTick(): Promise<void> {
    if (this.closed || this.keyed || !this.link) return;
    const f = await this.link.cmd("get_freq").catch(() => null);
    const hz = f ? Number(value(f, "Frequency")) : 0;
    if (hz && this.slice && hz !== this.slice.freqHz) {
      this.slice = { ...this.slice, freqHz: hz };
      this.emit("slice", this.slice);
    }
    // STRENGTH is dB relative to S9 (-73 dBm).
    const s = await this.link.cmd("get_level", "STRENGTH").catch(() => null);
    const db = s ? Number(value(s)) : NaN;
    if (Number.isFinite(db)) {
      this.telemetry = { ...this.telemetry, sLevelDbm: Math.round(db - 73), at: Date.now() };
      this.emit("telemetry", { ...this.telemetry });
    }
  }

  async tune(hz: number): Promise<void> {
    if (!this.link) throw new Error("radio not connected");
    await this.link.cmd("set_freq", Math.round(hz));
    if (this.slice) {
      this.slice = { ...this.slice, freqHz: hz };
      this.emit("slice", this.slice);
    }
  }

  async setRfPower(pct: number): Promise<void> {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    await this.link?.cmd("set_level", "RFPOWER", (p / 100).toFixed(2));
    this.transmit.rfpower = p;
  }

  async atuStart(): Promise<void> {
    if (!this.link) throw new Error("radio not connected");
    await this.link.cmd("vfo_op", "TUNE");
  }

  private async ptt(on: boolean): Promise<void> {
    if (!on) {
      await this.link?.cmd("set_ptt", 0);
      return;
    }
    try {
      await this.link!.cmd("set_ptt", this.pttOn);
    } catch (e) {
      // A radio without separate data PTT: plain PTT on.
      if (this.pttOn === 1) throw e;
      this.pttOn = 1;
      await this.link!.cmd("set_ptt", 1);
    }
  }

  async transmitAudio(req: TxRequest): Promise<TxReport> {
    const none = (detail: string, late = 0): TxReport => ({ ok: false, detail, startedLateMs: late, packets: 0, peakFwdW: 0, peakSwr: 0 });
    if (this.keyed) return none("already transmitting");
    if (!this.link) return none("radio not connected");
    const play = this.io.openPlayback(this.opts.audioDevice, RATE);
    this.playback = play;
    const pcm = toInt16(req.samples);
    const durationMs = (req.samples.length / RATE) * 1000;
    const keyLead = 80;
    const wait = req.startAt - keyLead - Date.now();
    if (wait > 0) await sleep(wait);
    const late = Date.now() + keyLead - req.startAt;
    if (req.stillWanted && !req.stillWanted()) {
      play.kill();
      this.playback = null;
      return none("cancelled");
    }
    if (late > req.lateLimitMs) {
      play.kill();
      this.playback = null;
      return none(`too late to start (${late} ms)`, late);
    }
    this.peakFwd = 0;
    this.peakSwr = 0;
    this.meterSeen = false;
    this.keyed = true;
    this.emit("transmitting", true);
    this.watchdog = setTimeout(() => {
      this.opts.log("warn", "transmit watchdog fired; unkeying");
      void this.unkey();
    }, durationMs + 2_500);
    let meters: NodeJS.Timeout | null = null;
    try {
      await this.ptt(true);
      const lead = req.startAt - Date.now();
      if (lead > 0) await sleep(lead);
      const start = Date.now();
      const skip = Math.max(0, Math.floor(((start - req.startAt) / 1000) * RATE));
      meters = setInterval(() => void this.txMeters(), 250);
      await play.write(pcm.subarray(skip));
      await Promise.race([play.finish(), sleep(durationMs + 1_500)]);
      return {
        ok: this.keyed,
        detail: this.keyed ? "sent" : "interrupted",
        startedLateMs: Math.round(start - req.startAt),
        packets: Math.ceil((pcm.length - skip) / 480),
        peakFwdW: Math.round(this.peakFwd * 10) / 10,
        peakSwr: Math.round(this.peakSwr * 100) / 100,
        metered: this.meterSeen,
      };
    } catch (e) {
      return none((e as Error).message);
    } finally {
      if (meters) clearInterval(meters);
      await this.unkey();
    }
  }

  /** Power and SWR while keyed: watts where Hamlib has them, else the 0–1 meter × rated power. */
  private async txMeters(): Promise<void> {
    const l = this.link;
    if (!this.keyed || !l) return;
    let fwdW: number | null = null;
    if (this.wattsMeter) {
      const w = await l.cmd("get_level", "RFPOWER_METER_WATTS").catch(() => null);
      if (w) fwdW = Number(value(w));
      else this.wattsMeter = false;
    }
    if (fwdW === null || !Number.isFinite(fwdW)) {
      const m = await l.cmd("get_level", "RFPOWER_METER").catch(() => null);
      const v = m ? Number(value(m)) : NaN;
      fwdW = Number.isFinite(v) ? v * this.opts.ratedWatts : null;
    }
    const sw = await l.cmd("get_level", "SWR").catch(() => null);
    const s = sw ? Number(value(sw)) : NaN;
    const swr = Number.isFinite(s) && s >= 1 && fwdW !== null && fwdW > 0.5 ? s : null;
    if (fwdW !== null) {
      this.meterSeen = true;
      this.peakFwd = Math.max(this.peakFwd, fwdW);
    }
    if (swr !== null) this.peakSwr = Math.max(this.peakSwr, swr);
    this.telemetry = { ...this.telemetry, fwdW, swr, at: Date.now() };
    this.emit("telemetry", { ...this.telemetry });
  }

  async unkey(): Promise<void> {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    const was = this.keyed;
    this.keyed = false;
    this.playback?.kill();
    this.playback = null;
    if (this.link && !this.closed) {
      await this.ptt(false).catch((e) => {
        if (was) this.opts.log("warn", `PTT off: ${(e as Error).message}`);
      });
    }
    if (was) {
      this.telemetry = { ...this.telemetry, fwdW: 0, swr: null, at: Date.now() };
      this.emit("telemetry", { ...this.telemetry });
      this.emit("transmitting", false);
    }
  }
}

function toInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.max(-32767, Math.min(32767, Math.round(f[i]! * 32767)));
  return out;
}
