/**
 * The QSO sequencer: pure functions over an immutable state, no clock or I/O.
 *
 * It answers what it RECEIVED, not what role it started in (WSJT-X behaviour):
 *   their grid      → send report (Tx2)
 *   their report    → send R+report (Tx3)
 *   their R+report  → send RR73 (Tx4) and LOG
 *   their RR73/RRR  → send 73 once (Tx5) and LOG
 *   their 73        → done (LOG if we had sent R+report)
 *
 * Repeats count only transmissions that actually went out (`afterTx(sent=true)`); a
 * refused or late transmission does not burn the budget. A contact is logged exactly
 * once, at the moment both reports are known to have crossed.
 *
 * Hound (FT8 DXpedition mode, WSJT-X's HoundTransmissionPolicy): the Fox works many
 * Hounds at once, so its messages to others never end our contact; its report gets our
 * R+report on the Fox's own frequency, repeats move 300 Hz away from it, and its RR73
 * ends and logs the contact with no 73 sent. We give up after about 11 periods.
 *
 * Contests (WW Digi, ARRL Digi, Field Day, RTTY Roundup): the exchange replaces the
 * report. The first message already carries it (the grid in the Digi contests), their
 * exchange gets R and ours, their R and exchange gets RR73 and the log, and their RR73
 * ends it without a 73.
 */
import { contestMessages, isClosing, type Contest, type Parsed, type Payload } from "./message.ts";
import type { DigitalMode } from "./timing.ts";

export type Phase = "calling" | "report-sent" | "rreport-sent" | "rr73-sent" | "signing-off" | "done" | "abandoned";

export interface TranscriptLine {
  at: number;
  dir: "tx" | "rx";
  text: string;
  snr?: number;
}

export interface QsoState {
  id: string;
  me: string;
  myGrid4: string;
  them: string;
  theirGrid: string | null;
  mode: DigitalMode;
  ourParity: 0 | 1;
  txOffsetHz: number;
  theirOffsetHz: number;
  phase: Phase;
  /** The report we send them (their SNR at our end). */
  reportSent: number;
  reportRcvd: number | null;
  /** We have transmitted Tx2 or Tx3 (they may have our report). */
  sentOurReport: boolean;
  startedAt: number;
  lastHeardAt: number | null;
  logged: boolean;
  lastSent: string | null;
  repeats: number;
  maxRepeats: number;
  thirdPartyGrace: boolean;
  transcript: TranscriptLine[];
  reason: string | null;
  /** Special activity of the other station (POTA park). */
  sig: string | null;
  sigInfo: string | null;
  /** Who started it: the auto operator or a person. */
  origin: "auto" | "manual" | "answer";
  /** Working a DXpedition Fox as a Hound. */
  hound: boolean;
  /** Where the Fox sent us its report. */
  foxHz: number | null;
  contest: Contest;
  /** What we send as the exchange: "2A WI" on Field Day, "WI" or a serial in the Roundup. */
  myExch: string;
  theirExch: string | null;
}

export type QsoEvent =
  | { type: "log"; qso: QsoState }
  | { type: "abandon"; qso: QsoState; reason: string; incomplete: boolean }
  | { type: "done"; qso: QsoState };

export interface RxDecode {
  parsed: Parsed;
  text: string;
  snr: number;
  offsetHz: number;
  at: number;
}

export interface StartParams {
  id: string;
  me: string;
  myGrid4: string;
  them: string;
  theirGrid: string | null;
  theirSnr: number;
  theirOffsetHz: number;
  theirParity: 0 | 1;
  mode: DigitalMode;
  txOffsetHz: number;
  now: number;
  maxRepeats: number;
  origin: QsoState["origin"];
  sig?: string | null;
  sigInfo?: string | null;
  hound?: boolean;
  contest?: Contest;
  myExch?: string;
}

function base(p: StartParams, phase: Phase): QsoState {
  return {
    id: p.id,
    me: p.me,
    myGrid4: p.myGrid4,
    them: p.them,
    theirGrid: p.theirGrid,
    mode: p.mode,
    ourParity: (1 - p.theirParity) as 0 | 1,
    txOffsetHz: p.txOffsetHz,
    theirOffsetHz: p.theirOffsetHz,
    phase,
    reportSent: p.theirSnr,
    reportRcvd: null,
    sentOurReport: false,
    startedAt: p.now,
    lastHeardAt: null,
    logged: false,
    lastSent: null,
    repeats: 0,
    maxRepeats: p.maxRepeats,
    thirdPartyGrace: false,
    transcript: [],
    reason: null,
    sig: p.sig ?? null,
    sigInfo: p.sigInfo ?? null,
    origin: p.origin,
    hound: !!p.hound,
    foxHz: null,
    contest: p.contest ?? "none",
    myExch: p.myExch ?? "",
    theirExch: null,
  };
}

/** In the Digi contests the grid is the exchange. */
function contestPayload(s: QsoState, p: Payload): Payload {
  if (s.contest !== "ww-digi" && s.contest !== "arrl-digi") return p;
  if (p.kind === "grid") return { kind: "exch", text: p.grid };
  if (p.kind === "rgrid") return { kind: "rexch", text: p.grid };
  return p;
}

/** Hound repeats of R+report, about 11 periods of the Fox's timeout at one every other period. */
const HOUND_REPORT_REPEATS = 5;
/** A Hound may call for a long time in a pileup. */
const HOUND_CALLS = 30;

/** We call a station (answering their CQ): send Tx1. */
export function startCall(p: StartParams): QsoState {
  return base(p, "calling");
}

/**
 * A station called us (answering our CQ, or tail-ending). Feed it their first message;
 * the reply follows from what they sent.
 */
export function startAnswer(p: StartParams, first: RxDecode): { state: QsoState; events: QsoEvent[] } {
  const s = base(p, "calling");
  return receive(s, [first], first.at);
}

export function isActive(s: QsoState | null): s is QsoState {
  return !!s && s.phase !== "done" && s.phase !== "abandoned";
}

const TERMINAL: Phase[] = ["done", "abandoned"];

function finish(s: QsoState, phase: "done" | "abandoned", reason: string | null, events: QsoEvent[]): QsoState {
  const next = { ...s, phase, reason };
  if (phase === "abandoned") {
    events.push({ type: "abandon", qso: next, reason: reason ?? "abandoned", incomplete: !s.logged && s.sentOurReport && s.reportRcvd !== null });
  } else {
    events.push({ type: "done", qso: next });
  }
  return next;
}

function log(s: QsoState, events: QsoEvent[]): QsoState {
  if (s.logged) return s;
  const next = { ...s, logged: true };
  events.push({ type: "log", qso: next });
  return next;
}

/**
 * Absorb one receive window's decodes (from the window of THEIR parity).
 * `heardThem` is false when the window had nothing from them at all.
 */
export function receive(state: QsoState, decodes: RxDecode[], windowAt: number): { state: QsoState; events: QsoEvent[] } {
  const events: QsoEvent[] = [];
  let s = state;
  if (TERMINAL.includes(s.phase)) return { state: s, events };

  const fromThem = decodes.filter((d) => (d.parsed.kind === "directed" || d.parsed.kind === "cq") && d.parsed.from === s.them);
  if (fromThem.length === 0) {
    // They went quiet. After our RR73 that means they got it.
    if (s.phase === "rr73-sent" && s.lastSent) s = finish(s, "done", "they went quiet after our RR73", events);
    return { state: s, events };
  }

  const toUs = fromThem.filter((d) => d.parsed.kind === "directed" && d.parsed.to === s.me);
  const elsewhere = fromThem.filter((d) => d.parsed.kind === "directed" && d.parsed.to !== s.me);
  const cq = fromThem.find((d) => d.parsed.kind === "cq");

  s = {
    ...s,
    lastHeardAt: windowAt,
    transcript: [...s.transcript, ...fromThem.map((d) => ({ at: d.at, dir: "rx" as const, text: d.text, snr: d.snr }))].slice(-40),
  };
  if (cq?.parsed.kind === "cq" && cq.parsed.grid && !s.theirGrid) s = { ...s, theirGrid: cq.parsed.grid };

  if (toUs.length > 0) {
    // Take the most advanced message addressed to us.
    const rank = { none: 1, grid: 1, other: 0, report: 2, exch: 2, rreport: 3, rgrid: 3, rexch: 3, rrr: 4, rr73: 4, "73": 5 } as const;
    const best = toUs.reduce((a, b) => {
      const pa = (a.parsed as Extract<Parsed, { kind: "directed" }>).payload.kind;
      const pb = (b.parsed as Extract<Parsed, { kind: "directed" }>).payload.kind;
      return rank[pb] > rank[pa] ? b : a;
    });
    const p = contestPayload(s, (best.parsed as Extract<Parsed, { kind: "directed" }>).payload);
    const advanced = (phase: Phase) => (phase !== s.phase ? { repeats: 0 } : {});
    switch (p.kind) {
      case "grid":
      case "none":
        if (p.kind === "grid" && !s.theirGrid) s = { ...s, theirGrid: p.grid };
        if (s.phase === "calling" || s.phase === "report-sent") s = { ...s, ...advanced("report-sent"), phase: "report-sent" };
        break;
      case "report":
        s = { ...s, reportRcvd: p.db };
        if (s.hound && s.foxHz === null) s = { ...s, foxHz: best.offsetHz, txOffsetHz: best.offsetHz };
        if (s.phase === "calling" || s.phase === "report-sent") s = { ...s, ...advanced("rreport-sent"), phase: "rreport-sent" };
        break;
      case "rreport":
      case "rgrid":
        if (p.kind === "rreport") s = { ...s, reportRcvd: p.db };
        if (s.phase !== "signing-off") {
          s = { ...s, ...advanced("rr73-sent"), phase: "rr73-sent" };
          s = log(s, events);
        }
        break;
      case "exch":
        s = { ...s, theirExch: p.text, theirGrid: s.theirGrid ?? (s.contest.endsWith("digi") ? p.text : null) };
        if (s.phase === "calling" || s.phase === "report-sent") s = { ...s, ...advanced("rreport-sent"), phase: "rreport-sent" };
        break;
      case "rexch":
        s = { ...s, theirExch: p.text, theirGrid: s.theirGrid ?? (s.contest.endsWith("digi") ? p.text : null) };
        if (s.phase !== "signing-off") {
          s = { ...s, ...advanced("rr73-sent"), phase: "rr73-sent" };
          s = log(s, events);
        }
        break;
      case "rrr":
      case "rr73":
        if (s.contest !== "none" && s.theirExch !== null) {
          // A contest contact ends on their RR73; no 73.
          s = log(s, events);
          s = finish(s, "done", null, events);
          break;
        }
        if (s.hound && s.reportRcvd !== null) {
          // The Fox's RR73 is the end: log, and send nothing more.
          s = log(s, events);
          s = finish(s, "done", null, events);
          break;
        }
        if (s.reportRcvd === null && !s.sentOurReport) {
          s = finish(s, "abandoned", "they signed off before reports were exchanged", events);
          break;
        }
        s = log(s, events);
        if (s.phase !== "rr73-sent") s = { ...s, ...advanced("signing-off"), phase: "signing-off" };
        else s = finish(s, "done", null, events);
        break;
      case "73":
        if (s.phase === "rreport-sent" || s.phase === "signing-off") s = log(s, events);
        if (s.logged) s = finish(s, "done", null, events);
        break;
      case "other":
        break;
    }
    return { state: s, events };
  }

  // A Fox is always working other Hounds; that never ends our contact.
  if (elsewhere.length > 0 && !s.hound) {
    const d = elsewhere[0]!.parsed as Extract<Parsed, { kind: "directed" }>;
    if (s.phase === "rr73-sent" || s.phase === "signing-off") return { state: finish(s, "done", null, events), events };
    if (isClosing(d.payload) && s.phase === "calling" && !s.thirdPartyGrace) {
      // Finishing with someone else; give them one more cycle.
      return { state: { ...s, thirdPartyGrace: true }, events };
    }
    return { state: finish(s, "abandoned", `they are working ${d.to}`, events), events };
  }

  if (cq && (s.phase === "rr73-sent" || s.phase === "signing-off")) s = finish(s, "done", null, events);
  return { state: s, events };
}

/**
 * The message for our next transmission, or null when there is nothing to send. Gives up
 * (abandoned) when the same message has gone out `maxRepeats` times without progress.
 */
export function nextMessage(state: QsoState): { state: QsoState; message: string | null; events: QsoEvent[] } {
  const events: QsoEvent[] = [];
  let s = state;
  if (TERMINAL.includes(s.phase)) return { state: s, message: null, events };
  const m = contestMessages(s.me, s.them, s.myGrid4, s.reportSent, s.contest, s.myExch);
  // In a contest the first call already carries the exchange.
  const msg = { calling: s.contest === "none" ? m.tx1 : m.tx2, "report-sent": m.tx2, "rreport-sent": m.tx3, "rr73-sent": m.tx4, "signing-off": m.tx5 }[s.phase as Exclude<Phase, "done" | "abandoned">];

  if (s.lastSent === msg) {
    if (s.phase === "rr73-sent" && s.repeats >= Math.min(3, s.maxRepeats)) {
      return { state: finish(s, "done", "RR73 sent; they are still repeating", events), message: null, events };
    }
    if (s.phase === "signing-off" && s.repeats >= 1) return { state: finish(s, "done", null, events), message: null, events };
    const cap = s.hound ? (s.phase === "calling" ? Math.max(s.maxRepeats, HOUND_CALLS) : Math.min(s.maxRepeats, HOUND_REPORT_REPEATS)) : s.maxRepeats;
    if (s.repeats >= cap) {
      const reason = s.phase === "calling" ? `no answer after ${s.repeats} calls` : `no reply after ${s.repeats} repeats`;
      return { state: finish(s, "abandoned", reason, events), message: null, events };
    }
  }
  return { state: s, message: msg, events };
}

/** Record a transmission attempt. Only a transmission that went out counts. */
export function afterTx(state: QsoState, message: string, sent: boolean, at: number): QsoState {
  if (!sent) return state;
  const repeats = state.lastSent === message ? state.repeats + 1 : 1;
  const sentOurReport = state.sentOurReport || state.phase === "report-sent" || state.phase === "rreport-sent";
  let s: QsoState = {
    ...state,
    lastSent: message,
    repeats,
    sentOurReport,
    transcript: [...state.transcript, { at, dir: "tx" as const, text: message }].slice(-40),
  };
  // A Hound sends its first R+report on the Fox's frequency, then moves 300 Hz off it.
  if (s.hound && s.phase === "rreport-sent" && s.foxHz !== null) s = { ...s, txOffsetHz: s.foxHz <= 600 ? s.foxHz + 300 : s.foxHz - 300 };
  return s;
}

/** Operator or guard stops the contact. */
export function abandon(state: QsoState, reason: string): { state: QsoState; events: QsoEvent[] } {
  const events: QsoEvent[] = [];
  if (TERMINAL.includes(state.phase)) return { state, events };
  if (state.phase === "rr73-sent" || state.phase === "signing-off") return { state: finish(state, "done", reason, events), events };
  return { state: finish(state, "abandoned", reason, events), events };
}

export function transcriptText(s: QsoState): string {
  return s.transcript
    .map((l) => `${new Date(l.at).toISOString().slice(11, 19)} ${l.dir === "tx" ? "TX" : "RX"} ${l.snr !== undefined ? String(l.snr).padStart(3) : "   "}  ${l.text}`)
    .join("\n");
}
