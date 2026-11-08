/**
 * WSPR source coding: the 50-bit message of WSJT-X (lib/wsprcode/wspr_old_subs.f90:
 * wqencode, packcall, packgrid, packpfx; lib/wsprd/wsprd_utils.c: unpack50, unpackcall,
 * unpackgrid, unpackpfx, unpk_; lib/wsprd/nhash.c over Bob Jenkins' lookup3 hashlittle).
 *
 *   n1 (28 bits)  callsign, base 37/36/10/27/27/27, exactly as JT65's packcall
 *   n2 (22 bits)  128 * ng + ntype + 64
 *
 * ntype says which of the three message types it is:
 *   Type 1  "K1ABC FN42 37"         ng = 4-character locator, ntype = dBm (0,3,7,...,60)
 *   Type 2  "PJ4/K1ABC 37"          ng = prefix (or suffix) code, ntype = dBm + 1 + nadd,
 *                                   so ntype mod 10 is never 0, 3 or 7
 *   Type 3  "<PJ4/K1ABC> FK52UD 37" n1 = the 6-character locator rotated by one so that it
 *                                   looks like a callsign, ng = 15-bit hash of the call,
 *                                   ntype = -(dBm + 1)
 *
 * A type 3 message carries only the hash, so the receiver can name the station only if
 * it has heard the full call before in a type 1 or 2 message; wsprd keeps that table in
 * hashtable.txt, here it is a WsprHashTable the caller can keep between periods.
 *
 * The encoder follows the Fortran path WSJT-X uses to transmit (genwspr -> wqencode); the
 * decoder follows wsprd's C unpacker, including its sanity checks, which reject garbage
 * the Fano decoder occasionally lets through.
 */

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ ";

/** Legal WSPR power levels in dBm. */
export const WSPR_POWERS: readonly number[] = [
  0, 3, 7, 10, 13, 17, 20, 23, 27, 30, 33, 37, 40, 43, 47, 50, 53, 57, 60,
];

// wqencode's nu(): rounds a power to the nearest level ending in 0, 3 or 7.
const NU = [0, -1, 1, 0, -1, 2, 1, 0, -1, 1];

/** Clamp to 0..60 dBm and round to a legal level, as WSJT-X does before sending. */
export function normalizeWsprPower(dbm: number): number {
  let p = Math.trunc(dbm);
  if (!Number.isFinite(p) || p < 0) p = 0;
  if (p > 60) p = 60;
  return p + NU[p % 10]!;
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}
function isLetter(c: string | undefined): boolean {
  return c !== undefined && c >= "A" && c <= "Z";
}

// ---------------------------------------------------------------------------------------
// lookup3 hashlittle (Bob Jenkins, public domain), byte-at-a-time form. wsprd calls it as
// nhash(call, strlen(call), 146) & 0x7fff.

function rot(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export function hashlittle(key: Uint8Array, initval: number): number {
  let length = key.length;
  let a = (0xdeadbeef + length + initval) >>> 0;
  let b = a;
  let c = a;
  let o = 0;
  const k = (i: number) => key[o + i]!;
  while (length > 12) {
    a = (a + (k(0) | (k(1) << 8) | (k(2) << 16) | (k(3) << 24))) >>> 0;
    b = (b + (k(4) | (k(5) << 8) | (k(6) << 16) | (k(7) << 24))) >>> 0;
    c = (c + (k(8) | (k(9) << 8) | (k(10) << 16) | (k(11) << 24))) >>> 0;
    // mix(a, b, c)
    a = (a - c) >>> 0; a = (a ^ rot(c, 4)) >>> 0; c = (c + b) >>> 0;
    b = (b - a) >>> 0; b = (b ^ rot(a, 6)) >>> 0; a = (a + c) >>> 0;
    c = (c - b) >>> 0; c = (c ^ rot(b, 8)) >>> 0; b = (b + a) >>> 0;
    a = (a - c) >>> 0; a = (a ^ rot(c, 16)) >>> 0; c = (c + b) >>> 0;
    b = (b - a) >>> 0; b = (b ^ rot(a, 19)) >>> 0; a = (a + c) >>> 0;
    c = (c - b) >>> 0; c = (c ^ rot(b, 4)) >>> 0; b = (b + a) >>> 0;
    length -= 12;
    o += 12;
  }
  if (length === 0) return c;
  // The last block is read with zero padding; adding (k << 0..24) words is the same as
  // the C switch's fall-through additions.
  const t = new Uint8Array(12);
  t.set(key.subarray(o, o + length));
  a = (a + (t[0]! | (t[1]! << 8) | (t[2]! << 16) | (t[3]! << 24))) >>> 0;
  b = (b + (t[4]! | (t[5]! << 8) | (t[6]! << 16) | (t[7]! << 24))) >>> 0;
  c = (c + (t[8]! | (t[9]! << 8) | (t[10]! << 16) | (t[11]! << 24))) >>> 0;
  // final(a, b, c)
  c = (c ^ b) >>> 0; c = (c - rot(b, 14)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rot(c, 11)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rot(a, 25)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot(b, 16)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rot(c, 4)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rot(a, 14)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot(b, 24)) >>> 0;
  return c;
}

/** wsprd's 15-bit callsign hash (nhash(call, len, 146) & 0x7fff). */
export function wsprHash(call: string): number {
  const bytes = new Uint8Array(call.length);
  for (let i = 0; i < call.length; i++) bytes[i] = call.charCodeAt(i) & 0xff;
  return hashlittle(bytes, 146) & 0x7fff;
}

/**
 * Callsigns (and their locators, for type 1) by 15-bit hash, learned from decoded type 1
 * and type 2 messages so that later type 3 messages can be named. One table per receiver;
 * keep it across periods (and persist entries() if you like, as wsprd's hashtable.txt).
 */
export class WsprHashTable {
  private readonly calls = new Map<number, string>();
  private readonly grids = new Map<number, string>();

  add(call: string, grid?: string): void {
    const h = wsprHash(call);
    this.calls.set(h, call);
    if (grid !== undefined) this.grids.set(h, grid);
  }

  call(hash: number): string | undefined {
    return this.calls.get(hash);
  }

  grid(hash: number): string | undefined {
    return this.grids.get(hash);
  }

  get size(): number {
    return this.calls.size;
  }

  /** [hash, call, grid] rows, the content of wsprd's hashtable.txt. */
  entries(): Array<[number, string, string]> {
    return [...this.calls].map(([h, c]) => [h, c, this.grids.get(h) ?? ""]);
  }

  static from(rows: Iterable<readonly [number, string, string?]>): WsprHashTable {
    const t = new WsprHashTable();
    for (const [h, c, g] of rows) {
      if (h < 0 || h > 0x7fff) continue;
      t.calls.set(h, c);
      if (g) t.grids.set(h, g);
    }
    return t;
  }
}

// ---------------------------------------------------------------------------------------
// Packing (WSJT-X wqencode and helpers)

function nchar(c: string): number {
  if (isDigit(c)) return c.charCodeAt(0) - 48;
  if (isLetter(c)) return c.charCodeAt(0) - 55;
  return 36; // space
}

/** packcall: a standard callsign (at most 6 characters) to 28 bits, or null. */
export function packCall(callsign: string): number | null {
  let c = callsign.toUpperCase();
  if (c.startsWith("3DA0")) c = "3D0" + c.slice(4); // Swaziland work-around, as WSJT-X
  if (c.length === 0 || c.length > 6) return null;
  c = c.padEnd(6, " ");
  let tmp: string;
  if (isDigit(c[2])) tmp = c;
  else if (isDigit(c[1])) {
    if (c[5] !== " ") return null;
    tmp = " " + c.slice(0, 5);
  } else return null;
  const ok =
    (isLetter(tmp[0]) || tmp[0] === " " || isDigit(tmp[0])) &&
    (isLetter(tmp[1]) || isDigit(tmp[1])) &&
    isDigit(tmp[2]) &&
    (isLetter(tmp[3]) || tmp[3] === " ") &&
    (isLetter(tmp[4]) || tmp[4] === " ") &&
    (isLetter(tmp[5]) || tmp[5] === " ");
  if (!ok) return null;
  let n = nchar(tmp[0]!);
  n = 36 * n + nchar(tmp[1]!);
  n = 10 * n + nchar(tmp[2]!);
  n = 27 * n + nchar(tmp[3]!) - 10;
  n = 27 * n + nchar(tmp[4]!) - 10;
  n = 27 * n + nchar(tmp[5]!) - 10;
  return n;
}

function isGrid4(g: string): boolean {
  return /^[A-R]{2}[0-9]{2}$/.test(g);
}

function packGrid4(g: string): number {
  const g0 = g.charCodeAt(0) - 65;
  const g1 = g.charCodeAt(1) - 65;
  const g2 = g.charCodeAt(2) - 48;
  const g3 = g.charCodeAt(3) - 48;
  // Same as packgrid's ((long + 180) / 2) * 180 + lat + 90 for the square's centre.
  return (179 - 10 * g0 - g2) * 180 + 10 * g1 + g3;
}

/** packpfx: "PJ4/K1ABC", "K1ABC/P" or "K1ABC/12" to { n1, ng, nadd }, or null. */
function packPrefix(call: string): { n1: number; ng: number; nadd: number } | null {
  const i1 = call.indexOf("/");
  if (i1 < 1 || call.indexOf("/", i1 + 1) >= 0) return null;
  const before = call.slice(0, i1);
  const after = call.slice(i1 + 1);
  if (after.length === 1) {
    // Single-character suffix, /0../9 or /A../Z
    const n1 = packCall(before);
    if (n1 === null || !(isDigit(after) || isLetter(after))) return null;
    return { n1, ng: 60000 - 32768 + nchar(after), nadd: 1 };
  }
  if (after.length === 2 && before.length <= 6 && /^[1-9][0-9]$/.test(after)) {
    // Two-digit numerical suffix, /10 to /99
    const n1 = packCall(before);
    if (n1 === null) return null;
    return { n1, ng: 60000 + 26 + Number(after), nadd: 1 };
  }
  // Prefix of 1 to 3 characters, right-justified in three places with spaces
  if (before.length > 3 || !/^[A-Z0-9]+$/.test(before)) return null;
  const n1 = packCall(after);
  if (n1 === null) return null;
  const pfx = before.padStart(3, " ");
  let ng = 0;
  for (const ch of pfx) ng = 37 * ng + nchar(ch);
  let nadd = 0;
  if (ng >= 32768) {
    ng -= 32768;
    nadd = 1;
  }
  return { n1, ng, nadd };
}

/** pack50: n1 (28 bits) and n2 (22 bits) to the 11 data bytes (50 bits + zero tail). */
function pack50(n1: number, n2: number): Uint8Array {
  const d = new Uint8Array(11);
  d[0] = (n1 >>> 20) & 0xff;
  d[1] = (n1 >>> 12) & 0xff;
  d[2] = (n1 >>> 4) & 0xff;
  d[3] = ((n1 & 0x0f) << 4) | ((n2 >>> 18) & 0x0f);
  d[4] = (n2 >>> 10) & 0xff;
  d[5] = (n2 >>> 2) & 0xff;
  d[6] = (n2 & 0x03) << 6;
  return d;
}

export type WsprMessageType = 1 | 2 | 3;

/**
 * Pack a WSPR message into the 11 bytes that feed the convolutional encoder (50 message
 * bits, high bit first, then the 31 zero tail bits). Accepts the three forms
 *   "K1ABC FN42 37", "PJ4/K1ABC 37" (or "K1ABC/P 37"), "<PJ4/K1ABC> FK52UD 37".
 * Power is rounded to a legal level as WSJT-X does. Throws on anything else.
 */
export function packWspr(message: string): Uint8Array {
  const msg = message.trim().toUpperCase().replace(/\s+/g, " ");
  const parts = msg.split(" ");
  const power = (s: string | undefined) => {
    if (s === undefined || !/^-?\d+$/.test(s)) throw new Error(`WSPR: bad power in "${message}"`);
    return normalizeWsprPower(Number(s));
  };
  const first = parts[0] ?? "";
  if (first.startsWith("<")) {
    // Type 3: hashed callsign + 6-character locator
    const m = /^<([A-Z0-9/]+)>$/.exec(first);
    const grid6 = parts[1] ?? "";
    if (!m || parts.length !== 3 || !/^[A-R]{2}[0-9]{2}[A-X]{2}$/.test(grid6)) {
      throw new Error(`WSPR: cannot pack "${message}"`);
    }
    const ih = wsprHash(m[1]!);
    const n1 = packCall(grid6.slice(1) + grid6[0]);
    if (n1 === null) throw new Error(`WSPR: cannot pack "${message}"`);
    const ntype = -(power(parts[2]) + 1);
    return pack50(n1, (128 * ih + ntype + 64) & 0x3fffff);
  }
  if (first.includes("/")) {
    // Type 2: compound callsign + power
    const p = parts.length === 2 ? packPrefix(first) : null;
    if (!p) throw new Error(`WSPR: cannot pack "${message}"`);
    const ntype = power(parts[1]) + 1 + p.nadd;
    // A suffix code is >= 32768; only the low 22 bits of n2 are sent and the receiver
    // adds the 32768 back from nadd.
    return pack50(p.n1, (128 * p.ng + ntype + 64) & 0x3fffff);
  }
  // Type 1: callsign, 4-character locator, power
  const n1 = parts.length === 3 ? packCall(first) : null;
  const grid = parts[1] ?? "";
  if (n1 === null || !isGrid4(grid)) throw new Error(`WSPR: cannot pack "${message}"`);
  return pack50(n1, 128 * packGrid4(grid) + power(parts[2]) + 64);
}

// ---------------------------------------------------------------------------------------
// Unpacking (wsprd_utils.c)

function unpack50(d: ArrayLike<number>): { n1: number; n2: number } {
  const b = (i: number) => d[i]! & 0xff;
  const n1 = (b(0) << 20) + (b(1) << 12) + (b(2) << 4) + ((b(3) >> 4) & 15);
  const n2 = ((b(3) & 15) << 18) + (b(4) << 10) + (b(5) << 2) + ((b(6) >> 6) & 3);
  return { n1, n2 };
}

/** unpackcall: 28 bits to a callsign, or null for the plain-text range. */
export function unpackCall(ncall: number): string | null {
  if (ncall >= 262177560) return null;
  let n = ncall;
  const t: string[] = new Array(6);
  t[5] = ALPHABET[(n % 27) + 10]!;
  n = Math.floor(n / 27);
  t[4] = ALPHABET[(n % 27) + 10]!;
  n = Math.floor(n / 27);
  t[3] = ALPHABET[(n % 27) + 10]!;
  n = Math.floor(n / 27);
  t[2] = ALPHABET[n % 10]!;
  n = Math.floor(n / 10);
  t[1] = ALPHABET[n % 36]!;
  n = Math.floor(n / 36);
  t[0] = ALPHABET[n] ?? " ";
  let i = 0;
  while (i < 5 && t[i] === " ") i++;
  let call = t.slice(i).join("");
  const sp = call.indexOf(" ");
  if (sp >= 0) call = call.slice(0, sp); // wsprd ends the string at the first space
  if (call.startsWith("3D0")) call = "3DA0" + call.slice(3);
  return call;
}

/** unpackgrid: n2 to the 4-character locator, or null if out of range. */
function unpackGrid(n2: number): string | null {
  const ngrid = n2 >> 7;
  if (ngrid >= 32400) return null;
  const dlat = (ngrid % 180) - 90;
  let dlong = Math.floor(ngrid / 180) * 2 - 180 + 2;
  if (dlong < -180) dlong += 360;
  const nlong = Math.trunc((60 * (180 - dlong)) / 5);
  let a = Math.trunc(nlong / 240);
  let b = Math.trunc((nlong - 240 * a) / 24);
  const g0 = ALPHABET[10 + a]!;
  const g2 = ALPHABET[b]!;
  const nlat = Math.trunc((60 * (dlat + 90)) / 2.5);
  a = Math.trunc(nlat / 240);
  b = Math.trunc((nlat - 240 * a) / 24);
  return g0 + ALPHABET[10 + a]! + g2 + ALPHABET[b]!;
}

/** unpackpfx: add the prefix or suffix coded in nprefix to call. */
function unpackPrefix(nprefix: number, call: string): string | null {
  if (nprefix < 60000) {
    let n = nprefix;
    const pfx: string[] = ["", "", ""];
    for (let i = 2; i >= 0; i--) {
      const nc = n % 37;
      pfx[i] = nc <= 9 ? String.fromCharCode(nc + 48) : nc <= 35 ? String.fromCharCode(nc + 55) : " ";
      n = Math.floor(n / 37);
    }
    const s = pfx.join("");
    const lastSpace = s.lastIndexOf(" ");
    return `${lastSpace >= 0 ? s.slice(lastSpace + 1) : s}/${call}`;
  }
  const nc = nprefix - 60000;
  if (nc <= 9) return `${call}/${String.fromCharCode(nc + 48)}`;
  if (nc <= 35) return `${call}/${String.fromCharCode(nc + 55)}`;
  if (nc <= 125) return `${call}/${Math.floor((nc - 26) / 10)}${(nc - 26) % 10}`;
  return null;
}

export interface WsprMessage {
  /** Message text as wsprd prints it, with single spaces: "K1ABC FN42 37", "<...> FN42AB 37". */
  message: string;
  type: WsprMessageType;
  /** Full callsign; for type 3, the hash-table entry, or null if the hash is unknown. */
  callsign: string | null;
  /** 4-character locator (type 1), 6-character (type 3), null for type 2. */
  grid: string | null;
  dbm: number;
}

/**
 * Unpack the decoded data bytes (at least 7; 50 bits high bit first, as packWspr and the
 * Fano decoder produce them). Returns null where wsprd would not print the message
 * (unpk_ returns "noprint"): undecodable fields, illegal powers, junk type 3 locators.
 * Type 1 and 2 decodes teach `hashTable` their callsign, as wsprd does.
 */
export function unpackWspr(data: ArrayLike<number>, hashTable?: WsprHashTable): WsprMessage | null {
  const { n1, n2 } = unpack50(data);
  const raw = unpackCall(n1);
  const grid = unpackGrid(n2);
  if (raw === null || grid === null) return null;
  const ntype = (n2 & 127) - 64;
  if (ntype >= 0 && ntype <= 62) {
    const nu = ntype % 10;
    if (nu === 0 || nu === 3 || nu === 7) {
      hashTable?.add(raw, grid);
      return { message: `${raw} ${grid} ${ntype}`, type: 1, callsign: raw, grid, dbm: ntype };
    }
    let nadd = nu;
    if (nu > 3) nadd = nu - 3;
    if (nu > 7) nadd = nu - 7;
    const n3 = (n2 >> 7) + 32768 * (nadd - 1);
    const call = unpackPrefix(n3, raw);
    if (call === null) return null;
    const ndbm = ntype - nadd;
    const nu2 = ndbm % 10;
    if (!(nu2 === 0 || nu2 === 3 || nu2 === 7)) return null;
    hashTable?.add(call);
    return { message: `${call} ${ndbm}`, type: 2, callsign: call, grid: null, dbm: ndbm };
  }
  if (ntype < 0) {
    if (ntype === -64) return null; // "I don't know what to do with these" (wsprd)
    const ndbm = -(ntype + 1);
    // The locator was sent rotated one place to look like a callsign: "N42ABF" = FN42AB.
    const grid6 = ((raw[5] ?? "") + raw.slice(0, 5)).trim();
    const nu = ndbm % 10;
    // wsprd checks only the first four characters ("<PA0SKT/2> JO33 40" happens).
    if (!(nu === 0 || nu === 3 || nu === 7) || !/^[A-Z]{2}[0-9]{2}/.test(grid6)) return null;
    const ihash = (n2 - ntype - 64) / 128;
    const call = hashTable?.call(ihash) ?? null;
    return {
      message: `<${call ?? "..."}> ${grid6} ${ndbm}`,
      type: 3,
      callsign: call,
      grid: grid6,
      dbm: ndbm,
    };
  }
  return null;
}
