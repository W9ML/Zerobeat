/**
 * JS8Call message framing ("Varicode"): what the 72 bits of one JS8 frame carry.
 *
 * Ported from JS8Call-improved JS8_Main/Varicode.cpp (GPL-3, (C) 2018 Jordan Sherer KN4CRD),
 * with the receive-side interpretation from JS8_Mode/DecodedText.cpp. The aim is byte-for-byte
 * interoperability with JS8Call, so the packing rules, tables, regular expressions and even
 * the odd corners (which map key wins when two share a value, what happens to text the
 * coders cannot represent) follow the C++ rather than a tidier reading of it.
 *
 * On the air a frame is 12 characters of a 64-symbol alphabet (6 bits each, 72 bits) plus a
 * 3-bit transmission type i3 (first/last/data flags). The first three bits of the 72 select
 * the frame type:
 *
 *   000 heartbeat           [3 type][50 callsign][16 grid + alt flag][3 cq/hb number]
 *   001 compound            [3][50 callsign][16 grid or packed command][3]
 *   010 compound directed   same layout, the "extra" field holds a command (+ SNR)
 *   011 directed            [3][28 from][28 to][5 command][1 from /P][1 to /P][6 number]
 *   1xx data                Huffman (10...) or JSC-compressed (11...) text
 *
 * In the fast submodes data frames drop the type prefix entirely and use all 72 bits for JSC
 * text, flagged instead by the data bit in i3.
 *
 * Qt details that matter for exactness: QMap iterates keys in sorted order, so a reverse
 * lookup (QMap::key) returns the alphabetically first key with that value; QList::mid treats a
 * negative length as "to the end"; QRegularExpression is PCRE2 without Unicode properties, so
 * \s means ASCII whitespace and $ also matches before a final newline. All of these are
 * mirrored below.
 */

import { jscCompress, jscDecompress, jscExtendedChars } from "./jsc.ts";

/** Varicode::SubmodeType */
export const enum Submode {
  Normal = 0,
  Fast = 1,
  Turbo = 2,
  Slow = 4,
  Ultra = 8,
}

/** Varicode::TransmissionType: the i3 bits sent beside the 72-bit payload. */
export const enum TransmissionType {
  Normal = 0,
  First = 1,
  Last = 2,
  Data = 4,
}

/** Varicode::FrameType */
export const enum FrameType {
  Unknown = 255,
  Heartbeat = 0,
  Compound = 1,
  CompoundDirected = 2,
  Directed = 3,
  Data = 4,
  DataCompressed = 6,
}

export const FRAME_TYPE_MAX = 6;

const FRAME_TYPE_STRINGS = [
  "FrameHeartbeat",
  "FrameCompound",
  "FrameCompoundDirected",
  "FrameDirected",
  "FrameData",
  "FrameUnknown",
  "FrameDataCompressed",
];

export function frameTypeString(type: number): string {
  if (type > FRAME_TYPE_MAX) return "FrameUnknown";
  return FRAME_TYPE_STRINGS[type] ?? "FrameUnknown";
}

export function intToSubmode(sm: number): Submode {
  switch (sm) {
    case Submode.Normal:
    case Submode.Fast:
    case Submode.Turbo:
    case Submode.Slow:
    case Submode.Ultra:
      return sm;
  }
  throw new Error(`Unexpected JS8 submode ${sm}`);
}

/* ------------------------------------------------------------------------------------------
 * Alphabets, patterns and tables (Varicode.cpp file scope)
 * ---------------------------------------------------------------------------------------- */

const NALPHABET = 41;
/** Base-41 alphabet used by the 5/6/16/32/64-bit packers (checksums). */
export const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-./?";
/** The 64 symbols a frame is written in (6 bits per character). */
export const ALPHABET72 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-+/?.";
/** Callsign and grid alphabet. */
const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ /@";

// PCRE2 without UCP: \s is ASCII whitespace only, and a non-multiline $ also matches just
// before a trailing newline. JS's \s and $ differ, so the patterns spell these out.
const WS = "[\\t\\n\\v\\f\\r ]";
const EOL = "\\n?$";

const GRID_PATTERN = "(?<grid>[A-X]{2}[0-9]{2}(?:[A-X]{2}(?:[0-9]{2})?)*)+";
const BASE_CALLSIGN_PATTERN =
  "(?<callsign>\\b(?<base>([0-9A-Z])?([0-9A-Z])([0-9])([A-Z])?([A-Z])?([A-Z])?)(?<portable>[/][P])?\\b)";
const COMPOUND_CALLSIGN_PATTERN =
  "(?<callsign>(?:[@]?|\\b)(?<extended>[A-Z0-9\\/@][A-Z0-9\\/]{0,2}[\\/]?[A-Z0-9\\/]{0,3}[\\/]?[A-Z0-9\\/]{0,3})\\b)";
const PACK_CALLSIGN_PATTERN = "([0-9A-Z ])([0-9A-Z])([0-9])([A-Z ])([A-Z ])([A-Z ])";

const CALLSIGN_PATTERN = "(?<callsign>[@]?[A-Z0-9/]+)";
const OPTIONAL_CMD_PATTERN =
  `(?<cmd>${WS}?(?:AGN[?]|QSL[?]|HW CPY[?]|MSG TO[:]|SNR[?]|INFO[?]|GRID[?]|STATUS[?]|QUERY MSGS[?]|HEARING[?]|` +
  `(?:(?:STATUS|HEARING|QUERY CALL|QUERY MSGS|QUERY|CMD|MSG|NACK|ACK|73|YES|NO|HEARTBEAT SNR|SNR|QSL|RR|SK|FB|INFO|GRID|DIT DIT)(?=[ ]|${EOL}))|[?> ]))?`;
const OPTIONAL_GRID_PATTERN = `(?<grid>${WS}?[A-R]{2}[0-9]{2})?`;
const OPTIONAL_NUM_PATTERN = `(?<num>(?<=SNR)${WS}?[-+]?(?:3[01]|[0-2]?[0-9]))?`;

const GRID_RE = new RegExp(GRID_PATTERN);
const BASE_CALLSIGN_RE = new RegExp(BASE_CALLSIGN_PATTERN);
const COMPOUND_CALLSIGN_ANCHORED_RE = new RegExp("^" + COMPOUND_CALLSIGN_PATTERN);
const PACK_CALLSIGN_RE = new RegExp(PACK_CALLSIGN_PATTERN);
const ALNUM_PAIR_RE = /[0-9][A-Z]|[A-Z][0-9]/;

const DIRECTED_RE = new RegExp("^" + CALLSIGN_PATTERN + OPTIONAL_CMD_PATTERN + OPTIONAL_NUM_PATTERN);
const HEARTBEAT_RE = new RegExp(
  `^${WS}*(?<callsign>[@](?:ALLCALL|HB)${WS}+)?(?<type>CQ CQ CQ|CQ DX|CQ QRP|CQ CONTEST|CQ FIELD|CQ FD|CQ CQ|CQ|HB|HEARTBEAT(?!${WS}+SNR))(?:${WS}(?<grid>[A-R]{2}[0-9]{2}))?\\b`,
);
// the grid comes before the command on purpose (see buildMessageFrames' compound frames)
const COMPOUND_RE = new RegExp(
  `^${WS}*[\`]` + CALLSIGN_PATTERN + "(?<extra>" + OPTIONAL_GRID_PATTERN + OPTIONAL_CMD_PATTERN + OPTIONAL_NUM_PATTERN + ")",
);

/** directed_cmds: command text (with its leading space) to the 5-bit command number. */
export const DIRECTED_CMDS: ReadonlyMap<string, number> = new Map<string, number>([
  [" HEARTBEAT", -1], // heartbeat (only used for faux processing of HBs as directed commands)
  [" HB", -1],
  [" CQ", -1],
  [" SNR?", 0], // query snr
  ["?", 0], // compat
  [" DIT DIT", 1],
  [" HEARING?", 3],
  [" GRID?", 4],
  [">", 5], // relay message
  [" STATUS?", 6],
  [" STATUS", 7],
  [" HEARING", 8],
  [" MSG", 9],
  [" MSG TO:", 10],
  [" QUERY", 11],
  [" QUERY MSGS", 12],
  [" QUERY MSGS?", 12],
  [" QUERY CALL", 13],
  [" GRID", 15],
  [" INFO?", 16],
  [" INFO", 17],
  [" FB", 18],
  [" HW CPY?", 19],
  [" SK", 20],
  [" RR", 21],
  [" QSL?", 22],
  [" QSL", 23],
  [" CMD", 24],
  [" SNR", 25],
  [" NO", 26],
  [" YES", 27],
  [" 73", 28],
  [" NACK", 2],
  [" ACK", 14],
  [" HEARTBEAT SNR", 29],
  [" AGN?", 30],
  ["  ", 31], // free text (weird artifact)
  [" ", 31], // free text
]);

// QMap<QString,int> iterates in key order; QString's operator< and JS's default sort both
// compare UTF-16 code units.
const SORTED_CMD_KEYS = [...DIRECTED_CMDS.keys()].sort();

/** QMap::key(value): the first command (in key order) with this number, or "". */
export function directedCmdKey(value: number): string {
  for (const k of SORTED_CMD_KEYS) if (DIRECTED_CMDS.get(k) === value) return k;
  return "";
}

export const ALLOWED_CMDS: ReadonlySet<number> = new Set([
  -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
]);
/** Commands that result in an automatic reply (which can be relayed). */
export const AUTOREPLY_CMDS: ReadonlySet<number> = new Set([0, 2, 3, 4, 6, 9, 10, 11, 12, 13, 14, 16, 30]);
/** Commands whose following text is buffered until the last frame. */
export const BUFFERED_CMDS: ReadonlySet<number> = new Set([5, 9, 10, 11, 12, 13, 15, 24]);
/** Commands that may carry an SNR value. */
export const SNR_CMDS: ReadonlySet<number> = new Set([25, 29]);
/** Commands whose buffered text carries a checksum, and its size in bits. */
export const CHECKSUM_CMDS: ReadonlyMap<number, number> = new Map([
  [5, 16],
  [9, 16],
  [10, 16],
  [11, 16],
  [12, 16],
  [13, 16],
  [15, 0],
  [24, 16],
]);

/** Huffman table for the (deprecated in 2.2) uncompressed data frames. */
export const HUFF_TABLE: ReadonlyMap<string, string> = new Map([
  [" ", "01"],
  ["E", "100"],
  ["T", "1101"],
  ["A", "0011"],
  ["O", "11111"],
  ["I", "11100"],
  ["N", "10111"],
  ["S", "10100"],
  ["H", "00011"],
  ["R", "00000"],
  ["D", "111011"],
  ["L", "110011"],
  ["C", "110001"],
  ["U", "101101"],
  ["M", "101011"],
  ["W", "001011"],
  ["F", "001001"],
  ["G", "000101"],
  ["Y", "000011"],
  ["P", "1111011"],
  ["B", "1111001"],
  [".", "1110100"],
  ["V", "1100101"],
  ["K", "1100100"],
  ["-", "1100001"],
  ["+", "1100000"],
  ["?", "1011001"],
  ["!", "1011000"],
  ['"', "1010101"],
  ["X", "1010100"],
  ["0", "0010101"],
  ["J", "0010100"],
  ["1", "0010001"],
  ["Q", "0010000"],
  ["2", "0001001"],
  ["Z", "0001000"],
  ["3", "0000101"],
  ["5", "0000100"],
  ["4", "11110101"],
  ["9", "11110100"],
  ["8", "11110001"],
  ["6", "11110000"],
  ["7", "11101011"],
  ["/", "11101010"],
]);

const ESC = "\\";
const EOT = "\x04";

const NBASECALL = 37 * 36 * 10 * 27 * 27 * 27;
const NBASEGRID = 180 * 180;
const NUSERGRID = NBASEGRID + 10;
const NMAXGRID = (1 << 15) - 1;

/** Reserved callsign values above the 28-bit standard call space: placeholders and @groups. */
export const BASECALLS: ReadonlyMap<string, number> = new Map(
  (
    [
      "<....>", // incomplete callsign
      "@ALLCALL",
      "@JS8NET",
      "@DX/NA",
      "@DX/SA",
      "@DX/EU",
      "@DX/AS",
      "@DX/AF",
      "@DX/OC",
      "@DX/AN",
      "@REGION/1",
      "@REGION/2",
      "@REGION/3",
      "@GROUP/0",
      "@GROUP/1",
      "@GROUP/2",
      "@GROUP/3",
      "@GROUP/4",
      "@GROUP/5",
      "@GROUP/6",
      "@GROUP/7",
      "@GROUP/8",
      "@GROUP/9",
      "@COMMAND",
      "@CONTROL",
      "@NET",
      "@NTS",
      "@RESERVE/0",
      "@RESERVE/1",
      "@RESERVE/2",
      "@RESERVE/3",
      "@RESERVE/4",
      "@APRSIS",
      "@RAGCHEW",
      "@JS8",
      "@EMCOMM",
      "@ARES",
      "@MARS",
      "@AMRRON",
      "@RACES",
      "@RAYNET",
      "@RADAR",
      "@SKYWARN",
      "@CQ",
      "@HB",
      "@QSO",
      "@QSOPARTY",
      "@CONTEST",
      "@FIELDDAY",
      "@SOTA",
      "@IOTA",
      "@POTA",
      "@QRP",
      "@QRO",
    ] as const
  ).map((name, i) => [name, NBASECALL + 1 + i] as [string, number]),
);
const SORTED_BASECALL_KEYS = [...BASECALLS.keys()].sort();

/** CQ variants carried in the 3 spare bits of an "alt" heartbeat. */
const CQS = ["CQ CQ CQ", "CQ DX", "CQ QRP", "CQ CONTEST", "CQ FIELD", "CQ FD", "CQ CQ", "CQ"];
// status flags in HBs are deprecated as of 2.2; all eight values render as "HB"
const HBS = ["HB", "HB", "HB", "HB", "HB", "HB", "HB", "HB"];

/** QMap<quint32,QString>::key(value, default) */
function listKey(list: readonly string[], value: string, dflt: number): number {
  const i = list.indexOf(value);
  return i < 0 ? dflt : i;
}

const DBM2MW: ReadonlyMap<number, number> = new Map([
  [0, 1],
  [3, 2],
  [7, 5],
  [10, 10],
  [13, 20],
  [17, 50],
  [20, 100],
  [23, 200],
  [27, 500],
  [30, 1000],
  [33, 2000],
  [37, 5000],
  [40, 10000],
  [43, 20000],
  [47, 50000],
  [50, 100000],
  [53, 200000],
  [57, 500000],
  [60, 1000000],
]);

export function mwattsToDbm(mwatts: number): number {
  const values = [...DBM2MW.values()].sort((a, b) => a - b);
  for (const mw of values) {
    if (mw < mwatts) continue;
    for (const [dbm, v] of [...DBM2MW].sort((a, b) => a[0] - b[0])) if (v === mw) return dbm;
  }
  return 0;
}

export function dbmToMwatts(dbm: number): number {
  const exact = DBM2MW.get(dbm);
  if (exact !== undefined) return exact;
  const keys = [...DBM2MW.keys()].sort((a, b) => a - b);
  for (const k of keys) if (k >= dbm) return DBM2MW.get(k)!; // QMap::lowerBound
  return DBM2MW.get(keys[keys.length - 1]!)!;
}

/* ------------------------------------------------------------------------------------------
 * Qt helpers
 * ---------------------------------------------------------------------------------------- */

/** QChar::isSpace */
function isSpace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** QString::trimmed */
function trimmed(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isSpace(s.charCodeAt(a))) a++;
  while (b > a && isSpace(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

/** QList::mid / QString::mid, including Qt's handling of negative lengths. */
function qmid<T>(a: readonly T[], pos: number, len = -1): T[] {
  const size = a.length;
  if (pos > size) return [];
  if (pos < 0) {
    if (len < 0 || len + pos >= size) return a.slice();
    if (len + pos <= 0) return [];
    len += pos;
    pos = 0;
  } else if (len < 0 || len > size - pos) {
    len = size - pos;
  }
  return a.slice(pos, pos + len);
}

/** QString::toInt(&ok, 10): surrounding whitespace allowed, optional sign, int range. */
function qtToInt(s: string): { value: number; ok: boolean } {
  const t = trimmed(s);
  if (!/^[+-]?[0-9]+$/.test(t)) return { value: 0, ok: false };
  const v = Number(t);
  if (!Number.isSafeInteger(v) || v > 2147483647 || v < -2147483648) return { value: 0, ok: false };
  return { value: v, ok: true };
}

/** C++ integer division (truncates toward zero). */
function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

/** QChar::toLatin1 */
function latin1(ch: string): number {
  const c = ch.length > 0 ? ch.charCodeAt(0) : 0;
  return c > 0xff ? 0 : c;
}

/* ------------------------------------------------------------------------------------------
 * Text utilities
 * ---------------------------------------------------------------------------------------- */

export function extendedChars(): string {
  return jscExtendedChars();
}

/** Varicode::escape: characters above U+007F become "\Uxxxx". */
export function escape(text: string): string {
  let escaped = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) escaped += text[i];
    else escaped += "\\U" + code.toString(16).padStart(4, "0");
  }
  return escaped;
}

/** Varicode::unescape: "\Uxxxx", "\uxxxx", "U+xxxx" and "u+xxxx" back to the character. */
export function unescape(text: string): string {
  const re = /(([uU][+]|\\[uU])[0-9a-fA-F]{4})/g;
  let s = text;
  let pos = 0;
  for (;;) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) break;
    const at = m.index;
    const ch = String.fromCharCode(parseInt(m[1]!.slice(-4), 16));
    s = s.slice(0, at) + ch + s.slice(at + 6);
    pos = at + 1;
  }
  return s;
}

export function rstrip(str: string): string {
  for (let n = str.length - 1; n >= 0; n--) {
    if (isSpace(str.charCodeAt(n))) continue;
    return str.slice(0, n + 1);
  }
  return "";
}

export function lstrip(str: string): string {
  for (let n = 0; n < str.length; n++) {
    if (isSpace(str.charCodeAt(n))) continue;
    return str.slice(n);
  }
  return "";
}

export function cqString(number: number): string {
  return CQS[number] ?? "";
}

export function hbString(number: number): string {
  return HBS[number] ?? "";
}

export function startsWithCQ(text: string): boolean {
  return CQS.some((cq) => text.startsWith(cq));
}

export function startsWithHB(text: string): boolean {
  return HBS.some((hb) => text.startsWith(hb));
}

/** "+05", "-12", "+00"; empty outside -60..60. */
export function formatSNR(snr: number): string {
  if (snr < -60 || snr > 60) return "";
  const sign = snr < 0 ? "-" : "+";
  return sign + String(Math.abs(snr)).padStart(2, "0");
}

/* ------------------------------------------------------------------------------------------
 * Checksums: CRC-16/KERMIT and CRC-32/BZIP2 over the local 8-bit encoding, in base 41
 * ---------------------------------------------------------------------------------------- */

function localBytes(input: string): Uint8Array {
  // QString::toLocal8Bit is UTF-8 on Linux/macOS; ASCII text (all JS8 can send) is identical
  // under every code page.
  return new TextEncoder().encode(input);
}

/** CRC-16/KERMIT: poly 0x1021 reflected, init 0, no final xor. */
export function crc16Kermit(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return crc & 0xffff;
}

/** CRC-32/BZIP2: poly 0x04C11DB7 not reflected, init and final xor 0xFFFFFFFF. */
export function crc32Bzip2(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc = (crc ^ (b << 24)) >>> 0;
    for (let k = 0; k < 8; k++) crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function checksum16(input: string): string {
  const checksum = pack16bits(crc16Kermit(localBytes(input)));
  return checksum.length < 3 ? checksum + " ".repeat(3 - checksum.length) : checksum;
}

export function checksum16Valid(checksum: string, input: string): boolean {
  return pack16bits(crc16Kermit(localBytes(input))) === checksum;
}

export function checksum32(input: string): string {
  const checksum = pack32bits(crc32Bzip2(localBytes(input)));
  return checksum.length < 6 ? checksum + " ".repeat(6 - checksum.length) : checksum;
}

export function checksum32Valid(checksum: string, input: string): boolean {
  return pack32bits(crc32Bzip2(localBytes(input))) === checksum;
}

/* ------------------------------------------------------------------------------------------
 * Parsing
 * ---------------------------------------------------------------------------------------- */

export function parseCallsigns(input: string): string[] {
  const callsigns: string[] = [];
  for (const match of input.matchAll(new RegExp(COMPOUND_CALLSIGN_PATTERN, "g"))) {
    const callsign = trimmed(match.groups?.callsign ?? "");
    if (!isValidCallsign(callsign).valid) continue;
    if (GRID_RE.test(callsign)) continue;
    callsigns.push(callsign);
  }
  return callsigns;
}

export function parseGrids(input: string): string[] {
  const grids: string[] = [];
  for (const match of input.matchAll(new RegExp(GRID_PATTERN, "g"))) {
    const grid = match.groups?.grid ?? "";
    if (grid === "RR73") continue;
    grids.push(grid);
  }
  return grids;
}

/* ------------------------------------------------------------------------------------------
 * Bits
 * ---------------------------------------------------------------------------------------- */

export type Bits = boolean[];

/** Varicode::intToBits: big-endian bits, left-padded to `expected` but never truncated. */
export function intToBits(value: number | bigint, expected = 0): Bits {
  const bits: Bits = [];
  let v = BigInt.asUintN(64, BigInt(value));
  while (v) {
    bits.unshift((v & 1n) === 1n);
    v >>= 1n;
  }
  while (expected && bits.length < expected) bits.unshift(false);
  return bits;
}

/** Varicode::bitsToInt over [start, start+n), wrapping to 64 bits like quint64. */
export function bitsToInt(bits: readonly boolean[], start = 0, n = bits.length - start): bigint {
  let v = 0n;
  for (let i = 0; i < n; i++) v = BigInt.asUintN(64, (v << 1n) + (bits[start + i] ? 1n : 0n));
  return v;
}

export function strToBits(bitvec: string): Bits {
  return [...bitvec].map((ch) => ch === "1");
}

export function bitsToStr(bitvec: readonly boolean[]): string {
  return bitvec.map((b) => (b ? "1" : "0")).join("");
}

export function bytesToBits(bytes: ArrayLike<number>): Bits {
  return Array.from(bytes, (b) => b === 1);
}

/* ------------------------------------------------------------------------------------------
 * Base-41 and base-64 packers
 * ---------------------------------------------------------------------------------------- */

export function unpack5bits(value: string): number {
  return ALPHABET.indexOf(value.charAt(0));
}

export function pack5bits(packed: number): string {
  return ALPHABET.charAt((packed & 0xff) % 32);
}

export function unpack6bits(value: string): number {
  return ALPHABET.indexOf(value.charAt(0));
}

export function pack6bits(packed: number): string {
  return ALPHABET.charAt((packed & 0xff) % 41);
}

export function unpack16bits(value: string): number {
  const a = ALPHABET.indexOf(value.charAt(0));
  const b = ALPHABET.indexOf(value.charAt(1));
  const c = ALPHABET.indexOf(value.charAt(2));
  const unpacked = NALPHABET * NALPHABET * a + NALPHABET * b + c;
  // base 41 can exceed 16 bits ("???" == 70643)
  if (unpacked > (1 << 16) - 1) return 0;
  return unpacked & 0xffff;
}

export function pack16bits(packed: number): string {
  packed &= 0xffff;
  let out = "";
  let tmp = idiv(packed, NALPHABET * NALPHABET);
  out += ALPHABET.charAt(tmp);
  tmp = idiv(packed - tmp * (NALPHABET * NALPHABET), NALPHABET);
  out += ALPHABET.charAt(tmp);
  tmp = packed % NALPHABET;
  out += ALPHABET.charAt(tmp);
  return out;
}

export function unpack32bits(value: string): number {
  return ((unpack16bits(value.slice(0, 3)) << 16) | unpack16bits(value.slice(-3))) >>> 0;
}

export function pack32bits(packed: number): string {
  packed >>>= 0;
  return pack16bits(packed >>> 16) + pack16bits(packed & 0xffff);
}

export function unpack64bits(value: string): bigint {
  return (BigInt(unpack32bits(value.slice(0, 6))) << 32n) | BigInt(unpack32bits(value.slice(-6)));
}

export function pack64bits(packed: bigint): string {
  packed = BigInt.asUintN(64, packed);
  return pack32bits(Number(packed >> 32n)) + pack32bits(Number(packed & 0xffffffffn));
}

/** First 64 bits of a 12-character frame, and the last 8 bits as `rem`. */
export function unpack72bits(text: string): { value: bigint; rem: number } {
  let value = 0n;
  for (let i = 0; i < 10; i++) {
    const idx = ALPHABET72.indexOf(text.charAt(i));
    value |= BigInt.asUintN(64, BigInt(idx) << BigInt(58 - 6 * i));
  }
  const remHigh = ALPHABET72.indexOf(text.charAt(10)) & 0xff;
  value |= BigInt(remHigh >> 2);
  const remLow = ALPHABET72.indexOf(text.charAt(11)) & 0xff;
  const rem = (((remHigh & 3) << 6) | remLow) & 0xff;
  return { value, rem };
}

export function pack72bits(value: bigint, rem: number): string {
  value = BigInt.asUintN(64, value);
  rem &= 0xff;
  const packed: string[] = new Array<string>(12);
  const remHigh = ((Number(value & 0xfn) << 2) | (rem >> 6)) & 0xff;
  const remLow = rem & 0x3f;
  value >>= 4n;
  packed[11] = ALPHABET72.charAt(remLow);
  packed[10] = ALPHABET72.charAt(remHigh);
  for (let i = 0; i < 10; i++) {
    packed[9 - i] = ALPHABET72.charAt(Number(value & 0x3fn));
    value >>= 6n;
  }
  return packed.join("");
}

/* ------------------------------------------------------------------------------------------
 * Alphanumeric, callsign and grid packing
 * ---------------------------------------------------------------------------------------- */

/** Four characters of [A-Z0-9 /] into 21 bits, plus a flag bit. */
export function packAlphaNumeric22(value: string, isFlag: boolean): number {
  let word = value.replace(/[^A-Z0-9/ ]/g, "");
  if (word.length < 4) word = word + " ".repeat(4 - word.length);
  const a = 38 * 38 * 38 * ALPHANUMERIC.indexOf(word.charAt(0));
  const b = 38 * 38 * ALPHANUMERIC.indexOf(word.charAt(1));
  const c = 38 * ALPHANUMERIC.indexOf(word.charAt(2));
  const d = ALPHANUMERIC.indexOf(word.charAt(3));
  const packed = (a + b + c + d) >>> 0;
  return ((packed << 1) + (isFlag ? 1 : 0)) >>> 0;
}

export function unpackAlphaNumeric22(packed: number): { text: string; isFlag: boolean } {
  const isFlag = (packed & 1) === 1;
  packed = packed >>> 1;
  const word: string[] = [];
  for (let i = 3; i >= 0; i--) {
    word[i] = ALPHANUMERIC.charAt(packed % 38);
    packed = Math.floor(packed / 38);
  }
  return { text: word.join(""), isFlag };
}

/**
 * Up to 11 characters of [A-Z0-9 /@] into 50 bits: positions 3 and 7 hold only a "/"-or-space
 * flag, which is how "VE3/LB9YHX" and "KN4CRD/QRP" fit. A non-slash at those positions gets a
 * space inserted so the text shifts right instead of being lost.
 */
export function packAlphaNumeric50(value: string): bigint {
  let word = value.replace(/[^A-Z0-9 /@]/g, "");
  if (word.length > 3 && word[3] !== "/") word = word.slice(0, 3) + " " + word.slice(3);
  if (word.length > 7 && word[7] !== "/") word = word.slice(0, 7) + " " + word.slice(7);
  if (word.length < 11) word = word + " ".repeat(11 - word.length);
  const idx = (i: number) => BigInt(ALPHANUMERIC.indexOf(word.charAt(i)));
  const slash = (i: number) => (word.charAt(i) === "/" ? 1n : 0n);
  const a = 38n * 38n * 38n * 2n * 38n * 38n * 38n * 2n * 38n * 38n * idx(0);
  const b = 38n * 38n * 38n * 2n * 38n * 38n * 38n * 2n * 38n * idx(1);
  const c = 38n * 38n * 38n * 2n * 38n * 38n * 38n * 2n * idx(2);
  const d = 38n * 38n * 38n * 2n * 38n * 38n * 38n * slash(3);
  const e = 38n * 38n * 38n * 2n * 38n * 38n * idx(4);
  const f = 38n * 38n * 38n * 2n * 38n * idx(5);
  const g = 38n * 38n * 38n * 2n * idx(6);
  const h = 38n * 38n * 38n * slash(7);
  const i = 38n * 38n * idx(8);
  const j = 38n * idx(9);
  const k = idx(10);
  return BigInt.asUintN(64, a + b + c + d + e + f + g + h + i + j + k);
}

export function unpackAlphaNumeric50(packed: bigint): string {
  packed = BigInt.asUintN(64, packed);
  const word: string[] = new Array<string>(11);
  const take = (radix: bigint) => {
    const tmp = Number(packed % radix);
    packed = packed / radix;
    return tmp;
  };
  word[10] = ALPHANUMERIC.charAt(take(38n));
  word[9] = ALPHANUMERIC.charAt(take(38n));
  word[8] = ALPHANUMERIC.charAt(take(38n));
  word[7] = take(2n) ? "/" : " ";
  word[6] = ALPHANUMERIC.charAt(take(38n));
  word[5] = ALPHANUMERIC.charAt(take(38n));
  word[4] = ALPHANUMERIC.charAt(take(38n));
  word[3] = take(2n) ? "/" : " ";
  word[2] = ALPHANUMERIC.charAt(take(38n));
  word[1] = ALPHANUMERIC.charAt(take(38n));
  word[0] = ALPHANUMERIC.charAt(take(39n));
  return word.join("").replaceAll(" ", "");
}

/**
 * A standard callsign into 28 bits (the WSJT-X scheme: [0-9A-Z ][0-9A-Z][0-9][A-Z ]{3}), with
 * /P reported separately. Group names and "<....>" use the values above the callsign space.
 * Returns 0 when the call cannot be packed.
 */
export function packCallsign(value: string): { packed: number; portable: boolean } {
  let portable = false;
  let callsign = trimmed(value.toUpperCase());

  const base = BASECALLS.get(callsign);
  if (base !== undefined) return { packed: base, portable };

  if (callsign.endsWith("/P")) {
    callsign = callsign.slice(0, -2);
    portable = true;
  }
  // workaround for Swaziland
  if (callsign.startsWith("3DA0")) callsign = "3D0" + callsign.slice(4);
  // workaround for Guinea
  if (callsign.startsWith("3X") && "A" <= callsign.charAt(2) && callsign.charAt(2) <= "Z") {
    callsign = "Q" + callsign.slice(2);
  }

  const slen = callsign.length;
  if (slen < 2 || slen > 6) return { packed: 0, portable };

  const permutations = [callsign];
  if (slen === 2) permutations.push(" " + callsign + "   ");
  if (slen === 3) permutations.push(" " + callsign + "  ", callsign + "   ");
  if (slen === 4) permutations.push(" " + callsign + " ", callsign + "  ");
  if (slen === 5) permutations.push(" " + callsign, callsign + " ");

  // the last permutation that matches wins (the C++ loop does not break)
  let matched = "";
  for (const permutation of permutations) {
    const m = PACK_CALLSIGN_RE.exec(permutation);
    if (m) matched = m[0];
  }
  if (matched.length < 6) return { packed: 0, portable };

  const at = (i: number) => ALPHANUMERIC.indexOf(matched.charAt(i));
  let packed = at(0);
  packed = 36 * packed + at(1);
  packed = 10 * packed + at(2);
  packed = 27 * packed + at(3) - 10;
  packed = 27 * packed + at(4) - 10;
  packed = 27 * packed + at(5) - 10;
  return { packed: packed >>> 0, portable };
}

export function unpackCallsign(value: number, portable: boolean): string {
  for (const key of SORTED_BASECALL_KEYS) if (BASECALLS.get(key) === value) return key;

  const word: string[] = new Array<string>(6);
  word[5] = ALPHANUMERIC.charAt((value % 27) + 10);
  value = Math.floor(value / 27);
  word[4] = ALPHANUMERIC.charAt((value % 27) + 10);
  value = Math.floor(value / 27);
  word[3] = ALPHANUMERIC.charAt((value % 27) + 10);
  value = Math.floor(value / 27);
  word[2] = ALPHANUMERIC.charAt(value % 10);
  value = Math.floor(value / 10);
  word[1] = ALPHANUMERIC.charAt(value % 36);
  value = Math.floor(value / 36);
  word[0] = ALPHANUMERIC.charAt(value);

  let callsign = word.join("");
  if (callsign.startsWith("3D0")) callsign = "3DA0" + callsign.slice(3);
  if (callsign.startsWith("Q") && "A" <= callsign.charAt(1) && callsign.charAt(1) <= "Z") {
    callsign = "3X" + callsign.slice(1);
  }
  if (portable) callsign = trimmed(callsign) + "/P";
  return trimmed(callsign);
}

/** Six-character Maidenhead locator for a position (subsquare in lower case). */
export function deg2grid(dlong: number, dlat: number): string {
  dlong = Math.fround(dlong);
  dlat = Math.fround(dlat);
  if (dlong < -180) dlong = Math.fround(dlong + 360);
  if (dlong > 180) dlong = Math.fround(dlong - 360);

  const nlong = Math.trunc((60.0 * (180.0 - dlong)) / 5);
  let n1 = idiv(nlong, 240);
  let n2 = idiv(nlong - 240 * n1, 24);
  let n3 = nlong - 240 * n1 - 24 * n2;
  const g: string[] = new Array<string>(6);
  g[0] = String.fromCharCode(65 + n1);
  g[2] = String.fromCharCode(48 + n2);
  g[4] = String.fromCharCode(97 + n3);

  const nlat = Math.trunc((60.0 * Math.fround(dlat + 90)) / 2.5);
  n1 = idiv(nlat, 240);
  n2 = idiv(nlat - 240 * n1, 24);
  n3 = nlat - 240 * n1 - 24 * n2;
  g[1] = String.fromCharCode(65 + n1);
  g[3] = String.fromCharCode(48 + n2);
  g[5] = String.fromCharCode(97 + n3);
  return g.join("");
}

/** Centre of a locator as [longitude, latitude], computed in float like the C++. */
export function grid2deg(grid: string): [number, number] {
  let g = grid;
  if (g.length < 6) g = grid.slice(0, 4) + "mm";
  g = g.slice(0, 4).toUpperCase() + g.slice(-2).toLowerCase();

  const nlong = 180 - 20 * (latin1(g.charAt(0)) - 65);
  const n20d = 2 * (latin1(g.charAt(2)) - 48);
  const xminlong = Math.fround(5 * (latin1(g.charAt(4)) - 97 + 0.5));
  const dlong = Math.fround(nlong - n20d - xminlong / 60.0);

  const nlat = -90 + 10 * (latin1(g.charAt(1)) - 65) + latin1(g.charAt(3)) - 48;
  const xminlat = Math.fround(2.5 * (latin1(g.charAt(5)) - 97 + 0.5));
  const dlat = Math.fround(nlat + xminlat / 60.0);
  return [dlong, dlat];
}

/** A 4-character locator into 15 bits (180 x 180 two-degree by one-degree cells); 32767 = none. */
export function packGrid(value: string): number {
  const grid = trimmed(value);
  if (grid.length < 4) return (1 << 15) - 1;
  const [lon, lat] = grid2deg(grid.slice(0, 4));
  const ilong = Math.trunc(lon);
  const ilat = Math.trunc(Math.fround(lat + 90));
  return (idiv(ilong + 180, 2) * 180 + ilat) & 0xffff;
}

export function unpackGrid(value: number): string {
  if (value > NBASEGRID) return "";
  const dlat = (value % 180) - 90;
  const dlong = idiv(value, 180) * 2 - 180 + 2;
  return deg2grid(dlong, dlat).slice(0, 4);
}

/** A number or SNR (-30..31) into 1..62; 0 means "no number". */
export function packNum(num: string): { value: number; ok: boolean } {
  if (num.length === 0) return { value: 0, ok: false };
  const { value, ok } = qtToInt(num);
  const inum = Math.max(-30, Math.min(value, 31));
  return { value: (inum + 30 + 1) & 0xff, ok };
}

/**
 * A command and number in the 8 spare values above the grid space of a compound frame.
 * SNR commands set the top bit and keep a 6-bit number; anything else keeps 7 command bits.
 */
export function packCmd(cmd: number, num: number): { value: number; packedNum: boolean } {
  cmd &= 0xff;
  const cmdStr = directedCmdKey(cmd);
  if (isSNRCommand(cmdStr)) {
    let value = ((1 << 1) | (cmdStr === " HEARTBEAT SNR" ? 1 : 0)) << 6;
    value = (value + (num & 0x3f)) & 0xff;
    return { value, packedNum: true };
  }
  return { value: cmd & 0x7f, packedNum: false };
}

export function unpackCmd(value: number): { cmd: number; num: number } {
  value &= 0xff;
  if (value & (1 << 7)) {
    // numbers on ACKs were deprecated in 2.2, so only the two SNR commands remain here
    const cmd = value & (1 << 6) ? DIRECTED_CMDS.get(" HEARTBEAT SNR")! : DIRECTED_CMDS.get(" SNR")!;
    return { cmd, num: value & 0x3f };
  }
  return { cmd: value & 0x7f, num: 0 };
}

export function isSNRCommand(cmd: string): boolean {
  const v = DIRECTED_CMDS.get(cmd);
  return v !== undefined && SNR_CMDS.has(v);
}

export function isCommandAllowed(cmd: string): boolean {
  const v = DIRECTED_CMDS.get(cmd);
  return v !== undefined && ALLOWED_CMDS.has(v);
}

/**
 * Varicode::isCommandBuffered. Note the original also counts any command containing a space,
 * which is nearly all of them; that only causes the text after the command to be lstripped.
 */
export function isCommandBuffered(cmd: string): boolean {
  const v = DIRECTED_CMDS.get(cmd);
  return v !== undefined && (cmd.includes(" ") || BUFFERED_CMDS.has(v));
}

/** Checksum size in bits (16, 32) for a buffered command, 0 when none. */
export function isCommandChecksumed(cmd: string): number {
  const v = DIRECTED_CMDS.get(cmd);
  if (v === undefined) return 0;
  return CHECKSUM_CMDS.get(v) ?? 0;
}

export function isCommandAutoreply(cmd: string): boolean {
  const v = DIRECTED_CMDS.get(cmd);
  return v !== undefined && AUTOREPLY_CMDS.has(v);
}

function isValidCompoundCallsign(callsign: string): boolean {
  // compound calls cannot be more than 9 characters once the slashes are removed
  const slashes = callsign.split("/").length - 1;
  if (callsign.length - slashes > 9) return false;
  // valid when it is an actual compound (contains /) whose first part is not a group, a
  // group call (@...), or longer than two characters with a letter/digit pair, so that
  // ordinary short words are not coded as callsigns
  const index = callsign.indexOf("/");
  if (index !== -1) return !BASECALLS.has(callsign.slice(0, index));
  if (callsign.startsWith("@")) return true;
  return callsign.length > 2 && ALNUM_PAIR_RE.test(callsign);
}

export function isValidCallsign(callsign: string): { valid: boolean; isCompound: boolean } {
  if (BASECALLS.has(callsign)) return { valid: true, isCompound: false };

  let m = BASE_CALLSIGN_RE.exec(callsign);
  if (m && m[0].length === callsign.length) {
    return { valid: callsign.length > 2 && ALNUM_PAIR_RE.test(callsign), isCompound: false };
  }

  m = COMPOUND_CALLSIGN_ANCHORED_RE.exec(callsign);
  if (m && m[0].length === callsign.length) {
    const valid = isValidCompoundCallsign(m[0]);
    return { valid, isCompound: valid };
  }
  return { valid: false, isCompound: false };
}

export function isCompoundCallsign(callsign: string): boolean {
  if (BASECALLS.has(callsign) && !callsign.startsWith("@")) return false;

  let m = BASE_CALLSIGN_RE.exec(callsign);
  if (m && m[0].length === callsign.length) return false;

  m = COMPOUND_CALLSIGN_ANCHORED_RE.exec(callsign);
  if (!m || m[0].length !== callsign.length) return false;
  return isValidCompoundCallsign(m[0]);
}

export function isGroupAllowed(group: string): boolean {
  return group !== "@APRSIS" && group !== "@JS8NET";
}

/* ------------------------------------------------------------------------------------------
 * Frame packers
 * ---------------------------------------------------------------------------------------- */

export interface Packed {
  /** 12-character frame, or "" when the text does not fit this frame type. */
  frame: string;
  /** Characters of the input consumed by the frame (0 = not this frame type). */
  n: number;
}

/** "HB EM73", "@HB HEARTBEAT EM73", "CQ DX EM73", "@ALLCALL CQ CQ CQ EM73" */
export function packHeartbeatMessage(text: string, callsign: string): Packed {
  const parsed = HEARTBEAT_RE.exec(text);
  if (!parsed) return { frame: "", n: 0 };

  const extra = parsed.groups?.grid ?? "";
  // alt (bit 15 of the extra field): 0 = HB, 1 = CQ
  const type = parsed.groups?.type ?? "";
  const isAlt = type.startsWith("CQ");

  if (callsign.length === 0) return { frame: "", n: 0 };

  let packedExtra = NMAXGRID; // displays as no grid
  if (extra.length === 4 && GRID_RE.test(extra)) packedExtra = packGrid(extra);

  let cqNumber = listKey(HBS, type, 0);
  if (isAlt) {
    packedExtra |= 1 << 15;
    cqNumber = listKey(CQS, type, 0);
  }

  const frame = packCompoundFrame(callsign, FrameType.Heartbeat, packedExtra, cqNumber);
  if (frame.length === 0) return { frame: "", n: 0 };
  return { frame, n: parsed[0].length };
}

export interface UnpackedHeartbeat {
  /** [callsign, "", grid] */
  parts: string[];
  type: number;
  isAlt: boolean;
  bits3: number;
}

export function unpackHeartbeatMessage(text: string): UnpackedHeartbeat | null {
  const u = unpackCompoundFrame(text);
  if (!u || u.type !== FrameType.Heartbeat) return null;
  const parts = [...u.parts, unpackGrid(u.num & 0x7fff)];
  return { parts, type: u.type, isAlt: (u.num & (1 << 15)) !== 0, bits3: u.bits3 };
}

/** "`KN4CRD/P EM73", "`VE3/K1ABC SNR?" (compound callsign with a grid or a command) */
export function packCompoundMessage(text: string): Packed {
  const parsed = COMPOUND_RE.exec(text);
  if (!parsed) return { frame: "", n: 0 };

  const callsign = parsed.groups?.callsign ?? "";
  const grid = parsed.groups?.grid ?? "";
  const cmd = parsed.groups?.cmd ?? "";
  const num = trimmed(parsed.groups?.num ?? "");

  if (callsign.length === 0) return { frame: "", n: 0 };

  let type: number = FrameType.Compound;
  let extra = NMAXGRID;

  if (cmd.length > 0 && DIRECTED_CMDS.has(cmd) && isCommandAllowed(cmd)) {
    const inum = packNum(num).value;
    extra = NUSERGRID + packCmd(DIRECTED_CMDS.get(cmd)!, inum).value;
    type = FrameType.CompoundDirected;
  } else if (grid.length > 0) {
    extra = packGrid(grid);
  }

  // n is reported even if the frame comes back empty, as in the C++
  return { frame: packCompoundFrame(callsign, type, extra, 0), n: parsed[0].length };
}

export interface UnpackedCompound {
  /** [callsign, "", then " GRID" or command text (+ formatted SNR)] */
  parts: string[];
  type: number;
  bits3: number;
  /** The raw 16-bit extra field (grid, or NUSERGRID + packed command). */
  extra: number;
}

export function unpackCompoundMessage(text: string): UnpackedCompound | null {
  const u = unpackCompoundFrame(text);
  if (!u || (u.type !== FrameType.Compound && u.type !== FrameType.CompoundDirected)) return null;
  const parts = [...u.parts];
  const extra = u.num;
  if (extra <= NBASEGRID) {
    parts.push(" " + unpackGrid(extra));
  } else if (NUSERGRID <= extra && extra < NMAXGRID) {
    // above the user grid reference the field holds a command
    const { cmd, num } = unpackCmd((extra - NUSERGRID) & 0xff);
    const cmdStr = directedCmdKey(cmd);
    parts.push(cmdStr);
    if (isSNRCommand(cmdStr)) parts.push(formatSNR(num - 31));
  }
  return { parts, type: u.type, bits3: u.bits3, extra };
}

/** [3 type][50 callsign][11 high bits of num],[5 low bits of num][3 bits3] */
export function packCompoundFrame(callsign: string, type: number, num: number, bits3: number): string {
  // needs to be a compound type
  if (type === FrameType.Data || type === FrameType.Directed) return "";

  const packedFlag = type & 0xff;
  const packedCallsign = packAlphaNumeric50(callsign);
  if (packedCallsign === 0n) return "";

  num &= 0xffff;
  const mask11 = ((1 << 11) - 1) << 5;
  const packed11 = (num & mask11) >> 5;
  const packed5 = num & 0x1f;
  const packed8 = ((packed5 << 3) | bits3) & 0xff;

  const bits = [...intToBits(packedFlag, 3), ...intToBits(packedCallsign, 50), ...intToBits(packed11, 11)];
  return pack72bits(bitsToInt(bits), packed8);
}

export interface UnpackedCompoundFrame {
  /** [callsign, ""] */
  parts: string[];
  type: number;
  num: number;
  bits3: number;
}

export function unpackCompoundFrame(text: string): UnpackedCompoundFrame | null {
  if (text.length < 12 || text.includes(" ")) return null;
  const { value, rem: packed8 } = unpack72bits(text);
  const bits = intToBits(value, 64);
  const packed5 = packed8 >> 3;
  const packed3 = packed8 & 7;

  const packedFlag = Number(bitsToInt(qmid(bits, 0, 3)));
  // needs to be a compound/heartbeat type
  if (packedFlag === FrameType.Data || packedFlag === FrameType.Directed) return null;

  const packedCallsign = bitsToInt(qmid(bits, 3, 50));
  const packed11 = Number(bitsToInt(qmid(bits, 53, 11)));
  const callsign = unpackAlphaNumeric50(packedCallsign);
  const num = ((packed11 << 5) | packed5) & 0xffff;
  return { parts: [callsign, ""], type: packedFlag & 0xff, num, bits3: packed3 };
}

export interface PackedDirected extends Packed {
  /** The "to" callsign as written (set once it has been validated, even if packing later fails). */
  to: string;
  toCompound: boolean;
  /** The command key actually packed (e.g. " SNR?"); set only on success. */
  cmd: string;
  /** The number text as matched (e.g. " -12"); set when it parsed as a number. */
  num: string;
}

/** "J1Y ACK", "J1Y?", "K1ABC SNR -12", "K1ABC>W9XYZ MSG ..." sent by `mycall`. */
export function packDirectedMessage(text: string, mycall: string): PackedDirected {
  const out: PackedDirected = { frame: "", n: 0, to: "", toCompound: false, cmd: "", num: "" };
  const match = DIRECTED_RE.exec(text);
  if (!match) return out;

  let from = mycall;
  if (isCompoundCallsign(from)) from = "<....>";
  let to = match.groups?.callsign ?? "";
  const cmd = match.groups?.cmd ?? "";
  const num = match.groups?.num ?? "";

  // ensure we have a directed command
  if (cmd.length === 0) return out;

  // ensure we have a valid callsign
  let isToCompound = false;
  let validToCallsign = false;
  if (to !== mycall) {
    const v = isValidCallsign(to);
    validToCallsign = v.valid;
    isToCompound = v.isCompound;
  }
  if (!validToCallsign) return out;

  out.to = to;
  out.toCompound = isToCompound;

  // a compound "to" is sent in its own compound frame later; pack a placeholder here
  if (isToCompound) to = "<....>";

  if (!isCommandAllowed(cmd) && !isCommandAllowed(trimmed(cmd))) return out;

  const { value: inum, ok: numOK } = packNum(trimmed(num));
  if (numOK) out.num = num;

  const pf = packCallsign(from);
  const pt = packCallsign(to);
  if (pf.packed === 0 || pt.packed === 0) return out;

  let cmdOut = "";
  let packedCmd = 0;
  if (DIRECTED_CMDS.has(cmd)) {
    cmdOut = cmd;
    packedCmd = DIRECTED_CMDS.get(cmd)! & 0xff;
  }
  if (DIRECTED_CMDS.has(trimmed(cmd))) {
    cmdOut = trimmed(cmd);
    packedCmd = DIRECTED_CMDS.get(cmdOut)! & 0xff;
  }
  const packedExtra = (((pf.portable ? 1 : 0) << 7) + ((pt.portable ? 1 : 0) << 6) + inum) & 0xff;

  // [3][28][28][5],[2][6] = 72
  const bits = [
    ...intToBits(FrameType.Directed, 3),
    ...intToBits(pf.packed, 28),
    ...intToBits(pt.packed, 28),
    ...intToBits(packedCmd % 32, 5),
  ];
  out.cmd = cmdOut;
  out.n = match[0].length;
  out.frame = pack72bits(bitsToInt(bits), packedExtra);
  return out;
}

export interface UnpackedDirected {
  /** [from, to, cmd, (num)] */
  parts: string[];
  type: number;
}

export function unpackDirectedMessage(text: string): UnpackedDirected | null {
  if (text.length < 12 || text.includes(" ")) return null;
  const { value, rem } = unpack72bits(text);
  const bits = intToBits(value, 64);

  const packedFlag = Number(bitsToInt(qmid(bits, 0, 3)));
  if (packedFlag !== FrameType.Directed) return null;

  const packedFrom = Number(bitsToInt(qmid(bits, 3, 28)));
  const packedTo = Number(bitsToInt(qmid(bits, 31, 28)));
  const packedCmd = Number(bitsToInt(qmid(bits, 59, 5)));

  const portableFrom = ((rem >> 7) & 1) === 1;
  const portableTo = ((rem >> 6) & 1) === 1;
  const extra = rem % 64;

  const from = unpackCallsign(packedFrom, portableFrom);
  const to = unpackCallsign(packedTo, portableTo);
  const cmd = directedCmdKey(packedCmd % 32);

  const parts = [from, to, cmd];
  if (extra !== 0) {
    if (isSNRCommand(cmd)) parts.push(formatSNR(extra - 31));
    else parts.push(String(extra - 31));
  }
  return { parts, type: packedFlag };
}

/* ------------------------------------------------------------------------------------------
 * Data frames
 * ---------------------------------------------------------------------------------------- */

export function huffValidChars(huff: ReadonlyMap<string, string> = HUFF_TABLE): Set<string> {
  return new Set(huff.keys());
}

export function huffEncode(huff: ReadonlyMap<string, string>, text: string): { chars: number; bits: Bits }[] {
  const out: { chars: number; bits: Bits }[] = [];
  // longest keys first, then reverse order
  const keys = [...huff.keys()].sort((a, b) => {
    if (b.length < a.length) return -1;
    if (a.length < b.length) return 1;
    return b < a ? -1 : b > a ? 1 : 0;
  });
  let i = 0;
  while (i < text.length) {
    let found = false;
    for (const ch of keys) {
      if (text.startsWith(ch, i)) {
        out.push({ chars: ch.length, bits: strToBits(huff.get(ch)!) });
        i += ch.length;
        found = true;
        break;
      }
    }
    if (!found) i++;
  }
  return out;
}

export function huffDecode(huff: ReadonlyMap<string, string>, bitvec: readonly boolean[]): string {
  let text = "";
  let bits = bitsToStr(bitvec);
  const keys = [...huff.keys()].sort(); // QMap key order
  while (bits.length > 0) {
    let found = false;
    // the C++ keeps scanning the remaining keys after a match instead of restarting
    for (const key of keys) {
      const code = huff.get(key)!;
      if (bits.startsWith(code)) {
        if (key === EOT) {
          text += " ";
          found = false;
          break;
        }
        text += key;
        bits = bits.slice(code.length);
        found = true;
      }
    }
    if (!found) break;
  }
  return text;
}

const FRAME_SIZE = 72;

/** Pad to 72 bits with a 0 then 1s, so the receiver can find the end from the last 0. */
function padAndPack(frameBits: Bits): string {
  const pad = FRAME_SIZE - frameBits.length;
  for (let i = 0; i < pad; i++) frameBits.push(i !== 0);
  return pack72bits(bitsToInt(frameBits, 0, 64), Number(bitsToInt(frameBits, 64, 8)) & 0xff);
}

function packHuffMessage(input: string, prefix: readonly boolean[]): Packed {
  const frameBits: Bits = [...prefix];
  const validChars = huffValidChars(HUFF_TABLE);
  for (const ch of input) {
    // QChar::toUpper maps one UTF-16 unit to one
    const up = ch.toUpperCase();
    if (!validChars.has(up.length === ch.length ? up : ch)) return { frame: "", n: 0 };
  }
  let i = 0;
  for (const pair of huffEncode(HUFF_TABLE, input)) {
    if (frameBits.length + pair.bits.length < FRAME_SIZE) {
      frameBits.push(...pair.bits);
      i += pair.chars;
      continue;
    }
    break;
  }
  return { frame: padAndPack(frameBits), n: i };
}

function packCompressedMessage(input: string, prefix: readonly boolean[]): Packed {
  const frameBits: Bits = [...prefix];
  let i = 0;
  for (const pair of jscCompress(input)) {
    if (frameBits.length + pair.bits.length < FRAME_SIZE) {
      frameBits.push(...pair.bits);
      i += pair.chars;
      continue;
    }
    break;
  }
  return { frame: padAndPack(frameBits), n: i };
}

/**
 * Normal-submode data frame (deprecated in 2.2 but still what Normal sends): Huffman with
 * prefix 10 or JSC with prefix 11, whichever carries more characters (JSC on a tie).
 */
export function packDataMessage(input: string): Packed {
  const huff = packHuffMessage(input, [true, false]);
  const compressed = packCompressedMessage(input, [true, true]);
  return huff.n > compressed.n ? huff : compressed;
}

export function unpackDataMessage(text: string): string {
  if (text.length < 12 || text.includes(" ")) return "";
  const { value, rem } = unpack72bits(text);
  let bits = [...intToBits(value, 64), ...intToBits(rem, 8)];

  const isData = bits[0];
  if (!isData) return "";
  bits = qmid(bits, 1);
  const compressed = bits[0];
  const n = bits.lastIndexOf(false);
  // trim off the pad bits
  bits = qmid(bits, 1, n - 1);
  // compressed = (s,c)-dense coding with the JSC tables; otherwise Huffman
  return compressed ? jscDecompress(bits) : huffDecode(HUFF_TABLE, bits);
}

/** Fast/Turbo/Slow/Ultra data frame: all 72 bits of JSC, flagged by the data bit of i3. */
export function packFastDataMessage(input: string): Packed {
  return packCompressedMessage(input, []);
}

export function unpackFastDataMessage(text: string): string {
  if (text.length < 12 || text.includes(" ")) return "";
  const { value, rem } = unpack72bits(text);
  let bits = [...intToBits(value, 64), ...intToBits(rem, 8)];
  const n = bits.lastIndexOf(false);
  bits = qmid(bits, 0, n);
  return jscDecompress(bits);
}

/* ------------------------------------------------------------------------------------------
 * Message <-> frames
 * ---------------------------------------------------------------------------------------- */

export interface TxFrame {
  /** 12 characters of ALPHABET72 ("" only in a corner case JS8Call also produces). */
  frame: string;
  /** Transmission type bits (TransmissionType flags). */
  i3: number;
}

/** Varicode::MessageInfo, plus any text the coders could not represent. */
export interface MessageInfo {
  dirTo: string;
  dirCmd: string;
  dirNum: string;
  /**
   * Text left over when no frame type could encode it (e.g. lower case or characters outside
   * the dictionary). JS8Call's loop would spin forever on such input; the port stops instead.
   */
  unencoded: string;
}

/**
 * Varicode::buildMessageFrames: split one message into frames in send order.
 *
 * The first frame that parses as a heartbeat, compound or directed message is sent as that
 * type; after a directed frame (or once any data frame is sent) everything else goes out as
 * data frames. Compound callsigns on either end add a compound frame for our call plus a
 * compound-directed frame for theirs. Buffered commands (MSG, relay ">", QUERY ...) get a
 * checksum appended to their text. The first frame is flagged First and the last Last.
 */
export function buildMessageFramesWithInfo(
  mycall: string,
  mygrid: string,
  selectedCall: string,
  text: string,
  forceIdentify: boolean,
  forceData: boolean,
  submode: number,
): { frames: TxFrame[]; info: MessageInfo } {
  const info: MessageInfo = { dirTo: "", dirCmd: "", dirNum: "", unencoded: "" };
  const mycallCompound = isCompoundCallsign(mycall);
  const allFrames: TxFrame[] = [];
  const lines = [text]; // JS8_NO_MULTILINE is not defined: the whole text is one line

  for (let line of lines) {
    const lineFrames: TxFrame[] = [];
    // once we find a directed call, data encode the rest of the line; same once data is sent
    let hasDirected = false;
    let hasData = false;
    if (forceData) {
      forceIdentify = false;
      hasData = true;
    }

    // AUTO_REMOVE_MYCALL: drop our own callsign from the start of the line
    if (line.startsWith(mycall + ":") || line.startsWith(mycall + " ")) {
      line = lstrip(line.slice(mycall.length + 1));
    }

    // AUTO_PREPEND_DIRECTED: address the line to the selected call unless it already starts
    // with that call, a group/CQ/HB, or another real callsign, or is raw ("`") or forced data
    if (selectedCall.length > 0 && !line.startsWith(selectedCall) && !line.startsWith("`") && !forceData) {
      const lineStartsWithBaseCall = line.startsWith("@ALLCALL") || startsWithCQ(line) || startsWithHB(line);
      const calls = parseCallsigns(line);
      const first = calls[0];
      const lineStartsWithStandardCall = first !== undefined && line.startsWith(first) && first.length > 3;
      if (!(lineStartsWithBaseCall || lineStartsWithStandardCall)) {
        const sep = line.startsWith(" ") ? "" : " ";
        line = `${selectedCall}${sep}${line}`;
      }
    }

    while (line.length > 0) {
      let frame = "";
      let useBcn = false;
      let useCmp = false;
      let useDir = false;
      let useDat = false;

      const bcn = packHeartbeatMessage(line, mycall);
      const l = bcn.n;
      const cmp = packCompoundMessage(line);
      const o = cmp.n;
      const dir = packDirectedMessage(line, mycall);
      const n = dir.n;
      const dirTo = dir.to;
      const dirCmd = dir.cmd;
      const dirNum = dir.num;

      // ALLOW_FORCE_IDENTIFY: make sure a bare data message carries our callsign
      const isLikelyDataFrame = lineFrames.length === 0 && selectedCall.length === 0 && dirTo.length === 0 && l === 0 && o === 0;
      if (forceIdentify && isLikelyDataFrame && !line.includes(mycall)) {
        line = `${mycall}: ${line}`;
      }

      let fastDataFrame = false;
      let dat: Packed;
      if (submode === Submode.Normal) {
        dat = packDataMessage(line);
        fastDataFrame = false;
      } else {
        dat = packFastDataMessage(line);
        fastDataFrame = true;
      }
      const m = dat.n;

      if (!hasDirected && !hasData && l > 0) {
        useBcn = true;
        hasDirected = false;
        frame = bcn.frame;
      } else if (!hasDirected && !hasData && o > 0) {
        useCmp = true;
        hasDirected = false;
        frame = cmp.frame;
      } else if (!hasDirected && !hasData && n > 0) {
        useDir = true;
        hasDirected = true;
        frame = dir.frame;
      } else if (m > 0) {
        useDat = true;
        hasData = true;
        frame = dat.frame;
      }

      if (useBcn) {
        lineFrames.push({ frame, i3: TransmissionType.Normal });
        line = line.slice(l);
      }

      if (useCmp) {
        lineFrames.push({ frame, i3: TransmissionType.Normal });
        line = line.slice(o);
      }

      if (useDir) {
        let shouldUseStandardFrame = true;
        // compound from and/or to: <MYCALL/P GRID> then <TOCALL CMD> (or <....>-style)
        if (mycallCompound || dir.toCompound) {
          const deCompound = packCompoundMessage(`\`${mycall} ${mygrid}`).frame;
          if (deCompound.length > 0) lineFrames.push({ frame: deCompound, i3: TransmissionType.Normal });
          const dirCompound = packCompoundMessage(`\`${dirTo}${dirCmd}${dirNum}`).frame;
          if (dirCompound.length > 0) lineFrames.push({ frame: dirCompound, i3: TransmissionType.Normal });
          shouldUseStandardFrame = false;
        }
        if (shouldUseStandardFrame) lineFrames.push({ frame, i3: TransmissionType.Normal });

        line = line.slice(n);

        // checksum the text that follows a buffered command
        if (isCommandBuffered(dirCmd) && line.length > 0) {
          line = lstrip(line);
          const skipAprsChecksum = dirTo.toUpperCase() === "@APRSIS" && (dirCmd === " MSG" || dirCmd === " MSG TO:");
          const checksumSize = skipAprsChecksum ? 0 : isCommandChecksumed(dirCmd);
          if (checksumSize === 32) line = line + " " + checksum32(line);
          else if (checksumSize === 16) line = line + " " + checksum16(line);
        }

        info.dirCmd = dirCmd;
        info.dirTo = dirTo;
        info.dirNum = dirNum;
      }

      if (useDat) {
        lineFrames.push({ frame, i3: fastDataFrame ? TransmissionType.Data : TransmissionType.Normal });
        line = line.slice(m);
      }

      if (!useBcn && !useCmp && !useDir && !useDat) {
        info.unencoded = line;
        break;
      }
    }

    if (lineFrames.length > 0) {
      lineFrames[0]!.i3 |= TransmissionType.First;
      lineFrames[lineFrames.length - 1]!.i3 |= TransmissionType.Last;
    }
    allFrames.push(...lineFrames);
  }

  return { frames: allFrames, info };
}

/** buildMessageFrames(mycall, mygrid, selectedCall, text, forceIdentify, forceData, submode) */
export function buildMessageFrames(
  mycall: string,
  mygrid: string,
  selectedCall: string,
  text: string,
  forceIdentify: boolean,
  forceData: boolean,
  submode: number,
): TxFrame[] {
  return buildMessageFramesWithInfo(mycall, mygrid, selectedCall, text, forceIdentify, forceData, submode).frames;
}

/* ------------------------------------------------------------------------------------------
 * Receive side (DecodedText.cpp)
 * ---------------------------------------------------------------------------------------- */

export interface DecodedFrame {
  frame: string;
  i3: number;
  submode: number;
  /** FrameType; Unknown when nothing could unpack the frame. */
  frameType: number;
  /** The text JS8Call displays for this frame (frames of a message are simply concatenated). */
  message: string;
  isFirst: boolean;
  isLast: boolean;
  /** i3 data flag (fast-submode data frame). */
  isDataFlag: boolean;
  isHeartbeat: boolean;
  /** Heartbeat with the alt bit: a CQ rather than an HB. */
  isAlt: boolean;
  /** DecodedText::compoundCall(): the callsign carried by a heartbeat/compound frame. */
  compound: string;
  /** DecodedText::extra() */
  extra: string;
  /** DecodedText::directedMessage(): [from, to, cmd, (num)]; from is "<....>" for compound-directed. */
  directed: string[];
  isDirected: boolean;
  /** Structured fields, where the frame carries them. Commands keep JS8Call's key form (" SNR?"). */
  from?: string;
  to?: string;
  cmd?: string;
  num?: string;
  snr?: number;
  grid?: string;
  /** Heartbeat CQ text (alt) or "HEARTBEAT". */
  hb?: string;
  bits3?: number;
  /** Text of a data frame. */
  data?: string;
}

function buildCompound(parts: readonly string[]): string {
  return parts
    .slice(0, 2)
    .filter((p) => p !== "")
    .join("/");
}

/**
 * Interpret a received 12-character frame and its i3 bits the way DecodedText does: try fast
 * data (only with the data flag), then data, heartbeat, compound and directed, in that order.
 */
export function unpackFrame(frame: string, i3: number, submode = 0): DecodedFrame {
  const out: DecodedFrame = {
    frame,
    i3,
    submode,
    frameType: FrameType.Unknown,
    message: frame,
    isFirst: (i3 & TransmissionType.First) !== 0,
    isLast: (i3 & TransmissionType.Last) !== 0,
    isDataFlag: (i3 & TransmissionType.Data) !== 0,
    isHeartbeat: false,
    isAlt: false,
    compound: "",
    extra: "",
    directed: [],
    isDirected: false,
  };

  const m = trimmed(frame);
  if (m.length < 12 || m.includes(" ")) return out;
  const dataFlag = (i3 & TransmissionType.Data) === TransmissionType.Data;

  // tryUnpackFastData
  if (dataFlag) {
    const data = unpackFastDataMessage(m);
    if (data.length > 0) {
      out.message = data;
      out.data = data;
      out.frameType = FrameType.Data;
      return out;
    }
  }

  if (!dataFlag) {
    // tryUnpackData
    const data = unpackDataMessage(m);
    if (data.length > 0) {
      out.message = data;
      out.data = data;
      out.frameType = FrameType.Data;
      return out;
    }

    // tryUnpackHeartbeat
    const hb = unpackHeartbeatMessage(m);
    if (hb && hb.parts.length >= 2) {
      out.frameType = hb.type;
      out.isHeartbeat = true;
      out.isAlt = hb.isAlt;
      out.extra = hb.parts[2] ?? "";
      out.compound = buildCompound(hb.parts);
      let message = out.compound + ": ";
      if (hb.isAlt) {
        message += "@ALLCALL " + cqString(hb.bits3);
        out.hb = cqString(hb.bits3);
      } else {
        const sbits3 = hbString(hb.bits3);
        out.hb = sbits3 === "HB" ? "HEARTBEAT" : sbits3;
        message += "@HB " + out.hb;
      }
      message += " " + out.extra + " ";
      out.message = message;
      out.from = out.compound;
      out.to = hb.isAlt ? "@ALLCALL" : "@HB";
      if (out.extra) out.grid = out.extra;
      out.bits3 = hb.bits3;
      return out;
    }

    // tryUnpackCompound
    const cmp = unpackCompoundMessage(m);
    if (cmp && cmp.parts.length >= 2) {
      out.frameType = cmp.type;
      out.extra = cmp.parts.slice(2).join(" ");
      out.compound = buildCompound(cmp.parts);
      out.bits3 = cmp.bits3;
      if (cmp.type === FrameType.Compound) {
        out.message = out.compound + ": ";
        out.from = out.compound;
      } else if (cmp.type === FrameType.CompoundDirected) {
        out.message = out.compound + out.extra + " ";
        out.directed = ["<....>", out.compound, ...cmp.parts.slice(2)];
        out.isDirected = out.directed.length > 2;
        out.from = "<....>";
        out.to = out.compound;
      }
      if (cmp.extra <= NBASEGRID) {
        out.grid = trimmed(cmp.parts[2] ?? "");
      } else if (cmp.parts.length > 2) {
        out.cmd = cmp.parts[2];
        if (cmp.parts[3] !== undefined) {
          out.num = cmp.parts[3];
          out.snr = parseInt(cmp.parts[3], 10);
        }
      }
      return out;
    }

    // tryUnpackDirected
    const dir = unpackDirectedMessage(m);
    if (dir) {
      const parts = dir.parts;
      out.message = parts.length === 3 || parts.length === 4 ? parts[0] + ": " + parts[1] + parts.slice(2).join(" ") + " " : parts.join("");
      out.directed = parts;
      out.isDirected = parts.length > 2;
      out.frameType = dir.type;
      out.from = parts[0];
      out.to = parts[1];
      out.cmd = parts[2];
      if (parts[3] !== undefined) {
        out.num = parts[3];
        if (isSNRCommand(parts[2] ?? "")) out.snr = parseInt(parts[3], 10);
      }
      return out;
    }
  }

  return out;
}

/** What JS8Call echoes for a transmission: the decoded text of each frame, concatenated. */
export function framesToText(frames: readonly TxFrame[], submode = 0): string {
  return frames.map((f) => unpackFrame(f.frame, f.i3, submode).message).join("");
}

/**
 * Check the checksum on a complete buffered message (processBufferedActivity.cpp): returns the
 * text without its checksum and whether it matched. Commands without a checksum are valid.
 */
export function checkBufferedMessage(cmd: string, text: string): { valid: boolean; message: string; checksum: string } {
  let message = rstrip(text);
  let checksum = "";
  if (!isCommandBuffered(cmd)) return { valid: true, message, checksum };
  const size = isCommandChecksumed(cmd);
  if (size === 32) {
    message = lstrip(message);
    checksum = message.slice(-6);
    message = qleft(message, message.length - 7);
    return { valid: checksum32Valid(checksum, message), message, checksum };
  }
  if (size === 16) {
    message = lstrip(message);
    checksum = message.slice(-3);
    message = qleft(message, message.length - 4);
    return { valid: checksum16Valid(checksum, message), message, checksum };
  }
  return { valid: true, message, checksum };
}

/** QString::left: a negative count returns the whole string. */
function qleft(s: string, n: number): string {
  return n < 0 ? s : s.slice(0, n);
}

// the escape constant is part of the original's public surface even though nothing here uses it
export const ESCAPE_CHAR = ESC;
