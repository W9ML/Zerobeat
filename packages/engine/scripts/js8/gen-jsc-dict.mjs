// Generate packages/engine/src/digital/js8/jsc-dict.bin.br from JS8Call's JSC_map.cpp + JSC_list.cpp.
//
// usage: node gen-jsc-dict.mjs <path to JS8_JSC dir> <output file>
//
// Binary layout (integers little-endian), brotli-compressed as a whole:
//   "JSC2"
//   u32 N (262144)                             number of JSC::map rows
//   u32 P (103)                                number of JSC::prefix rows
//   P x { u8 char, u32 size }                  JSC::prefix in table order (size 1 = single char)
//   u32 M                                      number of map size overrides
//   M x { u32 mapIndex, u8 size }              JSC::map rows whose size != strlen(str)
//   N latin1 words joined by 0x00              JSC::map[i].str in index order
//
// JSC::list (the lookup order) is not stored. Its groups are sorted in strictly descending
// byte order, so the C++ linear scan "first list entry that is a prefix of the input" is the
// same as "longest dictionary word that is a prefix of the input and shares its first
// character". This script proves that equivalence against the real list before writing.
import fs from "node:fs";
import zlib from "node:zlib";
import { load } from "./parse-jsc.mjs";

const [dir, out] = process.argv.slice(2);
if (!dir || !out) throw new Error("usage: node gen-jsc-dict.mjs <JS8_JSC dir> <out>");
const { map, list, prefix } = load(dir);
const N = map.length;
if (N !== 262144 || list.length !== N || prefix.length !== 103) throw new Error("unexpected table sizes");
map.forEach((r, i) => { if (r.index !== i) throw new Error("map not index ordered at " + i); });
for (const r of map) if (r.str.includes("\0")) throw new Error("NUL in word");

// --- exact C++ JSC::lookup(char const*) over the real list ---
function lookupExact(b) {
  for (const p of prefix) {
    if (b[0] !== p.str[0]) continue;
    if (p.size === 1) return list[p.index].index;
    for (let i = p.index; i < p.index + p.size; i++) {
      const e = list[i];
      // strncmp(b, e.str, e.size) == 0, with b NUL-terminated
      let ok = true;
      for (let k = 0; k < e.size; k++) {
        const bc = k < b.length ? b.charCodeAt(k) : 0;
        const ec = k < e.str.length ? e.str.charCodeAt(k) : 0;
        if (bc !== ec) { ok = false; break; }
        if (bc === 0) break;
      }
      if (ok) return e.index;
    }
    return -1;
  }
  return -1;
}

// --- the fast equivalent the TypeScript port uses ---
const single = new Map();
const group = new Set();
for (const p of prefix) (p.size === 1 ? single.set(p.str, true) : group.add(p.str));
const byWord = new Map();
let maxLen = 0;
map.forEach((r, i) => {
  if (group.has(r.str[0])) { byWord.set(r.str, i); maxLen = Math.max(maxLen, r.str.length); }
});
function lookupFast(b) {
  if (b.length === 0) return -1;
  const c = b[0];
  if (single.has(c)) return byWord.get(c) ?? map.findIndex((r) => r.str === c);
  if (!group.has(c)) return -1;
  for (let len = Math.min(maxLen, b.length); len >= 1; len--) {
    const i = byWord.get(b.slice(0, len));
    if (i !== undefined) return i;
  }
  return -1;
}

// probe set: every word, every word with a suffix, prefixes of words, and random strings
const probes = [];
const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,?!'-+/@:<>=\\\n\x1Aabcz\xc0\xde\xff";
let seed = 12345;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
for (const r of map) {
  probes.push(r.str, r.str + "Q", r.str + "S", r.str.slice(0, -1));
}
for (let i = 0; i < 200000; i++) {
  let s = ""; const n = 1 + rnd(10);
  for (let k = 0; k < n; k++) s += alpha[rnd(alpha.length)];
  probes.push(s);
}
let mismatches = 0;
for (const p of probes) {
  if (!p) continue;
  const a = lookupExact(p), b = lookupFast(p);
  if (a !== b && mismatches++ < 10) console.log("MISMATCH", JSON.stringify(p), a, b);
}
if (mismatches) throw new Error(mismatches + " lookup mismatches");
console.log("lookup equivalence verified on", probes.length, "probes");

const mapOverrides = [];
map.forEach((r, i) => { if (r.size !== r.str.length) mapOverrides.push([i, r.size]); });

const chunks = [];
const u8 = (v) => chunks.push(Buffer.from([v & 0xff]));
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); chunks.push(b); };
chunks.push(Buffer.from("JSC2", "latin1"));
u32(N);
u32(prefix.length);
for (const p of prefix) {
  if (p.str.length !== 1) throw new Error("prefix str not 1 char");
  u8(p.str.charCodeAt(0)); u32(p.size);
}
u32(mapOverrides.length);
for (const [i, s] of mapOverrides) { u32(i); u8(s); }
chunks.push(Buffer.from(map.map((r) => r.str).join("\0"), "latin1"));
const raw = Buffer.concat(chunks);

const br = zlib.brotliCompressSync(raw, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length },
});
fs.writeFileSync(out, br);
console.log(`raw ${raw.length} bytes, brotli ${br.length} -> wrote ${out}`);
console.log("map size overrides", JSON.stringify(mapOverrides));

// golden vectors for tests: lookups of a few words through the exact C++ path
for (const w of ["HELLO", "WORLD", "HELLOS", "ROSIDS", "JS8CALL", "@ALLCALL", "QQQQ", "73", "THE", "TNX"]) {
  const i = lookupExact(w);
  console.log("lookup", w, "->", i, i >= 0 ? JSON.stringify(map[i]) : "");
}
