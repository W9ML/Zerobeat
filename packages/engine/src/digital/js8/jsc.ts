/**
 * JSC: JS8Call's dictionary text compression, used by data frames.
 *
 * Ported from JS8Call-improved JS8_JSC/JSC.cpp (GPL-3, (C) 2018 Jordan Sherer KN4CRD). The
 * dictionary is a 262,144-entry word list ordered by rank (JSC_map.cpp). Each word is sent as
 * an (s,c)-dense code with s = 7 stoppers and c = 9 continuers over 4-bit symbols: the last
 * symbol of a codeword is below 7 and carries one extra bit that says "a space follows".
 *
 * The tables live in jsc-dict.bin.br next to this file, generated from JSC_map.cpp and
 * JSC_list.cpp by scripts/js8/gen-jsc-dict.mjs, and are read lazily on first use.
 *
 * JSC.cpp finds a word by scanning JSC::list, a copy of the dictionary sorted in descending
 * byte order inside groups keyed by the first character, and taking the first entry that is a
 * prefix of the input. Inside a sorted group that is always the longest matching word, so the
 * port asks a hash map for the longest prefix instead of scanning. The generator proves the two
 * agree on every dictionary word plus a large set of random strings before it writes the file.
 *
 * Two quirks of the original tables are reproduced on purpose because they change the wire
 * format: the last map entry ("ROSIDS") claims a size of 1, so it consumes one input character
 * but decodes to six, and "@ALLCALL" (size 7) can never be selected because "@" is a
 * single-character prefix that short-circuits the search.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";

export const JSC_SIZE = 262144;

const B = 4; // bits per symbol
const S = 7; // stoppers
const C = (1 << B) - S; // continuers (9)

interface Dictionary {
  /** JSC::map[i].str, latin1 code units. */
  words: string[];
  /** JSC::map[i].size, which is the word length except for the two overrides. */
  sizes: Uint8Array;
  /** JSC::prefix in table order: the first character and its group size (1 = single char). */
  prefix: { ch: string; size: number }[];
  /** First characters whose lookup returns the single-character word without comparing. */
  singleIndex: Map<string, number>;
  /** Words reachable through a multi-entry prefix group, by text. */
  byWord: Map<string, number>;
  maxLen: number;
}

let dict: Dictionary | null = null;
let dictPath: string | null = null;

/** Override where the dictionary is read from (for bundled builds that copy the file elsewhere). */
export function setJscDictionaryPath(path: string): void {
  dictPath = path;
  dict = null;
}

function candidatePaths(): string[] {
  if (dictPath) return [dictPath];
  const out: string[] = [];
  if (process.env.JS8_JSC_DICT) out.push(process.env.JS8_JSC_DICT);
  // next to this module when running from source; the second path covers the esbuild bundle
  // in packages/engine/dist, which sits beside src/
  out.push(fileURLToPath(new URL("./jsc-dict.bin.br", import.meta.url)));
  out.push(fileURLToPath(new URL("../src/digital/js8/jsc-dict.bin.br", import.meta.url)));
  return out;
}

function readDictionaryFile(): Buffer {
  let lastErr: unknown = null;
  for (const p of candidatePaths()) {
    try {
      return readFileSync(p);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`JSC dictionary not found (tried ${candidatePaths().join(", ")}): ${String(lastErr)}`);
}

function loadDictionary(): Dictionary {
  if (dict) return dict;
  const raw = brotliDecompressSync(readDictionaryFile());
  let off = 0;
  const u8 = () => raw[off++]!;
  const u32 = () => {
    const v = raw.readUInt32LE(off);
    off += 4;
    return v;
  };
  if (raw.toString("latin1", 0, 4) !== "JSC2") throw new Error("bad JSC dictionary magic");
  off = 4;
  const n = u32();
  if (n !== JSC_SIZE) throw new Error(`JSC dictionary has ${n} entries, expected ${JSC_SIZE}`);
  const prefixCount = u32();
  const prefix: { ch: string; size: number }[] = [];
  for (let i = 0; i < prefixCount; i++) {
    const ch = String.fromCharCode(u8());
    prefix.push({ ch, size: u32() });
  }
  const overrides: [number, number][] = [];
  const overrideCount = u32();
  for (let i = 0; i < overrideCount; i++) {
    const index = u32();
    overrides.push([index, u8()]);
  }
  const words = raw.toString("latin1", off).split("\0");
  if (words.length !== n) throw new Error(`JSC dictionary word count ${words.length} != ${n}`);

  const sizes = new Uint8Array(n);
  for (let i = 0; i < n; i++) sizes[i] = words[i]!.length;
  for (const [index, size] of overrides) sizes[index] = size;

  const single = new Set<string>();
  const group = new Set<string>();
  for (const p of prefix) (p.size === 1 ? single : group).add(p.ch);

  const singleIndex = new Map<string, number>();
  const byWord = new Map<string, number>();
  let maxLen = 0;
  for (let i = 0; i < n; i++) {
    const w = words[i]!;
    if (w.length === 1 && single.has(w)) singleIndex.set(w, i);
    if (group.has(w[0]!)) {
      byWord.set(w, i);
      if (w.length > maxLen) maxLen = w.length;
    }
  }

  dict = { words, sizes, prefix, singleIndex, byWord, maxLen };
  return dict;
}

/** Load the dictionary now instead of on the first compress/decompress call. */
export function preloadJsc(): void {
  loadDictionary();
}

/** QString::toLatin1 (characters above U+00FF become '?'), then cut at the first NUL like a C string. */
function toLatin1CString(w: string): string {
  let out = "";
  for (let i = 0; i < w.length; i++) {
    const code = w.charCodeAt(i);
    if (code === 0) break;
    out += code > 0xff ? "?" : w[i];
  }
  return out;
}

const lookupCache = new Map<string, number>();

/** JSC::lookup: index of the dictionary word that prefixes `w`, or ok=false. */
export function jscLookup(w: string): { index: number; ok: boolean } {
  const cached = lookupCache.get(w);
  if (cached !== undefined) return { index: cached, ok: true };
  const d = loadDictionary();
  const b = toLatin1CString(w);
  let result = -1;
  if (b.length > 0) {
    const c = b[0]!;
    for (const p of d.prefix) {
      if (p.ch !== c) continue;
      if (p.size === 1) {
        result = d.singleIndex.get(c) ?? -1;
      } else {
        for (let len = Math.min(d.maxLen, b.length); len >= 1; len--) {
          const i = d.byWord.get(b.slice(0, len));
          if (i !== undefined) {
            result = i;
            break;
          }
        }
      }
      break;
    }
  }
  if (result < 0) return { index: 0, ok: false };
  lookupCache.set(w, result);
  return { index: result, ok: true };
}

/** JSC::exists: `w` is a whole dictionary word (what JSCChecker uses to underline unknown words). */
export function jscExists(w: string): { exists: boolean; index: number } {
  const { index, ok } = jscLookup(w);
  return { exists: ok && loadDictionary().sizes[index] === w.length, index };
}

/** JSC::map[index] as { str, size }. */
export function jscEntry(index: number): { str: string; size: number } | null {
  const d = loadDictionary();
  if (index < 0 || index >= JSC_SIZE) return null;
  return { str: d.words[index]!, size: d.sizes[index]! };
}

/** The single-character JSC::prefix entries in table order (Varicode::extendedChars). */
export function jscExtendedChars(): string {
  return loadDictionary()
    .prefix.filter((p) => p.size === 1)
    .map((p) => p.ch)
    .join("");
}

function intToBits(value: number, expected: number): boolean[] {
  const bits: boolean[] = [];
  let v = value;
  while (v) {
    bits.unshift((v & 1) === 1);
    v = Math.floor(v / 2);
  }
  while (bits.length < expected) bits.unshift(false);
  return bits;
}

/** JSC::codeword: the dense code for a dictionary index, with the trailing separator bit. */
export function jscCodeword(index: number, separate: boolean, bytesize = B, s = S, c = C): boolean[] {
  const out: boolean[][] = [];
  const v = (index % s) * 2 + (separate ? 1 : 0);
  out.unshift(intToBits(v, bytesize + 1));
  let x = Math.floor(index / s);
  while (x > 0) {
    x -= 1;
    out.unshift(intToBits((x % c) + s, bytesize));
    x = Math.floor(x / c);
  }
  return out.flat();
}

export interface CodewordPair {
  bits: boolean[];
  /** Characters of input this codeword stands for, including a following space. */
  chars: number;
}

/** JSC::compress: split on single spaces and greedily cover each word with dictionary entries. */
export function jscCompress(text: string): CodewordPair[] {
  const d = loadDictionary();
  const out: CodewordPair[] = [];
  const words = text.split(" ");
  for (let i = 0, len = words.length; i < len; i++) {
    let w = words[i]!;
    const isLastWord = i === len - 1;
    let isSpaceCharacter = false;
    // an empty part between two spaces stands for a literal space, unless it is the last part
    if (w.length === 0 && !isLastWord) {
      w = " ";
      isSpaceCharacter = true;
    }
    while (w.length > 0) {
      const { index, ok } = jscLookup(w);
      if (!ok) break; // the rest of this word cannot be coded; JSC.cpp drops it silently
      const size = d.sizes[index]!;
      w = w.slice(size);
      const isLast = w.length === 0;
      const shouldAppendSpace = isLast && !isSpaceCharacter && !isLastWord;
      out.push({ bits: jscCodeword(index, shouldAppendSpace), chars: size + (shouldAppendSpace ? 1 : 0) });
    }
  }
  return out;
}

/** JSC::decompress: read 4-bit symbols, a stopper ends a codeword and is followed by the space bit. */
export function jscDecompress(bitvec: readonly boolean[]): string {
  const d = loadDictionary();
  const base = [0, S];
  for (let k = 2; k < 8; k++) base.push(base[k - 1]! + S * C ** (k - 1));

  const bytes: number[] = [];
  const separators: number[] = [];
  let i = 0;
  const count = bitvec.length;
  while (i < count) {
    if (count - i < 4) break;
    let byte = 0;
    for (let k = 0; k < 4; k++) byte = byte * 2 + (bitvec[i + k] ? 1 : 0);
    bytes.push(byte);
    i += 4;
    if (byte < S) {
      if (count - i > 0 && bitvec[i]) separators.push(bytes.length - 1);
      i += 1;
    }
  }

  const out: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let k = 0;
    let j = 0;
    // quint32 arithmetic: wraps modulo 2^32 like the C++
    while (start + k < bytes.length && bytes[start + k]! >= S) {
      j = (j * C + (bytes[start + k]! - S)) >>> 0;
      k++;
    }
    if (j >= JSC_SIZE) break;
    if (start + k >= bytes.length) break;
    // base[] has 8 entries in C++; a longer run reads past it (undefined behaviour). Valid
    // codewords never get there, so treat it as the end of the data.
    if (k >= base.length) break;
    j = (j * S + bytes[start + k]! + base[k]!) >>> 0;
    if (j >= JSC_SIZE) break;

    out.push(d.words[j]!);
    if (separators.length > 0 && separators[0] === start + k) {
      out.push(" ");
      separators.shift();
    }
    start = start + (k + 1);
  }
  return out.join("");
}
