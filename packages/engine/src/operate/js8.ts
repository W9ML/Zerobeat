/**
 * The JS8 desk: JS8Call's keyboard network on the station. Periods are slotted like FT8
 * (15 s for Normal, 10 Fast, 6 Turbo, 30 Slow); each period's audio is decoded on the aux
 * thread, frames at the same offset in consecutive periods are joined into messages
 * (the first and last frames say where a message starts and ends), and a message sent
 * here goes out one frame per period.
 *
 * What JS8Call does for a station, done here the same way when auto-reply is on:
 * answers SNR?, GRID?, INFO?, STATUS?, HEARING?, QUERY MSGS and QUERY MSG n, stores a
 * MSG for us and a MSG TO: for someone else (store and forward) with an ACK, repeats on
 * AGN?, and acknowledges heartbeats when asked to. Heartbeats go out in the 500-1000 Hz
 * heartbeat sub-band. Keying stays with the station.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import type { AuxDecoder } from "../digital/aux-decoder.ts";
import { encodeJs8, js8Waveform, type Js8Decode } from "../digital/js8/modem.ts";
import { JS8_SUBMODES, type Js8Submode } from "../digital/js8/params.ts";
import { buildMessageFramesWithInfo, checkBufferedMessage, formatSNR, unpackFrame, type DecodedFrame, type TxFrame } from "../digital/js8/varicode.ts";

const RATE = 12_000;
const SAME_SIGNAL_HZ = 10;

export interface Js8Message {
  id: string;
  freqHz: number;
  startMs: number;
  updatedMs: number;
  snr: number;
  /** As JS8Call shows it: the frames' text joined; complete ones end with ♢. */
  text: string;
  complete: boolean;
  from: string | null;
  to: string | null;
  cmd: string | null;
  num: string | null;
  grid: string | null;
  heartbeat: boolean;
  dir: "rx" | "tx";
  /** Directed to us, or to a group we are in. */
  toUs: boolean;
}

export interface Js8Heard {
  call: string;
  snr: number;
  freqHz: number;
  grid: string | null;
  at: number;
}

export interface Js8Stored {
  id: number;
  at: number;
  from: string;
  /** Who it is for: us, or a station we hold it for. */
  to: string;
  text: string;
  delivered: boolean;
  /** When it was sent to its addressee, waiting for their ACK. */
  sentAt?: number;
}

export interface Js8Config {
  call: string;
  grid: string;
  submode: Js8Submode;
  autoReply: boolean;
  hbAck: boolean;
  hbMinutes: number;
  info: string;
  status: string;
  /** Groups we answer as well as our call (always @ALLCALL). */
  groups: string[];
  txOffsetHz: number;
}

type Events = { state: []; message: [Js8Message] };

interface Open {
  msg: Js8Message;
  lastPeriod: number;
  frames: DecodedFrame[];
}

export class Js8Desk extends EventEmitter<Events> {
  active = false;
  messages: Js8Message[] = [];
  heard = new Map<string, Js8Heard>();
  inbox: Js8Stored[] = [];
  /** What is going out: the text, its frames and how many have been sent. */
  sending: { text: string; frames: TxFrame[]; sent: number; offsetHz: number; startedAt: number; auto: boolean } | null = null;
  lastDecode: { at: number; count: number; ms: number; error?: string } | null = null;
  private queue: { text: string; offsetHz?: number; auto: boolean }[] = [];
  private lastSentText: string | null = null;
  private open: Open[] = [];
  private period: { index: number; start: number; buf: Float32Array; n: number; tx: boolean } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private hbTimer: NodeJS.Timeout | null = null;
  /** Timed heartbeats wait for a person to press HB once after each start: a restart
   *  with nobody at the radio must not resume a beacon by itself. */
  private hbArmed = false;
  private seq = 0;
  private readonly file: string;

  constructor(
    private readonly aux: AuxDecoder,
    dataDir: string,
    private readonly config: () => Js8Config,
    /** The station keys the radio for one frame; resolves when it is over. */
    private readonly transmit: (samples: Float32Array, startAt: number, label: string, auto: boolean) => Promise<boolean>,
    private readonly log: (level: "info" | "warn", msg: string) => void,
  ) {
    super();
    this.file = path.join(dataDir, "js8", "inbox.json");
    try {
      this.inbox = JSON.parse(fs.readFileSync(this.file, "utf8")) as Js8Stored[];
    } catch {
      this.inbox = [];
    }
  }

  private get params() {
    return JS8_SUBMODES[this.config().submode];
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.hbArmed = false;
    this.schedule();
    this.armHeartbeat();
    this.emit("state");
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.hbTimer) clearTimeout(this.hbTimer);
    this.timer = null;
    this.hbTimer = null;
    this.period = null;
    this.sending = null;
    this.queue = [];
    this.emit("state");
  }

  feed(x: Float32Array, firstMs: number): void {
    const p = this.period;
    if (!p || p.tx) return;
    const at = Math.round(((firstMs - p.start) / 1000) * RATE);
    for (let i = 0; i < x.length; i++) {
      const j = at + i;
      if (j >= 0 && j < p.buf.length) p.buf[j] = x[i]!;
    }
    p.n = Math.max(p.n, at + x.length);
  }

  // ------------------------------------------------------------------ periods

  private schedule(): void {
    if (!this.active) return;
    const P = this.params.periodSec * 1000;
    const now = Date.now();
    const index = Math.ceil((now + 50) / P);
    const start = index * P;
    // Wake a little early when a frame has to go out, so keying is on time.
    const lead = this.sending || this.queue.length ? 400 : 0;
    this.timer = setTimeout(() => void this.periodStart(index, start), Math.max(0, start - lead - now));
  }

  private async periodStart(index: number, start: number): Promise<void> {
    if (!this.active) return;
    const params = this.params;
    if (!this.sending && this.queue.length) this.beginSending();
    const tx = !!this.sending;
    this.period = { index, start, buf: new Float32Array(params.samplesNeeded), n: 0, tx };
    this.schedule();
    if (tx) {
      await this.sendNextFrame(start);
      return;
    }
    const p = this.period;
    setTimeout(() => void this.decode(p), Math.max(0, start + (params.samplesNeeded / RATE) * 1000 + 300 - Date.now()));
  }

  private async decode(p: { index: number; start: number; buf: Float32Array; n: number }): Promise<void> {
    if (!this.active) return;
    if (p.n < p.buf.length * 0.8) {
      this.lastDecode = { at: p.start, count: 0, ms: 0, error: "not enough receive audio in that period" };
      this.emit("state");
      return;
    }
    const c = this.config();
    const r = await this.aux.decode({ kind: "js8", samples: p.buf, submode: c.submode, nfqsoHz: c.txOffsetHz });
    const decodes = (r.decodes ?? []) as Js8Decode[];
    this.lastDecode = { at: p.start, count: decodes.length, ms: r.ms, error: r.error };
    for (const d of decodes) this.frame(d, p.index, p.start);
    // Messages that stopped arriving are finished (perhaps without their last frame).
    for (const o of this.open.splice(0)) {
      if (p.index - o.lastPeriod <= 2 && !o.msg.complete) this.open.push(o);
    }
    this.emit("state");
  }

  /** One decoded frame: into the message at its offset, or a new one. */
  private frame(dec: Js8Decode, periodIndex: number, periodStart: number): void {
    const d = { ...dec, snrDb: Math.round(dec.snrDb) };
    const c = this.config();
    const f = unpackFrame(d.message12, d.i3, JS8_SUBMODES[c.submode].submodeId);
    const at = periodStart + JS8_SUBMODES[c.submode].startDelayMs + d.dtSec * 1000;
    let o = this.open.find((x) => Math.abs(x.msg.freqHz - d.freqHz) <= SAME_SIGNAL_HZ && periodIndex - x.lastPeriod <= 2 && !x.msg.complete);
    if (o && f.isFirst) {
      // A new message at the same offset ends the old one.
      this.open.splice(this.open.indexOf(o), 1);
      o = undefined;
    }
    if (!o) {
      o = {
        msg: { id: `js8-${++this.seq}`, freqHz: Math.round(d.freqHz), startMs: at, updatedMs: at, snr: d.snrDb, text: "", complete: false, from: null, to: null, cmd: null, num: null, grid: null, heartbeat: false, dir: "rx", toUs: false },
        lastPeriod: periodIndex,
        frames: [],
      };
      this.open.push(o);
    }
    o.frames.push(f);
    o.lastPeriod = periodIndex;
    const m = o.msg;
    m.updatedMs = at;
    m.snr = Math.max(m.snr, d.snrDb);
    if (o.frames.length === 1 || f.isFirst) {
      m.from = f.from && f.from !== "<....>" ? f.from : m.from;
      m.to = f.to ?? m.to;
      m.cmd = f.cmd ?? m.cmd;
      m.num = f.num ?? m.num;
      m.grid = f.grid ?? m.grid;
      m.heartbeat = f.isHeartbeat;
    } else if (f.to && !m.to && o.frames.length === 2) {
      // A compound call (N3CHX/P1) sends its call in the first frame and the directed
      // part (to, command) in the second, as JS8Call's compound-directed frame.
      m.to = f.to;
      m.cmd = f.cmd ?? m.cmd;
      m.num = f.num ?? m.num;
    }
    m.text = o.frames.map((x) => x.message).join("");
    if (f.isLast) {
      m.complete = true;
      m.text = m.text.trimEnd() + " ♢";
    }
    m.toUs = !!m.to && (m.to === c.call || m.to === "@ALLCALL" || c.groups.includes(m.to));
    if (m.from && m.from !== c.call) this.heard.set(m.from, { call: m.from, snr: d.snrDb, freqHz: Math.round(d.freqHz), grid: m.grid ?? this.heard.get(m.from)?.grid ?? null, at });
    this.push(m);
    if (m.complete) this.handle(o);
  }

  private push(m: Js8Message): void {
    const i = this.messages.findIndex((x) => x.id === m.id);
    if (i >= 0) this.messages[i] = { ...m };
    else {
      this.messages.push({ ...m });
      if (this.messages.length > 400) this.messages.shift();
    }
    this.emit("message", { ...m });
  }

  // ------------------------------------------------------------------ replies

  /** A complete message: answer it when it is for us and auto-reply is on. */
  private handle(o: Open): void {
    const c = this.config();
    const m = o.msg;
    if (!m.from || m.from === c.call) return;
    const them = m.from;
    // Heartbeats: acknowledge when asked to (JS8Call's "send heartbeat acknowledgements").
    if (m.heartbeat) {
      if (c.autoReply && c.hbAck && m.to === "@HB") this.reply(`${them} HEARTBEAT SNR ${formatSNR(m.snr)}`);
      return;
    }
    if (!m.toUs || !m.cmd) return;
    const cmd = m.cmd;
    // An ACK from a station we handed a held message to: now it is delivered.
    if (cmd === " ACK" && m.to === c.call) {
      const held = this.inbox.find((x) => x.to === them && x.sentAt && !x.delivered);
      if (held) {
        held.delivered = true;
        this.save();
        this.log("info", `JS8: ${them} acknowledged message ${held.id}`);
        this.emit("state");
      }
      return;
    }
    // Automatic answers go to stations that asked us or one of our groups by name, never
    // to @ALLCALL: there every station on AUTO would answer in the same period, on top
    // of each other. JS8Call does the same.
    const direct = m.to === c.call || c.groups.includes(m.to ?? "");
    // The frame holding the command: the first, or the second after a compound call's.
    const at = Math.max(0, o.frames.findIndex((f) => f.cmd === cmd));
    const payload = o.frames
      .slice(at + 1)
      .map((f) => f.message)
      .join("");
    // MSG and MSG TO: carry a checksum at the end of the text.
    if (cmd === " MSG" || cmd === " MSG TO:") {
      // Store and acknowledge only what is addressed to our call: a group or @ALLCALL
      // message would otherwise be ACKed by every member at once.
      if (m.to !== c.call) return;
      const body = (o.frames[at]!.message.split(cmd).slice(1).join(cmd) + payload).replace(/♢$/, "");
      const chk = checkBufferedMessage(cmd, body);
      if (!chk.valid) {
        this.log("warn", `JS8: message from ${them} failed its checksum; not stored`);
        return;
      }
      let to = c.call;
      let text = chk.message.trim();
      if (cmd === " MSG TO:") {
        const sp = text.indexOf(" ");
        to = (sp > 0 ? text.slice(0, sp) : text).toUpperCase();
        text = sp > 0 ? text.slice(sp + 1).trim() : "";
      }
      this.store(them, to, text);
      if (c.autoReply) this.reply(`${them} ACK`);
      return;
    }
    if (!c.autoReply || !direct) return;
    if (cmd === " SNR?" || cmd === "?") this.reply(`${them} SNR ${formatSNR(m.snr)}`);
    else if (cmd === " GRID?") this.reply(`${them} GRID ${c.grid}`);
    else if (cmd === " INFO?") {
      if (c.info) this.reply(`${them} INFO ${c.info}`);
    } else if (cmd === " STATUS?") {
      if (c.status) this.reply(`${them} STATUS ${c.status}`);
    }
    else if (cmd === " HEARING?") {
      const calls = [...this.heard.values()].filter((h) => h.call !== them && Date.now() - h.at < 30 * 60_000).sort((a, b) => b.at - a.at).slice(0, 4).map((h) => h.call);
      this.reply(calls.length ? `${them} HEARING ${calls.join(" ")}` : `${them} NO`);
    } else if (cmd === " QUERY MSGS" || cmd === " QUERY MSGS?") {
      const mine = this.inbox.filter((x) => x.to === them && !x.delivered);
      this.reply(mine.length ? `${them} YES MSG ID ${mine[0]!.id}` : `${them} NO`);
    } else if (cmd === " QUERY") {
      const id = /MSG\s+(\d+)/.exec(payload)?.[1];
      const msg = id ? this.inbox.find((x) => x.id === Number(id) && x.to === them) : undefined;
      if (msg) {
        this.reply(`${them} MSG ${msg.text} DE ${msg.from}`);
        msg.sentAt = Date.now();
        this.save();
      } else this.reply(`${them} NO`);
    } else if (cmd === " AGN?" && this.lastSentText) this.reply(this.lastSentText);
  }

  /** An automatic reply: queued as automatic, so the station's automatic checks apply. */
  private reply(text: string): void {
    this.enqueue(text, undefined, true);
  }

  private store(from: string, to: string, text: string): void {
    const id = (this.inbox.at(-1)?.id ?? 0) + 1;
    this.inbox.push({ id, at: Date.now(), from, to, text, delivered: false });
    if (this.inbox.length > 500) this.inbox.shift();
    this.save();
    this.log("info", to === this.config().call ? `JS8: message from ${from} stored in the inbox` : `JS8: holding a message from ${from} for ${to}`);
    this.emit("state");
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.inbox));
    } catch (e) {
      this.log("warn", `JS8 inbox: ${(e as Error).message}`);
    }
  }

  deleteStored(id: number): void {
    this.inbox = this.inbox.filter((x) => x.id !== id);
    this.save();
    this.emit("state");
  }

  // ------------------------------------------------------------------ sending

  /** Put a message in line to go out. Returns why not, or null. */
  enqueue(text: string, offsetHz?: number, auto = false): string | null {
    const c = this.config();
    const { frames, info } = buildMessageFramesWithInfo(c.call, c.grid, "", text.toUpperCase().trim(), true, false, JS8_SUBMODES[c.submode].submodeId);
    if (!frames.length) return "nothing JS8 can send in that";
    if (info.unencoded) return `JS8 cannot send "${info.unencoded.slice(0, 20)}"`;
    if (this.queue.length > 6) return "too many messages waiting; halt or wait";
    this.queue.push({ text: text.toUpperCase().trim(), offsetHz, auto });
    this.emit("state");
    return null;
  }

  halt(): void {
    this.queue = [];
    this.sending = null;
    this.emit("state");
  }

  private beginSending(): void {
    const q = this.queue.shift()!;
    const c = this.config();
    // forceIdentify: bare text goes out as "MYCALL: text", so every transmission carries
    // our call (the composer promised this; the old code sent anonymous data frames).
    const { frames } = buildMessageFramesWithInfo(c.call, c.grid, "", q.text, true, false, JS8_SUBMODES[c.submode].submodeId);
    this.sending = { text: q.text, frames, sent: 0, offsetHz: q.offsetHz ?? c.txOffsetHz, startedAt: Date.now(), auto: q.auto };
  }

  private async sendNextFrame(periodStart: number): Promise<void> {
    const s = this.sending;
    if (!s) return;
    const c = this.config();
    const params = JS8_SUBMODES[c.submode];
    const fr = s.frames[s.sent]!;
    const tones = encodeJs8(fr.frame, fr.i3, c.submode);
    const samples = js8Waveform(tones, s.offsetHz, 24_000, c.submode);
    const ok = await this.transmit(samples, periodStart + params.startDelayMs, `JS8 ${s.text}${s.frames.length > 1 ? ` (${s.sent + 1}/${s.frames.length})` : ""}`, s.auto);
    if (this.sending !== s) return; // halted meanwhile
    if (!ok) {
      this.log("warn", "JS8: a frame did not go out; message stopped");
      this.sending = null;
      this.emit("state");
      return;
    }
    s.sent++;
    if (s.sent >= s.frames.length) {
      this.lastSentText = s.text;
      const m: Js8Message = { id: `js8-tx-${++this.seq}`, freqHz: s.offsetHz, startMs: s.startedAt, updatedMs: Date.now(), snr: 0, text: `${c.call}: ${s.text} ♢`, complete: true, from: c.call, to: null, cmd: null, num: null, grid: null, heartbeat: false, dir: "tx", toUs: false };
      this.push(m);
      this.sending = null;
    }
    this.emit("state");
  }

  /** A heartbeat now, in the heartbeat sub-band. */
  heartbeat(auto = false): string | null {
    if (!auto) this.hbArmed = true;
    const c = this.config();
    return this.enqueue(`@HB HEARTBEAT ${c.grid.slice(0, 4)}`, 500 + Math.floor(Math.random() * 450), auto);
  }

  private armHeartbeat(): void {
    if (this.hbTimer) clearTimeout(this.hbTimer);
    if (!this.active) return;
    // Re-read the interval each minute, so a change in Settings takes effect without a restart.
    const armed = this.config().hbMinutes;
    const due = Date.now() + armed * 60_000;
    const tick = () => {
      if (!this.active) return;
      const mins = this.config().hbMinutes;
      if (mins !== armed) return this.armHeartbeat(); // changed: start the interval from now
      if (mins && Date.now() >= due) {
        if (this.hbArmed && !this.sending && !this.queue.length) this.heartbeat(true);
        return this.armHeartbeat();
      }
      this.hbTimer = setTimeout(tick, mins ? Math.max(1000, Math.min(60_000, due - Date.now())) : 60_000);
    };
    this.hbTimer = setTimeout(tick, 60_000);
  }

  snapshot() {
    const c = this.config();
    return {
      active: this.active,
      submode: c.submode,
      sending: this.sending ? { text: this.sending.text, frames: this.sending.frames.length, sent: this.sending.sent } : null,
      queued: this.queue.map((q) => q.text),
      lastDecode: this.lastDecode,
      autoReply: c.autoReply,
      heard: [...this.heard.values()].sort((a, b) => b.at - a.at).slice(0, 40),
      inbox: this.inbox.slice(-50).reverse(),
    };
  }
}
