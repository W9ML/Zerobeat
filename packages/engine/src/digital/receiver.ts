/**
 * Turns the radio's audio stream into decoded windows.
 *
 * Sample timing: DAX timestamps are dummies, so each 12 kHz sample's wall-clock time is
 * estimated from packet arrival. Packets can arrive late but never early, so the
 * estimate uses the minimum (arrival − samples-so-far) over the last 10 s. When audio
 * stops (the radio is transmitting, or a dropout) the gap is filled with silence so the
 * timeline stays aligned to UTC.
 *
 * Windows are cut on the schedule (the window index decides its start, not the time the
 * timer fires) and decoded on the decoder thread.
 */
import { EventEmitter } from "node:events";

import { Decimator2, Waterfall } from "../dsp/dsp.ts";
import type { Decoder } from "./decoder.ts";
import { parseMessage, senderOf, type Parsed } from "./message.ts";
import { TIMING, windowIndex, windowStart, type DigitalMode } from "./timing.ts";

const RATE = 12_000;
const RING_SECONDS = 40;

/**
 * Our own transmit audio is clean: drawn as it is, its tones sit 80 dB above the floor,
 * and the FFT window's sidelobes (there on every signal, but buried in the band noise on
 * received ones) light up a blob several times the signal's width. Drawn at the level
 * of a strong received signal it looks as wide as it is on the air: an FT8 signal is
 * 50 Hz wide whoever sends it.
 */
const TX_PEAK = 88; // display steps, 2.5 per dB with the 10 dB offset: 25 dB of colour
/**
 * A row's time from the time of its last sample: the middle of its FFT window, less half
 * the rows it is averaged with, so a cycle line falls where the audio changed slot.
 */
function rowTime(lastSampleAt: number): number {
  return lastSampleAt - ((Waterfall.N / 2 + ((Waterfall.AVG - 1) * Waterfall.HOP) / 2) / Waterfall.RATE) * 1000;
}

function asReceived(row: Uint8Array): Uint8Array {
  let peak = 0;
  for (let k = 0; k < row.length; k++) if (row[k]! > peak) peak = row[k]!;
  const cut = peak - TX_PEAK;
  if (cut <= 0) return row;
  const out = new Uint8Array(row.length);
  for (let k = 0; k < row.length; k++) out[k] = row[k]! > cut ? row[k]! - cut : 0;
  return out;
}

export interface Decode {
  windowIndex: number;
  at: number;
  mode: DigitalMode;
  offsetHz: number;
  snr: number;
  dt: number;
  text: string;
  parsed: Parsed[];
  sender: string | null;
  ap: boolean;
}

export interface WindowResult {
  index: number;
  mode: DigitalMode;
  start: number;
  decodes: Decode[];
  /** We transmitted in this window, so it was not decoded. */
  ownTx: boolean;
  /** Mean audio level (RMS) over the window; ~0 means no receive audio. */
  rms: number;
  decodeMs: number;
  skipped: string | null;
}

type Events = {
  window: [WindowResult];
  /** A waterfall row, and when the audio it shows was on the air (engine clock, ms). */
  waterfall: [Uint8Array, number];
  /** A waterfall row of our own transmit audio, drawn while the radio is keyed. */
  "waterfall-tx": [Uint8Array, number];
  level: [number];
  /** Every 12 kHz sample, gaps filled with silence, and the wall time of the first one. */
  audio: [Float32Array, number];
};

export class Receiver extends EventEmitter<Events> {
  mode: DigitalMode = "FT8";
  depth = 2;
  private readonly ring = new Float32Array(RING_SECONDS * RATE);
  private total = 0; // samples written since start
  private offsets: { at: number; offset: number }[] = [];
  private offsetMs: number | null = null; // wall time of sample 0
  private decimator = new Decimator2();
  private waterfall = new Waterfall();
  /** How far behind the clock the newest waterfall row is (audio path and FFT), ms. */
  lastRowLagMs: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ownTx = new Set<string>();
  private lastAudioAt = 0;
  private slowWarnedAt = 0;
  private running = false;
  private levelAcc = 0;
  private levelN = 0;
  private knownCalls: string[] = [];
  /** Off while an untimed mode (JTTY) has the receiver: no windows are cut or decoded. */
  private slotted = true;
  /** Our transmit audio, shown on the waterfall in place of receive while keyed. */
  private txArmed: { samples: Float32Array; startAt: number } | null = null;
  private txShow: { samples: Float32Array; startAt: number; pos: number; wf: Waterfall; timer: NodeJS.Timeout } | null = null;

  constructor(
    private readonly decoder: Decoder,
    private readonly log: (msg: string) => void,
  ) {
    super();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.endTxShow();
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  setSlotted(on: boolean): void {
    if (on === this.slotted) return;
    this.slotted = on;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (on) this.scheduleNext();
  }

  setMode(mode: DigitalMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (this.running) {
      if (this.timer) clearTimeout(this.timer);
      this.scheduleNext();
    }
  }

  /**
   * The audio about to be transmitted (24 kHz) and when it should start. Nothing is
   * drawn unless the radio then reports that it is transmitting (txKeyed), so a
   * transmission that is cancelled or refused never shows.
   */
  armTx(samples24k: Float32Array, startAt: number): void {
    const dec = new Decimator2();
    const s = dec.process(samples24k);
    // A faint dither gives the display a floor to measure, about 50 dB below the signal.
    let seed = 7;
    for (let i = 0; i < s.length; i++) s[i]! += (((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1) * 0.003;
    this.txArmed = { samples: s, startAt };
  }

  /** The radio keyed (true) or unkeyed (false). */
  txKeyed(on: boolean): void {
    if (!on) {
      const shown = !!this.txShow || Date.now() < this.rxHoldUntil;
      this.endTxShow();
      // Unkeyed after the drawn audio ended: the tail runs from the unkey.
      if (shown) this.rxHoldUntil = Date.now() + Receiver.TX_TAIL_MS;
      return;
    }
    const a = this.txArmed;
    this.txArmed = null;
    if (!a || Date.now() > a.startAt + 3000 || Date.now() < a.startAt - 3000) return;
    this.endTxShow();
    const show = { ...a, pos: 0, wf: new Waterfall(), timer: setInterval(() => this.txTick(), 50) };
    this.txShow = show;
    this.txTick();
  }

  private txTick(): void {
    const t = this.txShow;
    if (!t) return;
    // Rows follow the audio in real time, as the radio plays it.
    const due = Math.min(t.samples.length, Math.floor(((Date.now() - t.startAt) / 1000) * RATE));
    if (due > t.pos) {
      const ends: number[] = [];
      const rows = t.wf.push(t.samples.subarray(t.pos, due), ends);
      rows.forEach((row, k) => this.emit("waterfall-tx", asReceived(row), rowTime(t.startAt + ((t.pos + ends[k]!) / RATE) * 1000)));
      t.pos = due;
    }
    if (t.pos >= t.samples.length) this.endTxShow();
  }

  private endTxShow(): void {
    if (this.txShow) {
      clearInterval(this.txShow.timer);
      // The radio's switch back to receive, and the FFT window still holding it, would
      // draw a bright line across the band: the transmit band goes on a little longer.
      this.rxHoldUntil = Date.now() + Receiver.TX_TAIL_MS;
    }
    this.txShow = null;
  }

  /** After a transmission, how long the waterfall keeps drawing the transmit band. */
  static readonly TX_TAIL_MS = 400;
  private rxHoldUntil = 0;

  /** Calls the decoder should know for hashed messages (ours, mostly). */
  setKnownCalls(calls: string[]): void {
    this.knownCalls = calls;
  }

  markOwnTx(index: number, mode: DigitalMode): void {
    this.ownTx.add(`${mode}:${index}`);
    if (this.ownTx.size > 64) this.ownTx.delete(this.ownTx.values().next().value!);
  }

  get audioAgeMs(): number {
    return this.lastAudioAt ? Date.now() - this.lastAudioAt : Infinity;
  }

  /**
   * Feed 24 kHz audio from the radio. lost24k, when the transport counts packets (DAX),
   * is how much audio before this block never arrived; it is filled with silence so the
   * stream keeps its time. Without a count, only a long silence in arrival (a sound card
   * that stopped) is treated as lost: a burst that arrives late is jitter, and padding it
   * pushed every later sample later than it was.
   */
  feed(samples24k: Float32Array, arrivedAt: number, lost24k?: number): void {
    if (lost24k && lost24k > 0 && this.offsetMs !== null) this.write(new Float32Array(Math.min(RING_SECONDS * RATE, Math.round(lost24k / 2))));
    const s = this.decimator.process(samples24k);
    if (s.length === 0) return;
    this.lastAudioAt = arrivedAt;

    // Estimate the wall time of sample 0.
    if (this.offsetMs !== null) {
      const expectedFirst = this.offsetMs + (this.total / RATE) * 1000;
      const actualFirst = arrivedAt - (s.length / RATE) * 1000;
      const gap = actualFirst - expectedFirst;
      if (lost24k === undefined && gap > 500 && gap < RING_SECONDS * 1000) {
        this.write(new Float32Array(Math.round((gap / 1000) * RATE)));
      } else if (gap >= RING_SECONDS * 1000) {
        this.offsetMs = null;
        this.offsets = [];
      }
    }
    this.write(s, this.offsetMs === null ? arrivedAt - (s.length / RATE) * 1000 : undefined);
    const c = arrivedAt - (this.total / RATE) * 1000;
    this.offsets.push({ at: arrivedAt, offset: c });
    while (this.offsets.length && this.offsets[0]!.at < arrivedAt - 10_000) this.offsets.shift();
    let min = Infinity;
    for (const o of this.offsets) if (o.offset < min) min = o.offset;
    this.offsetMs = min;

    const holding = !!this.txShow || arrivedAt < this.rxHoldUntil;
    this.waterfall.holdFloor = holding;
    const ends: number[] = [];
    const rows = this.waterfall.push(s, ends);
    // On the air when: the first sample of this chunk, on the engine clock (as the windows use).
    const first = (this.offsetMs ?? arrivedAt - (s.length / RATE) * 1000) + ((this.total - s.length) / RATE) * 1000;
    if (!this.txShow) {
      rows.forEach((row, k) => {
        const at = rowTime(first + (ends[k]! / RATE) * 1000);
        this.lastRowLagMs = Date.now() - at;
        if (holding) this.emit("waterfall-tx", new Uint8Array(row.length), at);
        else this.emit("waterfall", row, at);
      });
    }
    for (let i = 0; i < s.length; i += 8) {
      this.levelAcc += s[i]! * s[i]!;
      this.levelN++;
    }
    if (this.levelN >= 1500) {
      this.emit("level", Math.sqrt(this.levelAcc / this.levelN));
      this.levelAcc = 0;
      this.levelN = 0;
    }
  }

  private write(s: Float32Array, firstMs?: number): void {
    if (this.listenerCount("audio")) this.emit("audio", s, firstMs ?? (this.offsetMs ?? Date.now()) + (this.total / RATE) * 1000);
    const n = this.ring.length;
    const pos = this.total % n;
    if (s.length >= n) {
      this.ring.set(s.subarray(s.length - n));
      this.total += s.length;
      return;
    }
    const first = Math.min(s.length, n - pos);
    this.ring.set(s.subarray(0, first), pos);
    if (first < s.length) this.ring.set(s.subarray(first), 0);
    this.total += s.length;
  }

  /** Samples covering [startMs, startMs+lenMs), or null if the buffer does not hold them. */
  private extract(startMs: number, lenMs: number): Float32Array | null {
    if (this.offsetMs === null) return null;
    const first = Math.round(((startMs - this.offsetMs) / 1000) * RATE);
    const len = Math.round((lenMs / 1000) * RATE);
    if (first < this.total - this.ring.length || first < 0) return null;
    const out = new Float32Array(len);
    const available = Math.max(0, Math.min(len, this.total - first));
    const n = this.ring.length;
    for (let i = 0; i < available; i++) out[i] = this.ring[(first + i) % n]!;
    // A tail shortfall of more than a second means the audio is not there.
    if (len - available > RATE) return null;
    return out;
  }

  private scheduleNext(): void {
    if (!this.running || !this.slotted) return;
    const mode = this.mode;
    const t = TIMING[mode];
    const now = Date.now();
    let idx = windowIndex(now, mode);
    if (now > windowStart(idx, mode) + t.cutMs) idx++;
    const cutAt = windowStart(idx, mode) + t.cutMs + 80; // allow for packet transit
    this.timer = setTimeout(() => {
      void this.decodeWindow(idx, mode);
      this.scheduleNext();
    }, Math.max(0, cutAt - now));
  }

  /** Cut and decode one window. Public so tests can drive it without timers. */
  async decodeWindow(index: number, mode: DigitalMode): Promise<void> {
    const t = TIMING[mode];
    const start = windowStart(index, mode);
    const base: WindowResult = { index, mode, start, decodes: [], ownTx: false, rms: 0, decodeMs: 0, skipped: null };
    if (this.ownTx.has(`${mode}:${index}`)) {
      this.emit("window", { ...base, ownTx: true, skipped: "transmitting" });
      return;
    }
    if (start + t.cutMs - this.lastAudioAt > 3000) {
      this.emit("window", { ...base, skipped: "no audio from the radio" });
      return;
    }
    const audio = this.extract(start, t.cutMs);
    if (!audio) {
      this.emit("window", { ...base, skipped: "not enough audio buffered" });
      return;
    }
    let sum = 0;
    for (let i = 0; i < audio.length; i += 4) sum += audio[i]! * audio[i]!;
    const rms = Math.sqrt(sum / (audio.length / 4));
    // Normalise to a sensible level for the decoder.
    let peak = 0;
    for (let i = 0; i < audio.length; i++) peak = Math.max(peak, Math.abs(audio[i]!));
    if (peak > 0) for (let i = 0; i < audio.length; i++) audio[i]! *= 0.8 / peak;

    const r = await this.decoder.decode({ mode, samples: audio, slotStart: start, depth: this.depth, knownCalls: this.knownCalls });
    if (r.error) this.log(`decode window ${index}: ${r.error}`);
    // The budget: from the cut to the latest a reply may start (the next period's audio
    // start plus the late limit). Beyond it the reply to this window is skipped.
    const budget = t.periodMs - t.cutMs - 80 + t.txStartMs + t.lateLimitMs;
    if (r.ms > budget && Date.now() - this.slowWarnedAt > 10 * 60_000) {
      this.slowWarnedAt = Date.now();
      this.log(`decoding took ${r.ms} ms, more than the ${budget} ms there is to answer in the next ${mode} period: replies to some windows are skipped. Lower the decode depth in Settings, or look for something else using the CPU.`);
    }
    const decodes: Decode[] = r.decodes.map((d) => {
      const parsed = parseMessage(d.msg);
      return {
        windowIndex: index,
        at: start,
        mode,
        offsetHz: d.freq,
        snr: d.snr,
        dt: d.dt,
        text: d.msg,
        parsed,
        sender: parsed.map(senderOf).find((x) => !!x) ?? null,
        ap: !!d.ap,
      };
    });
    this.emit("window", { ...base, decodes, rms, decodeMs: r.ms });
  }
}
