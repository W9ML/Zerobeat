/**
 * ICOM transceivers, over USB (CI-V on the radio's USB serial port, audio through its USB
 * sound card) or over the network (the radio's own LAN server, rig/icom-lan.ts). Written
 * for the IC-7300MK2 (CI-V address B6h); the same commands work on the IC-7300 (94h),
 * IC-705 and IC-9700, which differ only in address.
 *
 * Radio-side settings this needs (Menu → Set → Connectors):
 *   USB: CI-V USB Port: Unlink from [REMOTE], CI-V USB Baud Rate: 115200, DATA MOD: USB
 *   LAN: Network Control on, a Network User, DATA MOD: LAN
 * The driver checks DATA MOD at connect and says so if it is not the right source,
 * because then the radio keys with a dead carrier.
 *
 * Commands are serialised: one outstanding at a time, each answered by FB/FA or by the
 * data it asked for, or timed out. Frequency changes made on the radio's knob arrive as
 * unsolicited frames when CI-V Transceive is on, and the frequency is also polled.
 */
import { EventEmitter } from "node:events";

import { bcdToFreq, bcdToLevel, CIV_MODE, CIV_MODE_NAME, CivParser, CONTROLLER, frame, freqToBcd, ICOM_MODELS, levelToBcd, NG, OK, poPercent, smeterDbm, swrFromLevel, type CivFrame } from "./civ.ts";
import { linuxIo, type Capture, type IcomIo, type Playback, type SerialLink } from "./icom-io.ts";
import type { RadioInfo, Rig, RigEvents, SliceState, Telemetry, TxReport, TxRequest } from "./types.ts";

export interface IcomOptions {
  /** Device path, or "host (LAN)" for a network radio: shown as where the radio is. */
  serialPath: string;
  baud: number;
  civAddress: number;
  audioDevice: string;
  ratedWatts: number;
  defaultFreqHz: number;
  log: (level: "info" | "warn", msg: string) => void;
  io?: IcomIo & { outputLatencyMs?: number; close?: () => void };
  /** Where DATA MOD should take audio from: 1 = USB, 5 = LAN. */
  dataModSource?: number;
  /** The radio's name for itself, when the connection reports one. */
  modelName?: string;
}

const RATE = 24_000;
const CMD_TIMEOUT_MS = 1_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class IcomCommandError extends Error {}

interface Pending {
  cmd: number;
  sub: number[];
  wantData: boolean;
  resolve: (f: CivFrame) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class IcomRadio extends EventEmitter<RigEvents> implements Rig {
  readonly host: string;
  info: RadioInfo = { model: "", serial: "", version: "", nickname: "", callsign: "", atu: true };
  slice: SliceState | null = null;
  telemetry: Telemetry = { fwdW: null, swr: null, paTempC: null, supplyV: null, sLevelDbm: null, at: 0 };
  transmit = { rfpower: 0 };

  private readonly io: IcomIo & { outputLatencyMs?: number; close?: () => void };
  private serial: SerialLink | null = null;
  private capture: Capture | null = null;
  private playback: Playback | null = null;
  private parser = new CivParser();
  private queue: Promise<unknown> = Promise.resolve();
  private pending: Pending | null = null;
  private keyed = false;
  private closed = false;
  private poll: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private peakFwd = 0;
  private peakSwr = 0;

  constructor(private readonly opts: IcomOptions) {
    super();
    this.host = opts.serialPath;
    this.io = opts.io ?? linuxIo;
  }

  get isKeyed(): boolean {
    return this.keyed;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    try {
      this.serial = await this.io.openSerial(this.opts.serialPath, this.opts.baud);
      this.serial.onData((b) => this.onBytes(b));
      this.serial.onClose((e) => void this.close(e ?? new Error("serial port closed")));

      const id = await this.exec(0x19, [0x00], [], true).catch(() => null);
      if (!id) throw new Error(`no answer from CI-V address ${hex(this.opts.civAddress)} on ${this.opts.serialPath} (check the address, CI-V USB baud rate ${this.opts.baud} and "Unlink from [REMOTE]")`);
      this.info.model = this.opts.modelName || (ICOM_MODELS[this.opts.civAddress] ?? `ICOM ${hex(this.opts.civAddress)}`);
      // A radio left keyed by a program that died mid-over: unkey it first.
      await this.ptt(false).catch(() => {});

      let freq = await this.readFreq();
      if (!freq) {
        await this.tune(this.opts.defaultFreqHz);
        freq = this.opts.defaultFreqHz;
      }
      await this.setDataMode();
      const mod = await this.exec(0x1a, [0x05, 0x00, 0x85], [], true).catch(() => null);
      const src = mod ? mod.data[3] : null;
      const want = this.opts.dataModSource ?? 0x01;
      const NAMES = ["MIC", "USB", "ACC", "MIC+USB", "MIC+ACC", "LAN"];
      if (src !== undefined && src !== null && src !== want) {
        this.opts.log("warn", `the radio's DATA MOD input is ${NAMES[src] ?? src}, not ${NAMES[want]}: transmit audio will not reach it (Menu → Set → Connectors → MOD Input → DATA MOD → ${NAMES[want]})`);
      }
      const pwr = await this.exec(0x14, [0x0a], [], true).catch(() => null);
      if (pwr) this.transmit.rfpower = Math.round((bcdToLevel(pwr.data.subarray(1, 3)) / 255) * 100);
      this.slice = { index: 0, freqHz: freq, mode: "USB-D", rxAnt: "", txAnt: "", antList: [], txAntList: [], tx: true, dax: 0, owned: true };
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
    if (this.keyed) await this.ptt(false).catch(() => {});
    this.keyed = false;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.playback?.kill();
    this.capture?.stop();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error("radio closed"));
      this.pending = null;
    }
    this.serial?.close();
    this.serial = null;
    this.io.close?.();
    if (!quiet) this.emit("closed", reason);
  }

  // -------------------------------------------------------------------------
  // CI-V
  // -------------------------------------------------------------------------

  private onBytes(b: Buffer): void {
    for (const f of this.parser.push(b)) {
      if (f.from === CONTROLLER) continue; // our own frame echoed back
      if (f.from !== this.opts.civAddress) continue;
      if (f.to === 0x00) {
        this.onTransceive(f);
        continue;
      }
      if (f.to !== CONTROLLER) continue;
      const p = this.pending;
      if (!p) continue;
      if (f.cmd === OK && !p.wantData) this.settle(f);
      else if (f.cmd === NG) this.settle(null, new IcomCommandError(`the radio refused command ${hex(p.cmd)}${p.sub.length ? ` ${p.sub.map(hex).join(" ")}` : ""}`));
      else if (f.cmd === p.cmd && p.sub.every((s, i) => f.data[i] === s)) this.settle(f);
    }
  }

  private settle(f: CivFrame | null, err?: Error): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(f!);
  }

  /** Unsolicited frames (CI-V Transceive): the operator turned the knob or changed mode. */
  private onTransceive(f: CivFrame): void {
    if (!this.slice) return;
    if (f.cmd === 0x00 && f.data.length >= 5) {
      this.slice = { ...this.slice, freqHz: bcdToFreq(f.data.subarray(0, 5)) };
      this.emit("slice", this.slice);
    } else if (f.cmd === 0x01 && f.data.length >= 1) {
      this.slice = { ...this.slice, mode: CIV_MODE_NAME[f.data[0]!] ?? this.slice.mode };
      this.emit("slice", this.slice);
    }
  }

  /** Send one command and wait for FB, or for the data it reads when `wantData`. */
  private exec(cmd: number, sub: number[], data: number[] | Buffer, wantData = false): Promise<CivFrame> {
    const run = () =>
      new Promise<CivFrame>((resolve, reject) => {
        if (!this.serial || this.closed) return reject(new Error("radio not connected"));
        const timer = setTimeout(() => {
          if (this.pending?.timer === timer) this.pending = null;
          reject(new IcomCommandError(`no reply to command ${hex(cmd)}`));
        }, CMD_TIMEOUT_MS);
        this.pending = { cmd, sub, wantData, resolve, reject, timer };
        this.serial.write(frame(this.opts.civAddress, CONTROLLER, cmd, sub, data)).catch((e) => {
          clearTimeout(timer);
          this.pending = null;
          reject(e);
        });
      });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  private async readFreq(): Promise<number | null> {
    const f = await this.exec(0x03, [], [], true).catch(() => null);
    return f && f.data.length >= 5 ? bcdToFreq(f.data.subarray(0, 5)) : null;
  }

  /** USB with DATA on and filter 1: command 26 for the selected VFO. */
  private async setDataMode(): Promise<void> {
    try {
      await this.exec(0x26, [0x00], [CIV_MODE.USB, 0x01, 0x01]);
    } catch {
      // Older radios without command 26: mode USB, then data mode via 1A 06.
      await this.exec(0x06, [], [CIV_MODE.USB, 0x01]);
      await this.exec(0x1a, [0x06], [0x01, 0x01]);
    }
    if (this.slice) this.slice = { ...this.slice, mode: "USB-D" };
  }

  private ptt(on: boolean): Promise<CivFrame> {
    return this.exec(0x1c, [0x00], [on ? 0x01 : 0x00]);
  }

  private async readMeter(sub: number): Promise<number | null> {
    const f = await this.exec(0x15, [sub], [], true).catch(() => null);
    return f && f.data.length >= 3 ? bcdToLevel(f.data.subarray(1, 3)) : null;
  }

  /** Once a second: frequency (the knob may have moved) and the S-meter. */
  private async pollTick(): Promise<void> {
    if (this.closed || this.keyed || this.pending) return;
    const hz = await this.readFreq();
    if (hz && this.slice && hz !== this.slice.freqHz) {
      this.slice = { ...this.slice, freqHz: hz };
      this.emit("slice", this.slice);
    }
    const s = await this.readMeter(0x02);
    if (s !== null) {
      this.telemetry = { ...this.telemetry, sLevelDbm: Math.round(smeterDbm(s)), at: Date.now() };
      this.emit("telemetry", { ...this.telemetry });
    }
  }

  // -------------------------------------------------------------------------
  // Rig
  // -------------------------------------------------------------------------

  async tune(hz: number): Promise<void> {
    await this.exec(0x05, [], freqToBcd(hz));
    if (this.slice) {
      this.slice = { ...this.slice, freqHz: hz };
      this.emit("slice", this.slice);
    }
  }

  async setRfPower(pct: number): Promise<void> {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    await this.exec(0x14, [0x0a], levelToBcd(Math.round((p / 100) * 255)));
    this.transmit.rfpower = p;
  }

  async atuStart(): Promise<void> {
    await this.exec(0x1c, [0x01], [0x02]);
  }

  async transmitAudio(req: TxRequest): Promise<TxReport> {
    const none = (detail: string, late = 0): TxReport => ({ ok: false, detail, startedLateMs: late, packets: 0, peakFwdW: 0, peakSwr: 0 });
    if (this.keyed) return none("already transmitting");
    if (this.slice?.mode !== "USB-D") await this.setDataMode();
    // Start the player before keying so its start-up time is not on air.
    const play = this.io.openPlayback(this.opts.audioDevice, RATE);
    this.playback = play;
    const pcm = toInt16(req.samples);
    const durationMs = (req.samples.length / RATE) * 1000;
    // Over the network the radio buffers our audio before it goes out: send that early.
    const latency = this.io.outputLatencyMs ?? 0;
    const sendAt = req.startAt - latency;
    const keyLead = 60;
    const wait = sendAt - keyLead - Date.now();
    if (wait > 0) await sleep(wait);
    const lateAtKey = Date.now() + keyLead - sendAt;
    if (req.stillWanted && !req.stillWanted()) {
      play.kill();
      this.playback = null;
      return none("cancelled");
    }
    if (lateAtKey > req.lateLimitMs) {
      play.kill();
      this.playback = null;
      return none(`too late to start (${lateAtKey} ms)`, lateAtKey);
    }
    this.peakFwd = 0;
    this.peakSwr = 0;
    this.keyed = true;
    this.emit("transmitting", true);
    this.watchdog = setTimeout(() => {
      this.opts.log("warn", "transmit watchdog fired; unkeying");
      void this.unkey();
    }, durationMs + 2_500);
    let meters: NodeJS.Timeout | null = null;
    try {
      await this.ptt(true);
      const lead = sendAt - Date.now();
      if (lead > 0) await sleep(lead);
      const start = Date.now();
      // Skip what we are already late for, so the signal stays aligned to the slot.
      const skip = Math.max(0, Math.floor(((start - sendAt) / 1000) * RATE));
      meters = setInterval(() => void this.txMeters(), 200);
      await play.write(pcm.subarray(skip));
      await Promise.race([play.finish(), sleep(durationMs + 1_500)]);
      return {
        ok: this.keyed,
        detail: this.keyed ? "sent" : "interrupted",
        startedLateMs: Math.round(start - sendAt),
        packets: Math.ceil((pcm.length - skip) / 480),
        peakFwdW: Math.round(this.peakFwd * 10) / 10,
        peakSwr: Math.round(this.peakSwr * 100) / 100,
      };
    } catch (e) {
      return none((e as Error).message);
    } finally {
      if (meters) clearInterval(meters);
      await this.unkey();
    }
  }

  private async txMeters(): Promise<void> {
    if (!this.keyed || this.pending) return;
    const po = await this.readMeter(0x11);
    const swr = await this.readMeter(0x12);
    const fwdW = po !== null ? (poPercent(po) / 100) * this.opts.ratedWatts : null;
    const s = swr !== null && fwdW !== null && fwdW > 0.5 ? swrFromLevel(swr) : null;
    if (fwdW !== null) this.peakFwd = Math.max(this.peakFwd, fwdW);
    if (s !== null) this.peakSwr = Math.max(this.peakSwr, s);
    this.telemetry = { ...this.telemetry, fwdW, swr: s, at: Date.now() };
    this.emit("telemetry", { ...this.telemetry });
  }

  async unkey(): Promise<void> {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    const was = this.keyed;
    this.keyed = false;
    this.playback?.kill();
    this.playback = null;
    if (this.serial && !this.closed) {
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

function hex(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, "0") + "h";
}
