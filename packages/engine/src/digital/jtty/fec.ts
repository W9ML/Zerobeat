/**
 * JTTY forward error correction (WSJT-X lib/jtty/tbcc.f90, jtty_tbcc_code_profile.f90):
 *
 *   34 payload bits → CRC-12 (polynomial 0x80F, implicit leading term) → 46 bits
 *   → tail-biting rate-1/2 convolutional code, K=10 (octal 1167, 1545) → 92 bits
 *   → 46 Gray-coded 4-FSK tones (00,01,11,10 → 0,1,2,3)
 *
 * Decoding is a list Viterbi over the circular trellis (two wrap-around passes, as
 * WSJT-X does), keeping several survivors per state. At most four distinct closed
 * codewords are tried against the CRC and the reserved-zero bit, the same admission
 * rule WSJT-X uses, so a noise burst is very unlikely to slip through as text. A block
 * of 1, 2 or 4 symbols can be scored coherently (the tones are phase-continuous), which
 * is the "coherent ladder" WSJT-X uses for weak signals.
 */

export const PAYLOAD_BITS = 34;
export const INFO_BITS = 46;
const NU = 9;
const STATES = 1 << NU;
const G0 = 0o1167;
const G1 = 0o1545;
const CRC_POLY = 0x80f;
export const RESERVED_BIT = 32; // 0-based index of bit 33
const MAX_HYPOTHESES = 4;

function parity(v: number): number {
  v ^= v >> 16;
  v ^= v >> 8;
  v ^= v >> 4;
  v ^= v >> 2;
  v ^= v >> 1;
  return v & 1;
}

/** Tone for each 10-bit register value (oldest bit high, newest low). */
const TONE_OF_REG = new Uint8Array(1 << (NU + 1));
for (let r = 0; r < TONE_OF_REG.length; r++) {
  const b0 = parity(r & G0);
  const b1 = parity(r & G1);
  TONE_OF_REG[r] = [0, 1, 3, 2][2 * b0 + b1]!;
}

export function crc12(bits: ArrayLike<number>, n = bits.length): number {
  let reg = 0;
  for (let i = 0; i < n; i++) {
    reg ^= (bits[i]! & 1) << 11;
    reg = reg & 0x800 ? ((reg << 1) ^ CRC_POLY) & 0xfff : (reg << 1) & 0xfff;
  }
  return reg;
}

/** 34 payload bits → 46 information bits (payload + CRC, MSB first). */
export function withCrc(payload: ArrayLike<number>): number[] {
  const c = crc12(payload, PAYLOAD_BITS);
  const out = Array.from({ length: PAYLOAD_BITS }, (_, i) => payload[i]! & 1);
  for (let i = 11; i >= 0; i--) out.push((c >> i) & 1);
  return out;
}

/** 34 payload bits → 46 tone symbols (0-3). */
export function encodeTones(payload: ArrayLike<number>): number[] {
  const info = withCrc(payload);
  // Tail-biting: start in the state the last nu bits would leave.
  let state = 0;
  for (let t = 0; t < NU; t++) state = ((state << 1) | info[INFO_BITS - NU + t]!) & (STATES - 1);
  const tones: number[] = [];
  for (let t = 0; t < INFO_BITS; t++) {
    const reg = ((state << 1) | info[t]!) & ((1 << (NU + 1)) - 1);
    tones.push(TONE_OF_REG[reg]!);
    state = reg & (STATES - 1);
  }
  return tones;
}

export interface Correlation {
  re: Float64Array; // [symbol * 4 + tone]
  im: Float64Array;
}

/**
 * Decode 46 symbols of tone correlations. `coherent` is the block length (1, 2 or 4):
 * a block's metric is |Σ z|² over its symbols along the path, so 1 is plain energy
 * (non-coherent). Returns the 34 payload bits, or null.
 */
export function decodeFrame(z: Correlation, coherent: 1 | 2 | 4 = 1, perState = 4): number[] | null {
  return decodeBlocks(z, coherent, perState);
}

/**
 * One list-Viterbi decode over blocks of L symbols, with up to `width` survivors per
 * state. Survivors are kept in flat typed arrays with back-pointers, so a decode makes
 * no per-path allocations.
 */
function decodeBlocks(z: Correlation, L: number, width: number): number[] | null {
  const blocks: [number, number][] = [];
  for (let s = 0; s < INFO_BITS; s += L) blocks.push([s, Math.min(L, INFO_BITS - s)]);
  const nb = blocks.length;
  const W = width;
  const SW = STATES * W;
  const REGMASK = (1 << (NU + 1)) - 1;

  // Per block: branch metric and end state for every (state, input pattern).
  const branchM: Float64Array[] = [];
  const branchEnd: Int32Array[] = [];
  for (const [t0, len] of blocks) {
    const n = 1 << len;
    const bm = new Float64Array(STATES * n);
    const be = new Int32Array(STATES * n);
    for (let s = 0; s < STATES; s++) {
      for (let inputs = 0; inputs < n; inputs++) {
        let re = 0;
        let im = 0;
        let e = 0;
        let st = s;
        for (let k = 0; k < len; k++) {
          const bit = (inputs >> (len - 1 - k)) & 1;
          const reg = ((st << 1) | bit) & REGMASK;
          const i = (t0 + k) * 4 + TONE_OF_REG[reg]!;
          const zr = z.re[i]!;
          const zi = z.im[i]!;
          re += zr;
          im += zi;
          e += zr * zr + zi * zi;
          st = reg & (STATES - 1);
        }
        bm[s * n + inputs] = len === 1 ? e : re * re + im * im;
        be[s * n + inputs] = st;
      }
    }
    branchM.push(bm);
    branchEnd.push(be);
  }

  const metric = new Float64Array(SW);
  const start = new Int32Array(SW);
  const count = new Int32Array(STATES);
  let nMetric = new Float64Array(SW);
  let nStart = new Int32Array(SW);
  const nCount = new Int32Array(STATES);
  // Back-pointers for the kept pass: [block][dest*W + rank] = prevState*W + prevRank, and inputs.
  const back = Array.from({ length: nb }, () => new Int32Array(SW));
  const inp = Array.from({ length: nb }, () => new Int32Array(SW));

  const runPass = (keep: boolean) => {
    for (let k = 0; k < nb; k++) {
      const len = blocks[k]![1];
      const n = 1 << len;
      const bm = branchM[k]!;
      const be = branchEnd[k]!;
      nCount.fill(0);
      const bk = back[k]!;
      const ik = inp[k]!;
      for (let s = 0; s < STATES; s++) {
        const cs = count[s]!;
        for (let r = 0; r < cs; r++) {
          const m0 = metric[s * W + r]!;
          const st0 = start[s * W + r]!;
          for (let inputs = 0; inputs < n; inputs++) {
            const cand = m0 + bm[s * n + inputs]!;
            const d = be[s * n + inputs]!;
            let c = nCount[d]!;
            const base = d * W;
            if (c === W && cand <= nMetric[base + W - 1]!) continue;
            // Insert in descending order.
            let at = c < W ? c : W - 1;
            while (at > 0 && nMetric[base + at - 1]! < cand) {
              nMetric[base + at] = nMetric[base + at - 1]!;
              nStart[base + at] = nStart[base + at - 1]!;
              if (keep) {
                bk[base + at] = bk[base + at - 1]!;
                ik[base + at] = ik[base + at - 1]!;
              }
              at--;
            }
            nMetric[base + at] = cand;
            nStart[base + at] = st0;
            if (keep) {
              bk[base + at] = s * W + r;
              ik[base + at] = inputs;
            }
            if (c < W) nCount[d] = c + 1;
          }
        }
      }
      metric.set(nMetric);
      start.set(nStart);
      count.set(nCount);
    }
  };

  // Pass 1 from every state with metric 0; pass 2 starts each state with pass 1's best.
  for (let s = 0; s < STATES; s++) {
    metric[s * W] = 0;
    start[s * W] = s;
    count[s] = 1;
  }
  runPass(false);
  const settled = new Float64Array(STATES);
  for (let s = 0; s < STATES; s++) settled[s] = count[s]! > 0 ? metric[s * W]! : -1e300;
  for (let s = 0; s < STATES; s++) {
    metric[s * W] = settled[s]!;
    start[s * W] = s;
    count[s] = 1;
  }
  runPass(true);

  // Closed paths only, best first.
  const closed: { m: number; idx: number }[] = [];
  for (let s = 0; s < STATES; s++) for (let r = 0; r < count[s]!; r++) if (start[s * W + r] === s) closed.push({ m: metric[s * W + r]!, idx: s * W + r });
  closed.sort((a, b) => b.m - a.m);

  const seen = new Set<string>();
  let tried = 0;
  const bitsOut = new Uint8Array(INFO_BITS);
  for (const c of closed) {
    // Trace back through the blocks.
    let idx = c.idx;
    for (let k = nb - 1; k >= 0; k--) {
      const [t0, len] = blocks[k]!;
      const inputs = inp[k]![idx]!;
      for (let j = 0; j < len; j++) bitsOut[t0 + j] = (inputs >> (len - 1 - j)) & 1;
      idx = back[k]![idx]!;
    }
    const key = bitsOut.join("");
    if (seen.has(key)) continue;
    seen.add(key);
    if (++tried > MAX_HYPOTHESES) break;
    if (bitsOut[RESERVED_BIT] !== 0) continue;
    if (crc12(bitsOut, INFO_BITS) !== 0) continue;
    const payload = Array.from(bitsOut.subarray(0, PAYLOAD_BITS));
    if (payload.every((b) => b === 0)) return null;
    return payload;
  }
  return null;
}

/** WSJT-X's ladder: coherent blocks of 1, 2, then 4 symbols, the first success wins. */
export function decodeLadder(z: Correlation): { payload: number[]; coherent: number } | null {
  for (const L of [1, 2, 4] as const) {
    const p = decodeBlocks(z, L, 4);
    if (p) return { payload: p, coherent: L };
  }
  return null;
}
