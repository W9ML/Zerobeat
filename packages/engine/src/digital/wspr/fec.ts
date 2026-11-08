/**
 * WSPR channel coding (WSJT-X lib/wsprd/fano.c, tab.c, wsprsim_utils.c, wsprd_utils.c,
 * metric_tables.c; lib/genwspr.f90):
 *
 *   50 message bits + 31 zero tail bits (11 bytes, the last 7 bits unused)
 *   -> K=32, r=1/2 convolutional code, Layland-Lushbaugh polynomials 0xf2d05351, 0xe4613c47
 *   -> 162 code bits, interleaved by 8-bit bit reversal of the index
 *   -> tone = 2 * code bit + sync bit, for the fixed 162-bit pseudo-random sync vector
 *
 * Decoding is Phil Karn's (KA9Q) soft-decision Fano sequential decoder, ported line for
 * line: a long constraint length gives a big coding gain, and the Fano algorithm makes it
 * affordable by exploring the code tree depth first and backing up only when the path
 * metric falls below a moving threshold. Its cost is unbounded on noise, hence the
 * per-bit cycle limit (wsprd -C, 10000 by default; WSJT-X itself passes 500 and then
 * falls back to OSD, which is not ported here).
 */

export const POLY1 = 0xf2d05351;
export const POLY2 = 0xe4613c47;

/** The 162-bit WSPR sync vector (pr3 in wsprd.c, npr3 in genwspr.f90). */
export const WSPR_SYNC = new Uint8Array([
  1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0,
  0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0,
  0, 0, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0,
  0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 0, 1, 1, 1,
  0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0,
  0, 0,
]);

/** 8-bit parity (tab.c's Partab). */
const PARTAB = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let v = i;
  v ^= v >> 4;
  v ^= v >> 2;
  v ^= v >> 1;
  PARTAB[i] = v & 1;
}

/** fano.h ENCODE: the POLY1 symbol in bit 1, the POLY2 symbol in bit 0. */
function encodeSym(encstate: number): number {
  let t = (encstate & POLY1) >>> 0;
  t ^= t >>> 16;
  let sym = PARTAB[(t ^ (t >>> 8)) & 0xff]! << 1;
  t = (encstate & POLY2) >>> 0;
  t ^= t >>> 16;
  sym |= PARTAB[(t ^ (t >>> 8)) & 0xff]!;
  return sym;
}

/** Convolutionally encode bytes, high bit first: 16 code bits (one per byte) per byte. */
export function convEncode(data: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(data.length * 16);
  let encstate = 0;
  let k = 0;
  for (let b = 0; b < data.length; b++) {
    for (let i = 7; i >= 0; i--) {
      encstate = ((encstate << 1) | ((data[b]! >> i) & 1)) >>> 0;
      const sym = encodeSym(encstate);
      out[k++] = sym >> 1;
      out[k++] = sym & 1;
    }
  }
  return out;
}

function rev8(i: number): number {
  let r = 0;
  for (let b = 0; b < 8; b++) r |= ((i >> b) & 1) << (7 - b);
  return r;
}

/** Interleave order: the p-th code bit goes to position ORDER[p] (bit-reversed index < 162). */
const ORDER = new Uint8Array(162);
{
  let p = 0;
  for (let i = 0; p < 162; i++) {
    const j = rev8(i);
    if (j < 162) ORDER[p++] = j;
  }
}

export function interleave<T extends Uint8Array>(sym: T): T {
  const tmp = sym.slice(0, 162);
  for (let p = 0; p < 162; p++) sym[ORDER[p]!] = tmp[p]!;
  return sym;
}

export function deinterleave<T extends Uint8Array>(sym: T): T {
  const tmp = sym.slice(0, 162);
  for (let p = 0; p < 162; p++) sym[p] = tmp[ORDER[p]!]!;
  return sym;
}

/** Channel tones (0-3) for 11 packed data bytes, as genwspr.f90. */
export function channelTones(data: ArrayLike<number>): number[] {
  const bits = interleave(convEncode(data).subarray(0, 162).slice());
  const tones = new Array<number>(162);
  for (let i = 0; i < 162; i++) tones[i] = 2 * bits[i]! + WSPR_SYNC[i]!;
  return tones;
}

/**
 * metric_tables[2] of metric_tables.c: log-likelihood of a soft symbol (0..255, 128 = no
 * information) given a sent 1, simulated by K9AN for 2-FSK at Es/No = 6 dB with rms 50
 * (wsprd normalises its soft symbols to that, symfac = 50). wsprd uses only this table.
 */
const METRIC_TABLE = [
  0.9999, 0.9998, 0.9998, 0.9998, 0.9998, 0.9998, 0.9997, 0.9997, 0.9997, 0.9997, 0.9997, 0.9996,
  0.9996, 0.9996, 0.9995, 0.9995, 0.9994, 0.9994, 0.9994, 0.9993, 0.9993, 0.9992, 0.9991, 0.9991,
  0.999, 0.9989, 0.9988, 0.9988, 0.9988, 0.9986, 0.9985, 0.9984, 0.9983, 0.9982, 0.998, 0.9979,
  0.9977, 0.9976, 0.9974, 0.9971, 0.9969, 0.9968, 0.9965, 0.9962, 0.996, 0.9957, 0.9953, 0.995,
  0.9947, 0.9941, 0.9937, 0.9933, 0.9928, 0.9922, 0.9917, 0.9911, 0.9904, 0.9897, 0.989, 0.9882,
  0.9874, 0.9863, 0.9855, 0.9843, 0.9832, 0.9819, 0.9806, 0.9792, 0.9777, 0.976, 0.9743, 0.9724,
  0.9704, 0.9683, 0.9659, 0.9634, 0.9609, 0.9581, 0.955, 0.9516, 0.9481, 0.9446, 0.9406, 0.9363,
  0.9317, 0.927, 0.9218, 0.916, 0.9103, 0.9038, 0.8972, 0.8898, 0.8822, 0.8739, 0.8647, 0.8554,
  0.8457, 0.8357, 0.8231, 0.8115, 0.7984, 0.7854, 0.7704, 0.7556, 0.7391, 0.721, 0.7038, 0.684,
  0.6633, 0.6408, 0.6174, 0.5939, 0.5678, 0.541, 0.5137, 0.4836, 0.4524, 0.4193, 0.385, 0.3482,
  0.3132, 0.2733, 0.2315, 0.1891, 0.1435, 0.098, 0.0493, 0.0, -0.051, -0.1052, -0.1593, -0.2177,
  -0.2759, -0.3374, -0.4005, -0.4599, -0.5266, -0.5935, -0.6626, -0.7328, -0.8051, -0.8757, -0.9498, -1.0271,
  -1.1019, -1.1816, -1.2642, -1.3459, -1.4295, -1.5077, -1.5958, -1.6818, -1.7647, -1.8548, -1.9387, -2.0295,
  -2.1152, -2.2154, -2.3011, -2.3904, -2.482, -2.5786, -2.673, -2.7652, -2.8616, -2.9546, -3.0526, -3.1445,
  -3.2445, -3.3416, -3.4357, -3.5325, -3.6324, -3.7313, -3.8225, -3.9209, -4.0248, -4.1278, -4.2261, -4.3193,
  -4.422, -4.5262, -4.6214, -4.7242, -4.8234, -4.9245, -5.0298, -5.125, -5.2232, -5.3267, -5.4332, -5.5342,
  -5.6431, -5.727, -5.8401, -5.935, -6.0407, -6.1418, -6.2363, -6.3384, -6.4536, -6.5429, -6.6582, -6.7433,
  -6.8438, -6.9478, -7.0789, -7.1894, -7.2714, -7.3815, -7.481, -7.5575, -7.6852, -7.8071, -7.858, -7.9724,
  -8.1, -8.2207, -8.2867, -8.4017, -8.5287, -8.6347, -8.7082, -8.8319, -8.9448, -9.0355, -9.1885, -9.2095,
  -9.2863, -9.4186, -9.5064, -9.6386, -9.7207, -9.8286, -9.9453, -10.0701, -10.1735, -10.3001, -10.2858, -10.5427,
  -10.5982, -10.7361, -10.7042, -10.9212, -11.0097, -11.0469, -11.1155, -11.2812, -11.3472, -11.4988, -11.5327, -11.6692,
  -11.9376, -11.8606, -12.1372, -13.2539,
];

/** C's round(): half away from zero. */
function cRound(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/**
 * Fano metric table [sent 0, sent 1] by received soft symbol, with wsprd's bias (-z,
 * 0.45): mettab[0][i] = round(10 (m[i] - bias)), mettab[1][i] = round(10 (m[255-i] - bias)).
 * The arithmetic is done in single precision, as wsprd does, so the roundings agree.
 */
export function fanoMetricTable(bias = 0.45): [Int32Array, Int32Array] {
  const f = Math.fround;
  const b = f(bias);
  const m0 = new Int32Array(256);
  const m1 = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    m0[i] = cRound(f(f(f(METRIC_TABLE[i]!) - b) * 10));
    m1[i] = cRound(f(f(f(METRIC_TABLE[255 - i]!) - b) * 10));
  }
  return [m0, m1];
}

export interface FanoResult {
  ok: boolean;
  /** Decoded bytes (nbits / 8 of them, 10 for WSPR's 81 bits). */
  data: Uint8Array;
  /** Final path metric. */
  metric: number;
  /** Decoder cycles used. */
  cycles: number;
}

/**
 * Karn's Fano decoder (fano.c) for `nbits` bits (message + 31-bit zero tail) from
 * 2 * nbits deinterleaved soft symbols (0..255). `maxCycles` is per bit, as wsprd's -C.
 */
export function fano(
  symbols: ArrayLike<number>,
  nbits: number,
  mettab: readonly [Int32Array, Int32Array],
  delta = 60,
  maxCycles = 10000,
): FanoResult {
  const [mt0, mt1] = mettab;
  const N = nbits + 1;
  // Encoder states are kept as int32 (only the low 32 bits ever matter: the polynomials
  // are 32 bits wide and the output bytes are the low 8), which keeps V8 on small ints.
  const encstate = new Int32Array(N);
  const gamma = new Int32Array(N);
  const metrics = new Int32Array(4 * N);
  const tm = new Int32Array(2 * N);
  const br = new Int32Array(N); // node->i, the branch being tried
  const last = nbits - 1;
  const tail = nbits - 31;
  const par = PARTAB;

  // All four branch metrics per node: the only place the raw symbols are read.
  for (let k = 0; k <= last; k++) {
    const s0 = symbols[2 * k]!;
    const s1 = symbols[2 * k + 1]!;
    metrics[4 * k] = mt0[s0]! + mt0[s1]!;
    metrics[4 * k + 1] = mt0[s0]! + mt1[s1]!;
    metrics[4 * k + 2] = mt1[s0]! + mt0[s1]!;
    metrics[4 * k + 3] = mt1[s0]! + mt1[s1]!;
  }

  let np = 0;
  // Root node: the 0-branch, then the 1-branch, which (both polynomials being odd) has
  // the complementary symbol pair 3 ^ lsym.
  let lsym = encodeSym(0);
  let m0 = metrics[lsym]!;
  let m1 = metrics[3 ^ lsym]!;
  if (m0 > m1) {
    tm[0] = m0;
    tm[1] = m1;
  } else {
    tm[0] = m1;
    tm[1] = m0;
    encstate[0] = 1;
  }
  const maxc = maxCycles * nbits;
  let t = 0;
  let i: number;
  for (i = 1; i <= maxc; i++) {
    // Look forward
    const g = gamma[np]!;
    const ngamma = g + tm[2 * np + br[np]!]!;
    if (ngamma >= t) {
      if (g < t + delta) {
        // First visit to this node: tighten the threshold.
        while (ngamma >= t + delta) t += delta;
      }
      const es = encstate[np]! << 1;
      np++; // move forward
      gamma[np] = ngamma;
      if (np === last + 1) {
        encstate[np] = es;
        break; // done
      }
      // ENCODE(lsym, es)
      let x = es & POLY1;
      x ^= x >>> 16;
      lsym = par[(x ^ (x >>> 8)) & 0xff]! << 1;
      x = es & POLY2;
      x ^= x >>> 16;
      lsym |= par[(x ^ (x >>> 8)) & 0xff]!;
      if (np >= tail) {
        // The tail is all zeros: no 1-branch.
        tm[2 * np] = metrics[4 * np + lsym]!;
        encstate[np] = es;
      } else {
        m0 = metrics[4 * np + lsym]!;
        m1 = metrics[4 * np + (3 ^ lsym)]!;
        if (m0 > m1) {
          tm[2 * np] = m0;
          tm[2 * np + 1] = m1;
          encstate[np] = es;
        } else {
          tm[2 * np] = m1;
          tm[2 * np + 1] = m0;
          encstate[np] = es + 1;
        }
      }
      br[np] = 0;
      continue;
    }
    // Threshold violated, can't go forward
    for (;;) {
      if (np === 0 || gamma[np - 1]! < t) {
        // Can't back up either: relax the threshold and look forward again.
        t -= delta;
        if (br[np] !== 0) {
          br[np] = 0;
          encstate[np] = encstate[np]! ^ 1;
        }
        break;
      }
      // Back up
      if (--np < tail && br[np] !== 1) {
        br[np] = br[np]! + 1; // try the next best branch
        encstate[np] = encstate[np]! ^ 1;
        break;
      }
    }
  }
  const nbytes = nbits >> 3;
  const data = new Uint8Array(nbytes);
  for (let b = 0; b < nbytes; b++) data[b] = encstate[7 + 8 * b]! & 0xff;
  return { ok: i < maxc, data, metric: gamma[np]!, cycles: i + 1 };
}
