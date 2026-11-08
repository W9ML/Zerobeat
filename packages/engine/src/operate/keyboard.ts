/**
 * The keyboard desk: the untimed, typed modes. JTTY (WSJT-X 3.2), RTTY, PSK31, CW and Hell all
 * run beside the slotted FT8/FT4/FT2 pipeline rather than through it: their receiver
 * listens to the whole passband continuously (the operator's frequency plus every signal
 * it finds), and a message goes out the moment the operator sends it.
 *
 * The desk owns receive, the conversation and the function-key context. Keying stays
 * with the station (Station.sendKeyboard), behind the same checks as every transmission.
 */
import { EventEmitter } from "node:events";

import { JttyAssembler, JttyReceiver, atomsToTones, tonesToWaveform } from "../digital/jtty/modem.ts";
import { compileMacro, FKEYS as JTTY_FKEYS, packText, type Atom, type ExchangeProfile, type MacroContext } from "../digital/jtty/source.ts";
import type { KeyLine, KeyReceiver } from "../digital/keyboard/common.ts";
import { CwReceiver, cwText, cwWaveform } from "../digital/keyboard/cw.ts";
import { HellDetector, type HellSeen } from "../digital/keyboard/hell-detect.ts";
import { HELL_MAX_MS, HELL_ROWS, hellDurationMs, hellPrint, HellReceiver, hellText, hellWaveform, isHellSpeed, type HellChunk, type HellSpeed } from "../digital/keyboard/hell.ts";
import { PskReceiver, pskText, pskWaveform } from "../digital/keyboard/psk31.ts";
import { RttyReceiver, rttyText, rttyWaveform } from "../digital/keyboard/rtty.ts";

export type KeyMode = "JTTY" | "RTTY" | "PSK31" | "CW" | "HELL";
export const KEY_MODES: readonly KeyMode[] = ["JTTY", "RTTY", "PSK31", "CW", "HELL"];

export type { KeyLine };

export interface KeyTx {
  text: string;
  frames: number;
  startedAt: number;
  durationMs: number;
}

export interface KeyContext {
  hisCall: string;
  queueCall: string;
  /** The exchange: blank sends the running serial when `serialOn` (or in JTTY). */
  exchange: string;
  /** A contest wants the serial sent: set by the station from the contest, not by hand. */
  serialOn: boolean;
  profile: ExchangeProfile;
  /** Next serial when the exchange is a number; bumped after each logged contact. */
  serial: number;
  /** CW sending speed. */
  wpm: number;
  /** Hell speed: Feld Hell, or Slow Hell, Hell x5, Hell x9, FSK Hell 105 or 245. */
  hellSpeed: HellSpeed;
  /** FSK Hell: swap the ink and paper tones (as fldigi's Reverse). */
  hellReverse: boolean;
}

/**
 * Function keys for the text modes, in the shape each mode's operators use. %M is our
 * call, %H theirs, %Q the next in the queue, %X the exchange alone, %E "599" and the
 * exchange (as JTTY's %E).
 */
export const TEXT_FKEYS: Record<Exclude<KeyMode, "JTTY">, readonly string[]> = {
  RTTY: ["CQ CQ CQ DE %M %M %M K", "%H 599 %X %X", "%H TU %M CQ", "%M %M", "%H %H", "%H TU NOW %Q 599 %X %X", "%H AGN AGN", "599 %X %X"],
  PSK31: ["CQ CQ CQ de %M %M %M pse k", "%H de %M - UR %E - %H de %M kn", "%H de %M - TNX QSO 73 - %H de %M sk", "%M", "%H de %M kn", "%H TU - %Q de %M %E", "%H de %M - pse agn - kn", "%E"],
  CW: ["CQ CQ DE %M %M K", "%H 5NN %X", "%H TU 73 %M", "%M", "%H", "TU %Q 5NN %X", "AGN?", "5NN %X"],
  HELL: ["CQ CQ CQ DE %M %M %M K", "%H DE %M UR %E %H DE %M K", "%H DE %M TNX QSO 73 %H DE %M SK", "%M", "%H DE %M K", "%H TU %Q DE %M %E", "%H DE %M PSE AGN K", "%E"],
};

type Events = { line: [KeyLine & { mode: KeyMode }]; hell: [HellChunk]; hellSeen: [HellSeen]; state: []; clear: [] };

/** Hell columns kept for a page that opens later: about two minutes at Feld Hell. */
const KEEP_HELL_COLUMNS = 2_400;

const KEEP_LINES = 300;
const MAX_TEXT = 500;

export class KeyboardDesk extends EventEmitter<Events> {
  mode: KeyMode | null = null;
  lines: (KeyLine & { mode: KeyMode })[] = [];
  ctx: KeyContext = { hisCall: "", queueCall: "", exchange: "", profile: "unknown", serial: 1, wpm: 22, serialOn: false, hellSpeed: "feld", hellReverse: false };
  sending: KeyTx | null = null;
  private rx: KeyReceiver | null = null;
  /** In Hell: what is at the marker (which Hell mode, CW, something else). */
  private detector: HellDetector | null = null;
  private _rxHz = 1500;
  private _muted = false;
  private txCount = 0;
  private hellChunks: HellChunk[] = [];
  private hellCols = 0;
  private gen = 0;
  heard = 0;

  constructor(initial?: Partial<KeyContext>) {
    super();
    if (initial) this.ctx = { ...this.ctx, ...initial };
  }

  /** Switch the receiver to a mode (null: none, the slotted modes have the audio). */
  start(mode: KeyMode | null): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.gen++;
    this.rx = mode ? this.makeReceiver(mode) : null;
    if (this.rx) {
      this.rx.rxHz = this._rxHz;
      this.rx.muted = this._muted;
    }
    this.detector = null;
    if (mode === "HELL") {
      const gen = this.gen;
      this.detector = new HellDetector((s) => gen === this.gen && this.emit("hellSeen", s));
      this.detector.rxHz = this._rxHz;
      this.detector.muted = this._muted;
    }
    this.emit("state");
  }

  /** In Hell, the last thing heard at the marker. */
  get hellSeen(): HellSeen | null {
    return this.detector?.seen ?? null;
  }

  stop(): void {
    this.start(null);
  }

  get active(): boolean {
    return this.mode !== null;
  }

  private makeReceiver(mode: KeyMode): KeyReceiver {
    const gen = this.gen;
    const emit = (l: KeyLine) => {
      if (gen !== this.gen) return;
      this.heard++;
      this.push({ ...l, mode });
    };
    if (mode === "RTTY") return new RttyReceiver(emit);
    if (mode === "PSK31") return new PskReceiver(emit);
    if (mode === "CW") return new CwReceiver(emit);
    if (mode === "HELL") return new HellReceiver((c) => gen === this.gen && this.pushHell(c), this.ctx.hellSpeed, this.ctx.hellReverse);
    // JTTY: frames join into messages; each message is one line, growing frame by frame.
    const asm = new JttyAssembler();
    const rx = new JttyReceiver((f) => {
      const m = asm.add(f);
      emit({ id: `jtty-${gen}-${m.id}`, dir: "rx", startMs: m.startMs, updatedMs: m.updatedMs, freqHz: m.freqHz, snr: m.snr, text: m.text, complete: m.complete, atRx: Math.abs(m.freqHz - rx.rxHz) <= rx.rxTolHz });
    });
    return rx;
  }

  /** 12 kHz receive audio. */
  feed(samples: Float32Array, firstSampleMs: number): void {
    this.rx?.push(samples, firstSampleMs);
    this.detector?.push(samples, Date.now());
  }

  set rxHz(hz: number) {
    this._rxHz = hz;
    if (this.rx) this.rx.rxHz = hz;
    if (this.detector) this.detector.rxHz = hz;
  }

  set muted(m: boolean) {
    this._muted = m;
    if (this.rx) this.rx.muted = m;
    if (this.detector) this.detector.muted = m;
  }

  get muted(): boolean {
    return this._muted;
  }

  setContext(patch: Partial<KeyContext>): void {
    const c = { ...this.ctx, ...patch };
    c.hisCall = c.hisCall.trim().toUpperCase().slice(0, 16);
    c.queueCall = c.queueCall.trim().toUpperCase().slice(0, 16);
    c.exchange = c.exchange.trim().toUpperCase().slice(0, 16);
    c.serial = Math.max(1, Math.min(9999, Math.round(c.serial)));
    c.wpm = Math.max(5, Math.min(50, Math.round(c.wpm)));
    if (!isHellSpeed(c.hellSpeed)) c.hellSpeed = "feld";
    c.hellReverse = !!c.hellReverse;
    const respeed = (c.hellSpeed !== this.ctx.hellSpeed || c.hellReverse !== this.ctx.hellReverse) && this.mode === "HELL";
    this.ctx = c;
    if (respeed) {
      // A new speed is a new receiver: the pixel clock and filter go with it.
      this.gen++;
      this.rx = this.makeReceiver("HELL");
      this.rx.rxHz = this._rxHz;
      this.rx.muted = this._muted;
    }
    this.emit("state");
  }

  /** The operator's own function keys, by mode, where they edited them. */
  customFkeys: Partial<Record<KeyMode, string[]>> = {};

  defaultFkeys(mode: KeyMode): readonly string[] {
    return mode === "JTTY" ? JTTY_FKEYS : TEXT_FKEYS[mode];
  }

  fkeys(mode: KeyMode | null = this.mode): readonly string[] {
    if (!mode) return [];
    return this.customFkeys[mode] ?? this.defaultFkeys(mode);
  }

  /**
   * Replace a mode's eight keys (null: back to the defaults). JTTY keys must compile to
   * frames; the text modes take any text up to 120 characters. Returns why not, or null.
   */
  setFkeys(mode: KeyMode, keys: string[] | null): string | null {
    if (keys === null) {
      delete this.customFkeys[mode];
      this.emit("state");
      return null;
    }
    if (keys.length !== 8) return "give eight keys";
    const clean = keys.map((k) => k.replace(/\s+/g, " ").trim().slice(0, 120));
    if (mode === "JTTY") {
      const sample: MacroContext = { myCall: "W1XYZ", hisCall: "K1ABC", queueCall: "N0XYZ", exchange: this.exchange(), profile: this.ctx.profile };
      for (let i = 0; i < 8; i++) {
        if (!clean[i]) continue;
        // JTTY sends 80 characters at most and would cut a longer key short without saying.
        if (clean[i]!.length > 80) return `F${i + 1}: JTTY sends at most 80 characters (this is ${clean[i]!.length})`;
        const r = compileMacro(clean[i]!, sample);
        if ("error" in r) return `F${i + 1}: ${r.error}`;
      }
    }
    this.customFkeys[mode] = clean;
    this.emit("state");
    return null;
  }

  /**
   * What %X sends. A contest's exchange, or its serial; JTTY's own exchange is a serial
   * (WSJT-X's); a ragchew in the other modes has none, so %E is just the report.
   */
  private exchange(): string {
    if (this.ctx.exchange) return this.ctx.exchange;
    return this.ctx.serialOn || this.mode === "JTTY" ? String(this.ctx.serial).padStart(3, "0") : "";
  }

  private macroContext(myCall: string): MacroContext {
    return { myCall, hisCall: this.ctx.hisCall, queueCall: this.ctx.queueCall, exchange: this.exchange(), profile: this.ctx.profile };
  }

  /** %M %H %Q %X %E in a text-mode template, or why it cannot be filled. */
  private expand(t: string, myCall: string): string | { error: string } {
    if (/%H/i.test(t) && !this.ctx.hisCall) return { error: "set their call first (%H)" };
    if (/%Q/i.test(t) && !this.ctx.queueCall) return { error: "set the next call in the queue first (%Q)" };
    return t
      .replace(/%M/gi, myCall)
      .replace(/%H/gi, this.ctx.hisCall)
      .replace(/%Q/gi, this.ctx.queueCall)
      .replace(/%X/gi, this.exchange())
      .replace(/%E/gi, `599 ${this.exchange()}`.trim())
      .replace(/ {2,}/g, " ")
      .trim();
  }

  /**
   * Text or a function key → what goes on the air, or why it cannot. JTTY packs into
   * atoms; the other modes send the text as the mode can carry it.
   */
  compose(input: { text?: string; fkey?: number }, myCall: string): { text: string; atoms?: Atom[] } | { error: string } {
    const mode = this.mode;
    if (!mode) return { error: "no keyboard mode is on" };
    let raw: string;
    if (input.fkey !== undefined) {
      const t = this.fkeys()[input.fkey - 1];
      if (!t) return { error: `no F${input.fkey}` };
      if (mode === "JTTY") return compileMacro(t, this.macroContext(myCall));
      raw = t;
    } else raw = (input.text ?? "").trim();
    if (!raw) return { error: "nothing to send" };
    if (mode === "JTTY") {
      if (raw.length > 80) return { error: `too long: JTTY sends at most 80 characters at a time (this is ${raw.length})` };
      const r = /%[MHEQ]/i.test(raw) ? compileMacro(raw, this.macroContext(myCall)) : packText(raw, this.ctx.profile);
      if (!r) return { error: "too long: JTTY sends at most 16 frames (about 80 characters) at a time" };
      return r;
    }
    const filled = this.expand(raw, myCall);
    if (typeof filled !== "string") return filled;
    if (filled.length > MAX_TEXT) return { error: `too long: at most ${MAX_TEXT} characters at a time (this is ${filled.length})` };
    const text = mode === "RTTY" ? rttyText(filled) : mode === "PSK31" ? pskText(filled) : mode === "HELL" ? hellText(filled) : cwText(filled);
    if (!text.trim()) return { error: `nothing ${mode} can send in that` };
    if (mode === "HELL" && hellDurationMs(text, this.ctx.hellSpeed) > HELL_MAX_MS) return { error: `too long: that would key for ${Math.round(hellDurationMs(text, this.ctx.hellSpeed) / 1000)} s at this speed (3 minutes at most)` };
    return { text };
  }

  /** 24 kHz audio for a composed message at the given audio offset. */
  waveform(c: { text: string; atoms?: Atom[] }, offsetHz: number): Float32Array {
    const mode = this.mode;
    if (mode === "JTTY") return tonesToWaveform(atomsToTones(c.atoms!), offsetHz, 24_000);
    if (mode === "RTTY") return rttyWaveform(c.text, offsetHz, 24_000);
    if (mode === "PSK31") return pskWaveform(c.text, offsetHz, 24_000);
    if (mode === "CW") return cwWaveform(c.text, offsetHz, 24_000, this.ctx.wpm);
    if (mode === "HELL") return hellWaveform(c.text, offsetHz, 24_000, this.ctx.hellSpeed, this.ctx.hellReverse);
    throw new Error("no keyboard mode is on");
  }

  /** The station tells the desk what went out. */
  sent(text: string, freqHz: number, startedAt: number): void {
    if (!this.mode) return;
    this.push({ id: `tx-${++this.txCount}`, dir: "tx", startMs: startedAt, updatedMs: Date.now(), freqHz, snr: null, text, complete: true, atRx: true, mode: this.mode });
    // On the Hell tape our own message prints too, in its own colour, where it went out.
    if (this.mode === "HELL") this.pushHell({ at: startedAt, freqHz, tx: true, px: hellPrint(text.replace(/ [halted]$/, "")) });
  }

  private pushHell(c: HellChunk): void {
    this.hellChunks.push(c);
    this.hellCols += c.px.length / HELL_ROWS;
    while (this.hellCols > KEEP_HELL_COLUMNS && this.hellChunks.length > 1) this.hellCols -= this.hellChunks.shift()!.px.length / HELL_ROWS;
    this.emit("hell", c);
  }

  /** The Hell tape so far, oldest first. */
  hellHistory(): HellChunk[] {
    return this.hellChunks;
  }

  clear(): void {
    this.lines = [];
    this.hellChunks = [];
    this.hellCols = 0;
    this.emit("clear");
    this.emit("state");
  }

  private push(line: KeyLine & { mode: KeyMode }): void {
    const i = this.lines.findIndex((l) => l.id === line.id);
    if (i >= 0) this.lines[i] = line;
    else {
      this.lines.push(line);
      if (this.lines.length > KEEP_LINES) this.lines.shift();
    }
    this.emit("line", line);
  }

  snapshot() {
    return { mode: this.mode, active: this.active, ctx: this.ctx, sending: this.sending, fkeys: [...this.fkeys()], fkeysCustom: !!(this.mode && this.customFkeys[this.mode]), heard: this.heard };
  }
}
