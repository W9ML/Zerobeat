/**
 * JTTY source coding: what one 1.888 s frame carries.
 *
 * Written from WSJT-X 3.3's lib/jtty/jtty_source_encoding.txt (the canonical protocol
 * spec) and checked against its golden vectors. Each frame is 34 bits: a 32-bit grammar
 * word, a reserved zero bit, and an end-of-message flag. The grammar word is one "atom":
 *
 *   i2=0/1  a standard callsign (FT8's 28-bit c28) with one of six actions
 *           (CQ K1ABC CQ, K1ABC, TU K1ABC CQ, K1ABC TU, K1ABC AGN?, TU NOW K1ABC)
 *   i2=2    STRUCT30: a typed exchange (serial, zone, state, grid, class/section,
 *           control phrase such as AGN? or NR?)
 *   i2=3    TEXT5: five characters from a 64-character alphabet
 *
 * Text is packed into the fewest frames by a dynamic program over character offsets,
 * exactly as the spec's "Automatic text packing" section prescribes, so a message sent
 * from here takes the same frames WSJT-X would use.
 */

export const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ +-./?!\"#$%,&*()_'=[]{}<>|:;";

export const enum AtomKind {
  Call = 0,
  ExchNum = 1,
  ExchLoc = 2,
  ExchPair = 3,
  ExchNumTime = 4,
  Control = 5,
  Grid4 = 6,
  Text5 = 7,
}

export const CALL_ACTIONS = ["CQ", "CALL", "TU_CQ", "CALL_TU", "CALL_AGN", "TU_NOW"] as const;
export const enum CallAction {
  Cq = 0,
  Call = 1,
  TuCq = 2,
  CallTu = 3,
  CallAgn = 4,
  TuNow = 5,
}
export const enum NumKind {
  Serial = 0,
  CqZone = 1,
  ItuZone = 2,
  Age = 3,
  Power = 4,
  Check = 5,
  LicenseYear = 6,
  Generic = 7,
}
export const enum LocKind {
  StateProvince = 0,
  Section = 1,
  CountryPrefix = 2,
  Qth = 3,
  AdminCode = 4,
}
export const enum PairSchema {
  ZoneLoc3 = 0,
  ClassSection = 1,
}

export const CONTROL_TEXT = ["AGN?", "CALL?", "AGN CALL", "NR?", "AGN NR", "EXCH?", "STATE?", "SECTION?", "ZONE?", "GRID?", "RPRT?", "QSL TU", "TU", "QRZ?", "QSO B4", "WAIT", "NIL?", "OK?"];

/** lib/77bit/packjt77_grammar.f90 PACK77_ARRL_SECTIONS, 1-based on the wire. */
export const ARRL_SECTIONS = [
  "AB", "AK", "AL", "AR", "AZ", "BC", "CO", "CT", "DE", "EB", "EMA", "ENY", "EPA", "EWA", "GA", "GH", "IA", "ID", "IL", "IN", "KS", "KY", "LA", "LAX", "NS", "MB", "MDC", "ME", "MI", "MN", "MO", "MS", "MT", "NC", "ND", "NE", "NFL", "NH", "NL", "NLI", "NM", "NNJ", "NNY", "TER", "NTX", "NV", "OH", "OK", "ONE", "ONN", "ONS", "OR", "ORG", "PAC", "PR", "QC", "RI", "SB", "SC", "SCV", "SD", "SDG", "SF", "SFL", "SJV", "SK", "SNJ", "STX", "SV", "TN", "UT", "VA", "VI", "VT", "WCF", "WI", "WMA", "WNY", "WPA", "WTX", "WV", "WWA", "WY", "DX", "PE", "NB",
];

export interface Atom {
  kind: AtomKind;
  subtype: number;
  role: 0 | 1; // 1 = full exchange, rendered with a leading "599 "
  value: number;
  value2: number;
  text: string;
}

const atom = (kind: AtomKind, p: Partial<Omit<Atom, "kind">> = {}): Atom => ({ kind, subtype: 0, role: 0, value: 0, value2: 0, text: "", ...p });
export const callAtom = (action: number, call: string) => atom(AtomKind.Call, { subtype: action, text: call });
export const numAtom = (role: 0 | 1, kind: number, value: number) => atom(AtomKind.ExchNum, { role, subtype: kind, value });
export const locAtom = (role: 0 | 1, kind: number, token: string) => atom(AtomKind.ExchLoc, { role, subtype: kind, text: token });
export const zoneLocAtom = (zone: number, token: string) => atom(AtomKind.ExchPair, { subtype: PairSchema.ZoneLoc3, value: zone, text: token });
export const classSectionAtom = (count: number, cls: string, section: number) => atom(AtomKind.ExchPair, { subtype: PairSchema.ClassSection, value: count, value2: section, text: cls });
export const numTimeAtom = (role: 0 | 1, serial: number, minute: number) => atom(AtomKind.ExchNumTime, { role, value: serial, value2: minute });
export const controlAtom = (id: number) => atom(AtomKind.Control, { subtype: id });
export const grid4Atom = (role: 0 | 1, grid: string) => atom(AtomKind.Grid4, { role, text: grid });
export const text5Atom = (text: string) => atom(AtomKind.Text5, { text: text.slice(0, 5) });

// ---------------------------------------------------------------------------
// Standard callsigns: FT8's c28 (lib/77bit/packjt77.f90 pack28/unpack28)
// ---------------------------------------------------------------------------

const NTOKENS = 2_063_592;
const MAX22 = 4_194_304;
const A1 = " 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const A2 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const A3 = "0123456789";
const A4 = " ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const isDigit = (c: string) => c >= "0" && c <= "9";
const isLetter = (c: string) => c >= "A" && c <= "Z";

/** pack77_c28_standard_shape: 3-6 characters, a digit in position 2 or 3, ≤3 letter suffix. */
function c28Shape(t: string): boolean {
  const n = t.length;
  if (n < 3 || n > 6 || !/^[A-Z0-9]+$/.test(t)) return false;
  let area = 0;
  for (let i = n; i >= 2; i--) {
    if (isDigit(t[i - 1]!)) {
      area = i;
      break;
    }
  }
  if (area !== 2 && area !== 3) return false;
  let pdig = 0;
  let plet = 0;
  for (let i = 1; i < area; i++) {
    if (isDigit(t[i - 1]!)) pdig++;
    else plet++;
  }
  if (plet === 0 || pdig >= area - 1) return false;
  for (let i = area + 1; i <= n; i++) if (!isLetter(t[i - 1]!)) return false;
  return n - area <= 3;
}

/** chkcall (lib/chkcall.f90) for a call without a slash. */
function chkcall(w: string): boolean {
  const n = w.length;
  if (n > 6 || /[.+\-?/]/.test(w)) return false;
  if (!isLetter(w[0] ?? "") && !isLetter(w[1] ?? "")) return false;
  if (w[0] === "Q") return false;
  let i1 = 0;
  if (isDigit(w[1] ?? "")) i1 = 2;
  if (isDigit(w[2] ?? "")) i1 = 3;
  if (i1 === 0 || i1 === n) return false;
  const suffix = w.slice(i1);
  return /^[A-Z]{1,3}$/.test(suffix);
}

export function packCall28(call: string): number | null {
  if (!c28Shape(call)) return null;
  let area = 0;
  for (let i = call.length; i >= 2; i--) {
    if (isDigit(call[i - 1]!)) {
      area = i;
      break;
    }
  }
  const cs = (area === 2 ? " " + call.slice(0, 5) : call.slice(0, 6)).padEnd(6, " ");
  const i1 = A1.indexOf(cs[0]!);
  const i2 = A2.indexOf(cs[1]!);
  const i3 = A3.indexOf(cs[2]!);
  const i4 = A4.indexOf(cs[3]!);
  const i5 = A4.indexOf(cs[4]!);
  const i6 = A4.indexOf(cs[5]!);
  if (i1 < 0 || i2 < 0 || i3 < 0 || i4 < 0 || i5 < 0 || i6 < 0) return null;
  return 36 * 10 * 27 * 27 * 27 * i1 + 10 * 27 * 27 * 27 * i2 + 27 * 27 * 27 * i3 + 27 * 27 * i4 + 27 * i5 + i6 + NTOKENS + MAX22;
}

export function unpackCall28(n28: number): string | null {
  let n = n28 - NTOKENS - MAX22;
  if (n < 0) return null; // special token or hash: not a JTTY call atom
  const i1 = Math.floor(n / (36 * 10 * 27 * 27 * 27));
  n -= 36 * 10 * 27 * 27 * 27 * i1;
  const i2 = Math.floor(n / (10 * 27 * 27 * 27));
  n -= 10 * 27 * 27 * 27 * i2;
  const i3 = Math.floor(n / (27 * 27 * 27));
  n -= 27 * 27 * 27 * i3;
  const i4 = Math.floor(n / (27 * 27));
  n -= 27 * 27 * i4;
  const i5 = Math.floor(n / 27);
  const i6 = n - 27 * i5;
  if (i1 >= A1.length || i2 >= A2.length) return null;
  const s = (A1[i1]! + A2[i2]! + A3[i3]! + A4[i4]! + A4[i5]! + A4[i6]!).trim();
  if (s.includes(" ")) return null;
  return s;
}

/** A call JTTY can carry in a call atom: chkcall-valid, no slash, not Q, and c28 round-trips. */
export function standardCall(call: string): boolean {
  if (!/^[A-Z0-9]+$/.test(call) || !chkcall(call)) return false;
  const n = packCall28(call);
  return n !== null && unpackCall28(n) === call;
}

// ---------------------------------------------------------------------------
// Atom <-> 34 bits
// ---------------------------------------------------------------------------

const base36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function packBase36(t: string): number | null {
  if (t.length !== 2 && t.length !== 3) return null;
  let v = 0;
  for (const c of t) {
    const d = base36.indexOf(c);
    if (d < 0) return null;
    v = v * 36 + d;
  }
  if (t.length === 3 && v < 36 * 36) return null;
  return v;
}
function unpackBase36(v: number, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) {
    s = base36[v % 36]! + s;
    v = Math.floor(v / 36);
  }
  return s;
}

function grid4Index(g: string): number | null {
  if (!/^[A-R][A-R][0-9][0-9]$/.test(g)) return null;
  const a = g.charCodeAt(0) - 65;
  const b = g.charCodeAt(1) - 65;
  return ((a * 18 + b) * 10 + Number(g[2])) * 10 + Number(g[3]);
}
function indexGrid4(i: number): string {
  const d = i % 10;
  i = Math.floor(i / 10);
  const c = i % 10;
  i = Math.floor(i / 10);
  const b = i % 18;
  const a = Math.floor(i / 18);
  return String.fromCharCode(65 + a, 65 + b) + c + d;
}

function validNumber(kind: number, value: number): boolean {
  if (kind < 0 || kind > 7 || value < 0 || value > 131_071 || !Number.isInteger(value)) return false;
  if (kind === NumKind.CqZone) return value >= 1 && value <= 40;
  if (kind === NumKind.ItuZone) return value >= 1 && value <= 90;
  if (kind === NumKind.LicenseYear) return value <= 9999;
  return true;
}

const struct = (body: number, family: number) => 4 * (8 * body + family) + 2;
const field = (v: number, shift: number) => v * 2 ** shift;
const bits = (v: number, shift: number, width: number) => Math.floor(v / 2 ** shift) % 2 ** width;

/** The 32-bit grammar word for an atom, or null if the atom is not valid. */
export function packAtom(a: Atom): number | null {
  switch (a.kind) {
    case AtomKind.Call: {
      if (a.subtype < 0 || a.subtype > 5 || !standardCall(a.text)) return null;
      const n28 = packCall28(a.text)!;
      const i2 = a.subtype <= 3 ? 0 : 1;
      const n2 = a.subtype <= 3 ? a.subtype : a.subtype - 4;
      return n28 * 16 + 4 * n2 + i2;
    }
    case AtomKind.ExchNum:
      if ((a.role !== 0 && a.role !== 1) || !validNumber(a.subtype, a.value)) return null;
      return struct(field(a.role, 26) + field(a.subtype, 22) + field(a.value, 5), 0);
    case AtomKind.ExchLoc: {
      if (a.subtype < 0 || a.subtype > 4) return null;
      const v = packBase36(a.text);
      if (v === null) return null;
      return struct(field(a.role, 26) + field(a.subtype, 22) + field(a.text.length - 2, 21) + field(v, 5), 1);
    }
    case AtomKind.ExchPair: {
      let pair: number;
      if (a.subtype === PairSchema.ZoneLoc3) {
        if (a.value < 1 || a.value > 40) return null;
        const v = packBase36(a.text);
        if (v === null) return null;
        pair = field(a.value, 17) + field(a.text.length - 2, 16) + v;
      } else if (a.subtype === PairSchema.ClassSection) {
        if (a.value < 1 || a.value > 32 || a.value2 < 1 || a.value2 > ARRL_SECTIONS.length || a.text.length !== 1) return null;
        const cls = a.text.charCodeAt(0) - 65;
        if (cls < 0 || cls > 5) return null;
        pair = field(a.value, 17) + field(cls, 14) + field(a.value2, 7);
      } else return null;
      return struct(field(a.subtype, 24) + field(pair, 1), 2);
    }
    case AtomKind.ExchNumTime:
      if (a.value < 0 || a.value > 16_383 || a.value2 < 0 || a.value2 > 1439) return null;
      return struct(field(a.role, 26) + field(a.value, 12) + field(a.value2, 1), 3);
    case AtomKind.Control:
      if (a.subtype < 0 || a.subtype > 17) return null;
      return struct(field(0, 23) + field(a.subtype, 16), 4);
    case AtomKind.Grid4: {
      const g = grid4Index(a.text);
      if (g === null) return null;
      return struct(field(1, 23) + field(a.role, 22) + field(g, 7), 4);
    }
    case AtomKind.Text5: {
      const t = a.text.padEnd(5, " ");
      let top = 0;
      for (let i = 0; i < 5; i++) {
        const c = ALPHABET.indexOf(t[i]!);
        if (c < 0) return null;
        top = top * 64 + c;
      }
      return top * 4 + 3;
    }
  }
  return null;
}

/** 34 frame bits (MSB first): the grammar word, the reserved zero, the EOM flag. */
export function frameBits(word: number, eom: boolean): number[] {
  const out: number[] = [];
  for (let i = 31; i >= 0; i--) out.push(bits(word, i, 1));
  out.push(0, eom ? 1 : 0);
  return out;
}

/** Back from 34 bits: the atom and its EOM flag, or null for anything the spec calls invalid. */
export function unpackFrame(b: ArrayLike<number>): { atom: Atom; eom: boolean } | null {
  if (b.length < 34 || b[32] !== 0) return null;
  let w = 0;
  for (let i = 0; i < 32; i++) w = w * 2 + b[i]!;
  if (w === 0) return null;
  const eom = b[33] === 1;
  const i2 = w % 4;
  const top30 = Math.floor(w / 4);
  if (i2 === 0 || i2 === 1) {
    const n2 = top30 % 4;
    if (i2 === 1 && n2 > 1) return null;
    const call = unpackCall28(Math.floor(w / 16));
    if (!call || !standardCall(call)) return null;
    return { atom: callAtom(i2 === 0 ? n2 : n2 + 4, call), eom };
  }
  if (i2 === 3) {
    let t = "";
    for (let i = 4; i >= 0; i--) t += ALPHABET[bits(top30, 6 * i, 6)]!;
    return { atom: text5Atom(t), eom };
  }
  const family = top30 % 8;
  const body = Math.floor(top30 / 8);
  switch (family) {
    case 0: {
      const role = bits(body, 26, 1) as 0 | 1;
      const kind = bits(body, 22, 4);
      const value = bits(body, 5, 17);
      if (bits(body, 0, 5) !== 0 || !validNumber(kind, value)) return null;
      return { atom: numAtom(role, kind, value), eom };
    }
    case 1: {
      const role = bits(body, 26, 1) as 0 | 1;
      const kind = bits(body, 22, 4);
      const n = bits(body, 21, 1) + 2;
      const v = bits(body, 5, 16);
      if (bits(body, 0, 5) !== 0 || kind > 4 || v >= 36 ** n || (n === 3 && v < 36 * 36)) return null;
      return { atom: locAtom(role, kind, unpackBase36(v, n)), eom };
    }
    case 2: {
      const schema = bits(body, 24, 3);
      const pair = bits(body, 1, 23);
      if (bits(body, 0, 1) !== 0) return null;
      if (schema === PairSchema.ZoneLoc3) {
        const zone = bits(pair, 17, 6);
        const n = bits(pair, 16, 1) + 2;
        const v = bits(pair, 0, 16);
        if (zone < 1 || zone > 40 || v >= 36 ** n || (n === 3 && v < 36 * 36)) return null;
        return { atom: zoneLocAtom(zone, unpackBase36(v, n)), eom };
      }
      if (schema === PairSchema.ClassSection) {
        const count = bits(pair, 17, 6);
        const cls = bits(pair, 14, 3);
        const section = bits(pair, 7, 7);
        if (count < 1 || count > 32 || cls > 5 || section < 1 || section > ARRL_SECTIONS.length || bits(pair, 0, 7) !== 0) return null;
        return { atom: classSectionAtom(count, String.fromCharCode(65 + cls), section), eom };
      }
      return null;
    }
    case 3: {
      const role = bits(body, 26, 1) as 0 | 1;
      const serial = bits(body, 12, 14);
      const minute = bits(body, 1, 11);
      if (bits(body, 0, 1) !== 0 || minute > 1439) return null;
      return { atom: numTimeAtom(role, serial, minute), eom };
    }
    case 4: {
      const sub = bits(body, 23, 4);
      const data = bits(body, 0, 23);
      if (sub === 0) {
        const id = bits(data, 16, 7);
        if (bits(data, 0, 16) !== 0 || id > 17) return null;
        return { atom: controlAtom(id), eom };
      }
      if (sub === 1) {
        const role = bits(data, 22, 1) as 0 | 1;
        const g = bits(data, 7, 15);
        if (bits(data, 0, 7) !== 0 || g >= 32_400) return null;
        return { atom: grid4Atom(role, indexGrid4(g)), eom };
      }
      return null;
    }
  }
  return null; // families 5-7: reserved or invalid
}

const pad = (v: number, w: number) => String(v).padStart(w, "0");
function renderNumber(kind: number, v: number): string {
  if (kind === NumKind.Serial) return v < 1000 ? pad(v, 3) : String(v);
  if (kind === NumKind.CqZone || kind === NumKind.ItuZone || kind === NumKind.Check) return v < 100 ? pad(v, 2) : String(v);
  if (kind === NumKind.LicenseYear) return pad(v, 4);
  return String(v);
}
const withRole = (role: number, s: string) => (role === 1 ? `599 ${s}` : s);

/** How an atom reads. TEXT5 keeps its padding; callers trim the end of a message. */
export function renderAtom(a: Atom): string {
  switch (a.kind) {
    case AtomKind.Call:
      return [`CQ ${a.text} CQ`, a.text, `TU ${a.text} CQ`, `${a.text} TU`, `${a.text} AGN?`, `TU NOW ${a.text}`][a.subtype] ?? "";
    case AtomKind.ExchNum:
      return withRole(a.role, renderNumber(a.subtype, a.value));
    case AtomKind.ExchLoc:
      return withRole(a.role, a.text);
    case AtomKind.ExchPair:
      return a.subtype === PairSchema.ZoneLoc3 ? `599 ${pad(a.value, 2)} ${a.text}` : `${a.value}${a.text} ${ARRL_SECTIONS[a.value2 - 1]}`;
    case AtomKind.ExchNumTime:
      return withRole(a.role, `${renderNumber(NumKind.Serial, a.value)} ${pad(Math.floor(a.value2 / 60), 2)}${pad(a.value2 % 60, 2)}`);
    case AtomKind.Control:
      return CONTROL_TEXT[a.subtype] ?? "";
    case AtomKind.Grid4:
      return withRole(a.role, a.text);
    case AtomKind.Text5:
      return a.text.padEnd(5, " ");
  }
  return "";
}

/** Text from a run of atoms: structured atoms add one separating space, TEXT5 is verbatim. */
export function renderAtoms(atoms: Atom[]): string {
  let s = "";
  for (const a of atoms) s += a.kind === AtomKind.Text5 ? renderAtom(a) : renderAtom(a) + " ";
  return s.trimEnd().slice(0, 80);
}

// ---------------------------------------------------------------------------
// Automatic text packing
// ---------------------------------------------------------------------------

export type ExchangeProfile = "unknown" | "field-day" | "rtty-roundup";

/** Upper case, the JTTY alphabet ('#' for anything else), single spaces. */
export function normalizeMessage(raw: string): string {
  let out = "";
  let lastSpace = true;
  for (let c of raw.slice(0, 80)) {
    if (c === "\0" || c === "~" || c === "\t" || c === "\n" || c === "\r") c = " ";
    c = c.toUpperCase();
    if (ALPHABET.indexOf(c) < 0) c = "#";
    if (c === " ") {
      if (lastSpace) continue;
      lastSpace = true;
    } else lastSpace = false;
    out += c;
  }
  return out.trimEnd();
}

function decimalValue(t: string): number | null {
  if (t.length < 1 || t.length > 6 || !/^[0-9]+$/.test(t)) return null;
  const v = Number(t);
  return v <= 131_071 ? v : null;
}

/** RTTY Roundup: a number after a complete "599" token is respelled as a serial. */
function normalizeSerials(msg: string): string | null {
  const w = msg.split(" ");
  const out: string[] = [];
  for (let i = 0; i < w.length; i++) {
    out.push(w[i]!);
    if (w[i] === "599" && i + 1 < w.length) {
      const v = decimalValue(w[i + 1]!);
      if (v !== null) {
        out.push(renderNumber(NumKind.Serial, v));
        i++;
      }
    }
  }
  const s = out.join(" ");
  return s.length > 80 ? null : s;
}

export const sectionIndexOf = (s: string) => ARRL_SECTIONS.indexOf(s) + 1;
const sectionIndex = sectionIndexOf;
const keyOf = (a: Atom) => 100 * a.kind + 2 * a.subtype + a.role;

/**
 * Text → the fewest atoms that reproduce it exactly (lib/jtty/jtty_mod.f90 pack_jtty).
 * Returns the normalized text actually sent, or null if it needs more than 16 frames.
 */
export function packText(raw: string, profile: ExchangeProfile = "unknown"): { text: string; atoms: Atom[] } | null {
  let msg = normalizeMessage(raw);
  if (profile === "rtty-roundup") {
    const s = normalizeSerials(msg);
    if (s === null) return null;
    msg = s;
  }
  const n = msg.length;
  if (n === 0) return { text: "", atoms: [] };
  const INF = 999;
  // 1-based positions as in the reference: dp[i] is the frame count for msg[i..n].
  const dp = new Array<number>(n + 2).fill(INF);
  const successor = new Array<number>(n + 2).fill(0);
  const choice: (Atom | null)[] = new Array(n + 2).fill(null);
  dp[n + 1] = 0;
  const at = (i: number, j: number) => msg.slice(i - 1, j); // msg(i:j), 1-based inclusive

  for (let ipos = n; ipos >= 1; ipos--) {
    const consider = (a: Atom, next: number) => {
      const cost = 1 + dp[next]!;
      if (cost > 16 || cost > dp[ipos]!) return;
      const best = choice[ipos];
      const rank = a.kind === AtomKind.Text5 ? 1 : 0;
      const bestRank = best && best.kind === AtomKind.Text5 ? 1 : 0;
      if (cost === dp[ipos]) {
        if (rank > bestRank) return;
        if (rank === bestRank) {
          if (next < successor[ipos]!) return;
          if (next === successor[ipos] && best && keyOf(a) >= keyOf(best)) return;
        }
      }
      dp[ipos] = cost;
      successor[ipos] = next;
      choice[ipos] = a;
    };
    const offer = (a: Atom) => {
      const w = packAtom(a);
      if (w === null) return;
      const back = unpackFrame(frameBits(w, false));
      if (!back) return;
      const r = renderAtom(back.atom);
      if (!r) return;
      const last = ipos + r.length - 1;
      if (last > n || at(ipos, last) !== r) return;
      let next = n + 1;
      if (last < n) {
        if (msg[last] !== " ") return; // msg(last+1)
        next = last + 2;
      }
      consider(a, next);
    };

    const inext = Math.min(n + 1, ipos + 5);
    consider(text5Atom(at(ipos, inext - 1)), inext);
    if (ipos > 1 && msg[ipos - 2] !== " ") continue;

    // try_compact
    const words = msg.slice(ipos - 1).split(" ").slice(0, 3);
    for (const w of words) {
      if (w.length > 13) continue;
      for (let action = 0; action <= 5; action++) offer(callAtom(action, w));
    }
    for (let id = 0; id < CONTROL_TEXT.length; id++) offer(controlAtom(id));
    for (const role of [0, 1] as const) {
      let f = 0;
      if (role === 1) {
        if (words[0] !== "599" || words.length < 2) continue;
        f = 1;
      }
      const word = words[f]!;
      const v = decimalValue(word);
      if (v !== null) {
        offer(numAtom(role, NumKind.Generic, v));
        if (role === 1 && profile === "rtty-roundup") offer(numAtom(role, NumKind.Serial, v));
      }
      if (word.length === 4) offer(grid4Atom(role, word));
      if (role !== 1 || word.length < 2 || word.length > 3 || !/[A-Z]/.test(word)) continue;
      offer(locAtom(role, LocKind.Qth, word));
      if (profile === "rtty-roundup") offer(locAtom(role, LocKind.StateProvince, word));
    }
    const w0 = words[0]!;
    if (words.length >= 2 && w0.length >= 2 && w0.length <= 3) {
      const count = decimalValue(w0.slice(0, -1));
      if (count !== null) offer(classSectionAtom(count, w0.slice(-1), sectionIndex(words[1]!)));
    }
  }

  if (dp[1]! > 16) return null;
  const atoms: Atom[] = [];
  for (let i = 1; i <= n; i = successor[i]!) atoms.push(choice[i]!);
  return { text: msg, atoms };
}

// ---------------------------------------------------------------------------
// Native function keys (the spec's "Native function keys" section)
// ---------------------------------------------------------------------------

export interface MacroContext {
  myCall: string;
  hisCall: string;
  queueCall: string;
  /** The configured exchange: a serial under "unknown", "1D EMA" under Field Day, serial or state under RTTY. */
  exchange: string;
  profile: ExchangeProfile;
}

export const FKEYS = ["CQ %M CQ", "%H %E", "%H TU CQ %M CQ", "%M", "%H", "TU NOW %Q %E", "%H AGN?", "%E"] as const;

function exchangeAtom(ctx: MacroContext): Atom | string {
  const e = normalizeMessage(ctx.exchange);
  if (ctx.profile === "field-day") {
    const m = /^(\d{1,2})([A-F]) ([A-Z]{2,3})$/.exec(e);
    const sec = m ? sectionIndex(m[3]!) : 0;
    if (!m || !sec || Number(m[1]) < 1 || Number(m[1]) > 32) return "the Field Day exchange must look like 1D EMA";
    return classSectionAtom(Number(m[1]), m[2]!, sec);
  }
  const v = decimalValue(e);
  if (v !== null) return numAtom(1, NumKind.Serial, v);
  if (ctx.profile === "rtty-roundup" && /^[A-Z0-9]{2,3}$/.test(e) && /[A-Z]/.test(e) && packBase36(e) !== null) return locAtom(1, LocKind.StateProvince, e);
  return ctx.profile === "rtty-roundup" ? "the exchange must be a serial number or a state/province" : "the exchange must be a serial number";
}

/**
 * A function-key template to atoms. The eight shipped templates compile to typed atoms;
 * any other text goes through automatic packing after %M/%H/%Q/%E substitution. A
 * native template whose call or exchange is invalid is refused, never sent differently.
 */
export function compileMacro(template: string, ctx: MacroContext): { text: string; atoms: Atom[] } | { error: string } {
  const t = normalizeMessage(template);
  const my = ctx.myCall.toUpperCase();
  const his = ctx.hisCall.toUpperCase();
  const q = ctx.queueCall.toUpperCase();
  const need = (c: string, what: string) => (standardCall(c) ? null : `${what} "${c || "—"}" cannot be sent as a JTTY callsign`);
  const exch = () => exchangeAtom(ctx);
  const build = (parts: (Atom | string | null)[]): { text: string; atoms: Atom[] } | { error: string } => {
    for (const p of parts) if (typeof p === "string") return { error: p };
    const atoms = parts.filter((p): p is Atom => p !== null);
    return { text: renderAtoms(atoms), atoms };
  };
  switch (t) {
    case "CQ %M CQ":
      return build([need(my, "My call") ?? callAtom(CallAction.Cq, my)]);
    case "%H %E":
      return build([need(his, "His call") ?? callAtom(CallAction.Call, his), exch()]);
    case "%H TU CQ %M CQ":
      return build([need(his, "His call") ?? callAtom(CallAction.CallTu, his), need(my, "My call") ?? callAtom(CallAction.Cq, my)]);
    case "%M":
      return build([need(my, "My call") ?? callAtom(CallAction.Call, my)]);
    case "%H":
      return build([need(his, "His call") ?? callAtom(CallAction.Call, his)]);
    case "TU NOW %Q %E":
      return build([need(q, "Next call") ?? callAtom(CallAction.TuNow, q), exch()]);
    case "%H AGN?":
      return build([need(his, "His call") ?? callAtom(CallAction.CallAgn, his)]);
    case "%E":
      return build([exch()]);
  }
  const text = t.replace(/%M/g, my).replace(/%H/g, his).replace(/%Q/g, q).replace(/%E/g, ctx.exchange.toUpperCase());
  const p = packText(text, ctx.profile);
  return p ? p : { error: "that message needs more than 16 frames" };
}
