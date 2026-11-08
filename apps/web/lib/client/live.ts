"use client";
/**
 * The live feed from the engine. One WebSocket per tab, held in a module-level store and
 * read with useSyncExternalStore, so every component sees the same state and a page
 * change does not reconnect. Waterfall rows go to listeners directly, never through
 * React state.
 */
import { useSyncExternalStore } from "react";

export interface SlimDecode {
  w: number;
  at: number;
  mode: "FT8" | "FT4" | "FT2";
  f: number;
  snr: number;
  dt: number;
  text: string;
  from: string | null;
  kind: "cq" | "to-me" | "from-me" | "qso" | "text";
  grid: string | null;
  mod: string | null;
  /** The sender's DXCC entity, and the distance when they sent a grid. */
  country?: string | null;
  km?: number | null;
  ap: boolean;
  worth: { points: number; reasons: string[] } | null;
  /** In a contest: a dupe on this band, or a new multiplier. */
  contest?: { dupe: boolean; mult: boolean };
}

export interface ContestDeskState {
  name: string;
  note: string | null;
  since: number;
  qsos: number;
  dupes: number;
  points: number;
  mults: number;
  multsPer: "band" | "once" | null;
  score: number;
  rate10: number;
  rate60: number;
  byBand: { band: string; qsos: number; points: number; mults: number }[];
  serial: number;
  usesSerial: boolean;
  fdPower: 1 | 2 | 5;
  cabrillo: string;
  currentCall: string | null;
  current: { dupe: boolean; newMults: string[]; workedOn: string[] } | null;
}

export type KeyMode = "JTTY" | "RTTY" | "PSK31" | "CW" | "HELL";
/** A stretch of radio time an operator booked (see /bookings). */
export interface RadioBooking {
  id: string;
  userId: string;
  name: string;
  callsign: string | null;
  startsAt: number;
  endsAt: number;
  note: string;
}

export type HellSpeed = "feld" | "slow" | "x5" | "x9" | "fsk105" | "fsk245" | "hell80";

/** Hell columns: `px` holds 14 bytes a column, bottom pixel first, 0 blank to 255 full ink. */
export interface HellChunk {
  at: number;
  freqHz: number;
  tx: boolean;
  px: Uint8Array;
}

/** A keyboard-mode transmission, ours or heard; received ones grow as they arrive. */
export interface KeyLine {
  mode: KeyMode;
  id: string;
  dir: "rx" | "tx";
  startMs: number;
  updatedMs: number;
  freqHz: number;
  snr: number | null;
  text: string;
  complete: boolean;
  atRx: boolean;
}

export type KeyProfile = "unknown" | "field-day" | "rtty-roundup";

export interface ActivityLine {
  at: number;
  level: "info" | "warn" | "tx" | "log" | "state";
  text: string;
}

export interface EngineSnapshot {
  station: { callsign: string; grid: string } | null;
  distanceUnit?: "mi" | "km";
  udpFeed?: { on: boolean; name: string; targets: string } | null;
  radio: {
    link: "stopped" | "discovering" | "connecting" | "connected" | "waiting";
    detail: string;
    model: string | null;
    nickname: string | null;
    version: string | null;
    host: string | null;
    sliceIndex: number | null;
    sliceMode: string | null;
    rxAnt: string | null;
    txAnt: string | null;
    antennas: string[];
    txAntennas: string[];
    rfPowerPct: number;
    atu: boolean;
    telemetry: { fwdW: number | null; swr: number | null; paTempC: number | null; supplyV: number | null; sLevelDbm: number | null; at: number } | null;
    transmitting: boolean;
    audioAgeMs: number | null;
    /** How far the newest waterfall row is behind the clock: audio path and FFT. */
    waterfallLagMs?: number | null;
    type?: "flex" | "icom" | "hamlib";
    /** The user who last operated, and a control operator who took control. */
    holder?: RadioPerson | null;
    /** Someone asked the holder for the radio; it is theirs at `until` unless kept. */
    radioRequest?: { userId: string; name: string; callsign: string | null; until: number } | null;
    /** Radio time: the booking on now (holding: its operator is signed in, so the radio is theirs) and the next. */
    booking?: { current: RadioBooking | null; next: RadioBooking | null; holding: boolean };
    controlOp?: RadioPerson | null;
    /** The US class whose privileges apply (the higher of the two), or null: not checked. */
    licenseClass?: "T" | "G" | "A" | "E" | null;
    /** Per band of the current mode: may the license that applies transmit there. */
    privilegeBands?: Record<string, boolean> | null;
    /** Why transmitting here is outside those privileges, or null. */
    privilegeBlock?: string | null;
    /** By mode: the bands it has a frequency on, in the band plan in use, low to high. */
    bands?: Record<string, string[]>;
    /** Where the dial is, in a freely tuned mode: the band button's built-in frequency and the operator's own. */
    bandFreq?: { band: string; mode: string; builtIn: number | null; mine: number | null } | null;
    bandPlan?: "us" | "r1" | "r2" | "r3";
    /** A narrower legal power limit where the dial is (US 60 m), or null. */
    powerNote?: string | null;
    /** Band memory for this UTC hour in the current FT mode: stations a window usually holds. */
    bandYield?: Record<string, { avg: number; samples: number; best: number | null }> | null;
  };
  dialHz: number;
  band: string | null;
  /** The engine's clock when this snapshot was made, epoch ms. */
  now?: number;
  mode: "FT8" | "FT4" | "FT2" | KeyMode | "SSTV" | "WSPR" | "JS8";
  slottedMode: "FT8" | "FT4" | "FT2";
  js8: {
    active: boolean;
    submode: "normal" | "fast" | "turbo" | "slow";
    sending: { text: string; frames: number; sent: number } | null;
    queued: string[];
    lastDecode: { at: number; count: number; ms: number; error?: string } | null;
    autoReply: boolean;
    heard: { call: string; snr: number; freqHz: number; grid: string | null; at: number }[];
    inbox: { id: number; at: number; from: string; to: string; text: string; delivered: boolean }[];
  };
  wspr: {
    active: boolean;
    nextTx: number | null;
    transmittingPeriod: number | null;
    lastDecode: { at: number; count: number; ms: number; error?: string } | null;
  };
  sstv: {
    active: boolean;
    receiving: { mode: string; modeName: string; line: number; of: number; since: number } | null;
    sending: { mode: string; startedAt: number; durationMs: number } | null;
    modes: { id: string; name: string; width: number; height: number }[];
  };
  keyboard: {
    mode: KeyMode | null;
    active: boolean;
    ctx: { hisCall: string; queueCall: string; exchange: string; profile: KeyProfile; serial: number; wpm: number; serialOn?: boolean; hellSpeed?: HellSpeed; hellReverse?: boolean };
    sending: { text: string; frames: number; startedAt: number; durationMs: number } | null;
    fkeys: string[];
    /** True when the operator edited this mode's keys. */
    fkeysCustom?: boolean;
    heard: number;
  };
  txOffsetHz: number;
  tx: { allowed: boolean; blocked: string | null; last: { at: number; message: string; ok: boolean; detail: string; fwdW: number | null; swr: number | null } | null; nextAt: number | null };
  ft0: boolean;
  auto: {
    mode: "off" | "cq" | "hunt" | "hunt-pota" | "pota-chase";
    source: string;
    paused: { cause: string; reason: string; at: number } | null;
    runStartedAt: number | null;
    qsosThisRun: number;
    unansweredCqs: number;
    cqParity: 0 | 1 | null;
    cqSlot: 0 | 1 | null;
    huntSlot?: 0 | 1 | null;
    hound: boolean;
    contest: {
      id: "none" | "ww-digi" | "arrl-digi" | "field-day" | "rtty-roundup";
      exchange: string;
      serial: number;
      since: number;
      fdPower: 1 | 2 | 5;
      sending: string;
      problem: string | null;
      desk: ContestDeskState | null;
    };
    runId: string | null;
    paResting: boolean;
    chase: { activator: string; park: string; since: number } | null;
    candidates: { callsign: string; points: number; reasons: string[] }[];
  };
  qso: {
    id: string;
    them: string;
    grid: string | null;
    phase: string;
    reportSent: string;
    reportRcvd: string | null;
    txOffsetHz: number;
    ourParity: 0 | 1;
    repeats: number;
    maxRepeats: number;
    logged: boolean;
    reason: string | null;
    park: string | null;
    hound: boolean;
    contest: string;
    exchSent: string;
    exchRcvd: string | null;
    /** live: our message going out right now (it joins the transcript for good when it ends). */
    transcript: { at: number; dir: "tx" | "rx"; text: string; snr?: number; live?: boolean }[];
  } | null;
  callers: { callsign: string; snr: number; offsetHz: number; text: string; windowIndex: number; at: number }[];
  lastWindow: { index: number; decodes: number; decodeMs: number; skipped: string | null; at: number } | null;
}

export interface WindowInfo {
  index: number;
  mode: string;
  start: number;
  decodeMs: number;
  skipped: string | null;
  ownTx: boolean;
  count: number;
}

/** A JS8 message, assembled from its frames as they arrive. */
export interface Js8Message {
  id: string;
  freqHz: number;
  startMs: number;
  updatedMs: number;
  snr: number;
  text: string;
  complete: boolean;
  from: string | null;
  to: string | null;
  cmd: string | null;
  num: string | null;
  grid: string | null;
  heartbeat: boolean;
  dir: "rx" | "tx";
  toUs: boolean;
}

/** A WSPR station heard in a period. */
export interface WsprSpot {
  at: number;
  message: string;
  callsign: string | null;
  grid: string | null;
  dbm: number;
  freqHz: number;
  dtSec: number;
  driftHz: number;
  snrDb: number;
  dialHz: number;
  uploaded: boolean | null;
}

/** An SSTV picture in the gallery. */
export interface SstvPicture {
  file: string;
  mode: string;
  modeName: string;
  at: number;
  width: number;
  height: number;
  lines: number;
  complete: boolean;
  slantPpm: number;
  dialHz: number | null;
  dir: "rx" | "tx";
}

/** A DX cluster or Reverse Beacon Network spot. */
export interface Spot {
  at: number;
  freqHz: number;
  call: string;
  spotter: string;
  comment: string;
  mode: string | null;
  snr: number | null;
  wpm: number | null;
  grid: string | null;
  source: "cluster" | "rbn";
}

export interface RadioPerson {
  userId: string;
  name: string;
  callsign: string | null;
  licenseClass: "T" | "G" | "A" | "E" | null;
}

export interface NeededAlert {
  callsign: string;
  band: string;
  mode: string;
  /** From a spot: where to tune. */
  spotHz?: number;
  snr: number;
  offsetHz: number;
  windowIndex: number;
  text: string;
  grid: string | null;
  reasons: string[];
  headline: string;
  at: number;
}

interface LiveState {
  status: "connecting" | "open" | "closed" | "engine-down";
  error: string | null;
  snap: EngineSnapshot | null;
  decodes: SlimDecode[];
  windows: WindowInfo[];
  activity: ActivityLine[];
  needed: NeededAlert[];
  keyLines: KeyLine[];
  /** Spots that arrived since this tab connected (the Spots card loads the rest). */
  spots: Spot[];
  /** SSTV pictures that arrived since this tab connected (the panel loads the rest). */
  sstvPictures: SstvPicture[];
  wsprSpots: WsprSpot[];
  js8Messages: Js8Message[];
}

type LiveEvent = { t: "needed"; alert: NeededAlert } | { t: "fault"; reason: string };
const eventListeners = new Set<(e: LiveEvent) => void>();

/** Subscribe to one-off events (alerts, faults). Returns an unsubscribe function. */
export function onLiveEvent(fn: (e: LiveEvent) => void): () => void {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

let state: LiveState = { status: "connecting", error: null, snap: null, decodes: [], windows: [], activity: [], needed: [], keyLines: [], spots: [], sstvPictures: [], wsprSpots: [], js8Messages: [] };
const listeners = new Set<() => void>();
const rowListeners = new Set<(row: WaterfallRow) => void>();
let ws: WebSocket | null = null;
let started = false;
let retry = 0;

/** Decodes from windows before this were cleared by the operator (this browser only). */
const CLEARED_KEY = "ds.decodesClearedAt";
let clearedAt = (() => {
  try {
    return Number(localStorage.getItem(CLEARED_KEY)) || 0;
  } catch {
    return 0;
  }
})();

/** Empty the decode list. New windows keep arriving; a reload does not bring old ones back. */
export function clearDecodes(): void {
  clearedAt = Date.now();
  try {
    localStorage.setItem(CLEARED_KEY, String(clearedAt));
  } catch {
    /* private window: cleared until reload */
  }
  set({ decodes: [] });
}

function set(patch: Partial<LiveState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

async function connect() {
  set({ status: "connecting" });
  let info: { ticket: string; url: string | null };
  try {
    const r = await fetch("/api/engine/ticket", { cache: "no-store" });
    if (r.status === 401) {
      set({ status: "closed", error: "signed out" });
      return;
    }
    info = await r.json();
  } catch {
    return scheduleReconnect("could not reach the web server");
  }
  const base = info.url ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  const sock = new WebSocket(`${base}?ticket=${encodeURIComponent(info.ticket)}`);
  sock.binaryType = "arraybuffer";
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    set({ status: "open", error: null });
  };
  sock.onmessage = (ev) => {
    if (typeof ev.data !== "string") {
      const b = new Uint8Array(ev.data as ArrayBuffer);
      if (b[0] === 2 || b[0] === 3 || b[0] === 4 || b[0] === 5) {
        // 4 and 5 carry when the audio was on the air, on the engine's clock: cycle lines drawn
        // from it match the slot clock, whatever this browser's clock says.
        const timed = b[0] >= 4;
        const at = timed ? new DataView(b.buffer, b.byteOffset + 2, 8).getFloat64(0, true) : Date.now();
        const row: WaterfallRow = { data: b.slice(timed ? 10 : 2), rate: b[1] || 20, at, tx: b[0] === 3 || b[0] === 5 };
        wfHistory.push(row);
        if (wfHistory.length > WF_KEEP) wfHistory.shift();
        for (const l of rowListeners) l(row);
      }
      return;
    }
    const m = JSON.parse(ev.data);
    if (m.t === "hello") {
      hellTapeData.length = 0;
      for (const c of (m.hell ?? []) as HellWire[]) hellTapeData.push(fromWire(c));
      for (const l of hellListeners) l(null);
      setHellSeen((m.hellSeen as HellSeen | null | undefined) ?? null);
    }
    if (m.t === "hello") set({ snap: m.state, decodes: (m.decodes as SlimDecode[]).filter((d) => d.at >= clearedAt), activity: m.activity, keyLines: m.keyLines ?? [] });
    else if (m.t === "key-clear") {
      hellTapeData.length = 0;
      for (const l of hellListeners) l(null);
      set({ keyLines: [] });
    } else if (m.t === "hell-seen") setHellSeen(m.seen as HellSeen);
    else if (m.t === "hell") {
      const c = fromWire(m.chunk as HellWire);
      hellTapeData.push(c);
      while (hellTapeData.length > 4000) hellTapeData.shift();
      for (const l of hellListeners) l(c);
    }
    else if (m.t === "spot") set({ spots: [...state.spots.slice(-399), m.spot as Spot] });
    else if (m.t === "js8") {
      const msg = m.message as Js8Message;
      set({ js8Messages: [...state.js8Messages.filter((x) => x.id !== msg.id), msg].slice(-400) });
    } else if (m.t === "wspr") set({ wsprSpots: [...state.wsprSpots, ...(m.spots as WsprSpot[])].slice(-500) });
    else if (m.t === "sstv-picture") set({ sstvPictures: [m.picture as SstvPicture, ...state.sstvPictures].slice(0, 100) });
    else if (m.t === "key") {
      const line = m.line as KeyLine;
      const i = state.keyLines.findIndex((l) => l.id === line.id);
      set({ keyLines: i >= 0 ? state.keyLines.map((l, j) => (j === i ? line : l)) : [...state.keyLines.slice(-299), line] });
    }
    else if (m.t === "state") set({ snap: m.state });
    else if (m.t === "activity") set({ activity: [...state.activity.slice(-199), m.line] });
    else if (m.t === "needed") {
      set({ needed: [m.alert, ...state.needed.filter((n) => !(n.callsign === m.alert.callsign && n.band === m.alert.band))].slice(0, 20) });
      for (const l of eventListeners) l({ t: "needed", alert: m.alert });
    } else if (m.t === "fault") for (const l of eventListeners) l({ t: "fault", reason: m.reason });
    else if (m.t === "window") {
      const decodes = [...state.decodes, ...m.decodes].slice(-600);
      const windows = [...state.windows, { index: m.index, mode: m.mode, start: m.start, decodeMs: m.decodeMs, skipped: m.skipped, ownTx: m.ownTx, count: m.decodes.length }].slice(-40);
      set({ decodes, windows });
    }
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    scheduleReconnect("connection to the engine closed");
  };
  sock.onerror = () => sock.close();
}

function scheduleReconnect(why: string) {
  set({ status: state.snap ? "closed" : "engine-down", error: why });
  const delay = Math.min(15_000, 1000 * 2 ** retry++);
  setTimeout(() => void connect(), delay);
}

function ensureStarted() {
  if (started || typeof window === "undefined") return;
  started = true;
  void connect();
}

export function useLive(): LiveState {
  ensureStarted();
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}

/** A waterfall row: bins 0–3000 Hz, each byte (dB above the noise floor + 10) × 2.5. */
export interface WaterfallRow {
  data: Uint8Array;
  /** Rows per second the engine is sending. */
  rate: number;
  /** When the audio was on the air: engine clock for current engines, else arrival here. */
  at: number;
  /** Our own transmit audio, not received signal. */
  tx: boolean;
}

/** What the engine heard at the Hell marker: a Hell mode (which), CW, or something else. */
export interface HellSeen {
  kind: "hell" | "cw" | "other";
  speed?: HellSpeed;
  reverse?: boolean;
  /** The signal's centre, audio Hz. */
  centreHz: number;
  /** When it was last heard like this, engine ms. */
  at: number;
}

let hellSeen: HellSeen | null = null;
const hellSeenListeners = new Set<() => void>();
function setHellSeen(s: HellSeen | null) {
  hellSeen = s;
  for (const l of hellSeenListeners) l();
}

/** The last thing heard at the Hell marker; it changes about once a second, so it is kept apart from the rest. */
export function useHellSeen(): HellSeen | null {
  return useSyncExternalStore(
    (fn) => {
      hellSeenListeners.add(fn);
      return () => hellSeenListeners.delete(fn);
    },
    () => hellSeen,
    () => null,
  );
}

/** The last minute or so of rows, so a remounted waterfall starts full. */
type HellWire = { at: number; freqHz: number; tx: boolean; px: string };
const fromWire = (c: HellWire): HellChunk => ({ at: c.at, freqHz: c.freqHz, tx: c.tx, px: Uint8Array.from(atob(c.px), (ch) => ch.charCodeAt(0)) });
const hellTapeData: HellChunk[] = [];
const hellListeners = new Set<(c: HellChunk | null) => void>();

/** The Hell tape so far (kept outside React state: columns arrive many times a second). */
export function hellTape(): readonly HellChunk[] {
  return hellTapeData;
}

/** New Hell columns as they arrive; null when the tape was cleared or reloaded. */
export function onHell(fn: (c: HellChunk | null) => void): () => void {
  hellListeners.add(fn);
  return () => hellListeners.delete(fn);
}

const WF_KEEP = 1400;
const wfHistory: WaterfallRow[] = [];
export function waterfallHistory(): readonly WaterfallRow[] {
  return wfHistory;
}

export function onWaterfallRow(fn: (row: WaterfallRow) => void): () => void {
  ensureStarted();
  rowListeners.add(fn);
  return () => rowListeners.delete(fn);
}

/** POST a control action to the engine through the web tier. */
export async function control(path: string, body: unknown = {}): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`/api/engine${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true } : { ok: false, error: j.error ?? `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
