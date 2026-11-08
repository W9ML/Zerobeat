/**
 * JS8 forward error correction (JS8Call-improved JS8_Mode/JS8.cpp: CRC12, checkCRC12,
 * extractmessage174, the `parity` generator matrix, JS8::encode and bpdecode174; tables from
 * WSJT-X's ldpc_174_87_params.f90 by way of JS8Call):
 *
 *   72 frame bits (12 six-bit words) + 3-bit frame type = 75 bits
 *   → augmented CRC-12 (polynomial 0xC06, XOR 42) → 87 bits
 *   → (174,87) LDPC: 87 parity bits followed by the 87 message bits
 *
 * The XOR with 42 is what keeps a JS8 frame from passing as an FT8 frame with the same CRC.
 * Decoding is JS8Call's sum-product belief propagation (30 iterations, with its early-abort
 * rule), plus the ordered-statistics decoder (lib/ft8/osd174.f90) that the Fortran decoder
 * ran at depth 3 and up when BP failed.
 *
 * Bit conventions match JS8Call throughout: bits are 0/1, and a positive LLR means 1.
 */

export const N = 174;
export const K = 87;
export const M = N - K;
const BP_MAX_ITERATIONS = 30;

const GENERATOR_HEX = [
  "23bba830e23b6b6f50982e", "1f8e55da218c5df3309052", "ca7b3217cd92bd59a5ae20", "56f78313537d0f4382964e",
  "6be396b5e2e819e373340c", "293548a138858328af4210", "cb6c6afcdc28bb3f7c6e86", "3f2a86f5c5bd225c961150",
  "849dd2d63673481860f62c", "56cdaec6e7ae14b43feeee", "04ef5cfa3766ba778f45a4", "c525ae4bd4f627320a3974",
  "41fd9520b2e4abeb2f989c", "7fb36c24085a34d8c1dbc4", "40fc3e44bb7d2bb2756e44", "d38ab0a1d2e52a8ec3bc76",
  "3d0f929ef3949bd84d4734", "45d3814f504064f80549ae", "f14dbf263825d0bd04b05e", "db714f8f64e8ac7af1a76e",
  "8d0274de71e7c1a8055eb0", "51f81573dd4049b082de14", "d8f937f31822e57c562370", "b6537f417e61d1a7085336",
  "ecbd7c73b9cd34c3720c8a", "3d188ea477f6fa41317a4e", "1ac4672b549cd6dba79bcc", "a377253773ea678367c3f6",
  "0dbd816fba1543f721dc72", "ca4186dd44c3121565cf5c", "29c29dba9c545e267762fe", "1616d78018d0b4745ca0f2",
  "fe37802941d66dde02b99c", "a9fa8e50bcb032c85e3304", "83f640f1a48a8ebc0443ea", "3776af54ccfbae916afde6",
  "a8fc906976c35669e79ce0", "f08a91fb2e1f78290619a8", "cc9da55fe046d0cb3a770c", "d36d662a69ae24b74dcbd8",
  "40907b01280f03c0323946", "d037db825175d851f3af00", "1bf1490607c54032660ede", "0af7723161ec223080be86",
  "eca9afa0f6b01d92305edc", "7a8dec79a51e8ac5388022", "9059dfa2bb20ef7ef73ad4", "6abb212d9739dfc02580f2",
  "f6ad4824b87c80ebfce466", "d747bfc5fd65ef70fbd9bc", "612f63acc025b6ab476f7c", "05209a0abb530b9e7e34b0",
  "45b7ab6242b77474d9f11a", "6c280d2a0523d9c4bc5946", "f1627701a2d692fd9449e6", "8d9071b7e7a6a2eed6965e",
  "bf4f56e073271f6ab4bf80", "c0fc3ec4fb7d2bb2756644", "57da6d13cb96a7689b2790", "a9fa2eefa6f8796a355772",
  "164cc861bdd803c547f2ac", "cc6de59755420925f90ed2", "a0c0033a52ab6299802fd2", "b274db8abd3c6f396ea356",
  "97d4169cb33e7435718d90", "81cfc6f18c35b1e1f17114", "481a2a0df8a23583f82d6c", "081c29a10d468ccdbcecb6",
  "2c4142bf42b01e71076acc", "a6573f3dc8b16c9d19f746", "c87af9a5d5206abca532a8", "012dee2198eba82b19a1da",
  "b1ca4ea2e3d173bad4379c", "b33ec97be83ce413f9acc8", "5b0f7742bca86b8012609a", "37d8e0af9258b9e8c5f9b2",
  "35ad3fb0faeb5f1b0c30dc", "6114e08483043fd3f38a8a", "cd921fdf59e882683763f6", "95e45ecd0135aca9d6e6ae",
  "2e547dd7a05f6597aac516", "14cd0f642fc0c5fe3a65ca", "3a0a1dfd7eee29c2e827e0", "c8b5dffc335095dcdcaf2a",
  "3dd01a59d86310743ec752", "8abdb889efbe39a510a118", "3f231f212055371cf3e2a2",
];

const MN_FLAT = [
  0,24,68, 1,4,72, 2,31,67, 3,50,60, 5,62,69, 6,32,78, 7,49,85, 8,36,42,
  9,40,64, 10,13,63, 11,74,76, 12,22,80, 14,15,81, 16,55,65, 17,52,59, 18,30,51,
  19,66,83, 20,28,71, 21,23,43, 25,34,75, 26,35,37, 27,39,41, 29,53,54, 33,48,86,
  38,56,57, 44,73,82, 45,61,79, 46,47,84, 58,70,77, 0,49,52, 1,46,83, 2,24,78,
  3,5,13, 4,6,79, 7,33,54, 8,35,68, 9,42,82, 10,22,73, 11,16,43, 12,56,75,
  14,26,55, 15,27,28, 17,18,58, 19,39,62, 20,34,51, 21,53,63, 23,61,77, 25,31,76,
  29,71,84, 30,64,86, 32,38,50, 36,47,74, 37,69,70, 40,41,67, 44,66,85, 45,80,81,
  48,65,72, 57,59,65, 60,64,84, 0,13,20, 1,12,58, 2,66,81, 3,31,72, 4,35,53,
  5,42,45, 6,27,74, 7,32,70, 8,48,75, 9,57,63, 10,47,67, 11,18,44, 14,49,60,
  15,21,25, 16,71,79, 17,39,54, 19,34,50, 22,24,33, 23,62,86, 26,38,73, 28,77,82,
  29,69,76, 30,68,83, 21,36,85, 37,40,80, 41,43,56, 46,52,61, 51,55,78, 59,74,80,
  0,38,76, 1,15,40, 2,30,53, 3,35,77, 4,44,64, 5,56,84, 6,13,48, 7,20,45,
  8,14,71, 9,19,61, 10,16,70, 11,33,46, 12,67,85, 17,22,42, 18,63,72, 23,47,78,
  24,69,82, 25,79,86, 26,31,39, 27,55,68, 28,62,65, 29,41,49, 32,36,81, 34,59,73,
  37,54,83, 43,51,60, 50,52,71, 57,58,66, 46,55,75, 0,18,36, 1,60,74, 2,7,65,
  3,59,83, 4,33,38, 5,25,52, 6,31,56, 8,51,66, 9,11,14, 10,50,68, 12,13,64,
  15,30,42, 16,19,35, 17,79,85, 20,47,58, 21,39,45, 22,32,61, 23,29,73, 24,41,63,
  26,48,84, 27,37,72, 28,43,80, 34,67,69, 40,62,75, 44,48,70, 49,57,86, 47,53,82,
  12,54,78, 76,77,81, 0,1,23, 2,5,74, 3,55,86, 4,43,52, 6,49,82, 7,9,27,
  8,54,61, 10,28,66, 11,32,39, 13,15,19, 14,34,72, 16,30,38, 17,35,56, 18,45,75,
  20,41,83, 21,33,58, 22,25,60, 24,59,64, 26,63,79, 29,36,65, 31,44,71, 37,50,85,
  40,76,78, 42,55,67, 46,73,81, 39,51,77, 53,60,70, 45,57,68,
];

const NM_ROWS: readonly (readonly number[])[] = [
  [0,29,59,88,117,146], [1,30,60,89,118,146], [2,31,61,90,119,147], [3,32,62,91,120,148],
  [1,33,63,92,121,149], [4,32,64,93,122,147], [5,33,65,94,123,150], [6,34,66,95,119,151],
  [7,35,67,96,124,152], [8,36,68,97,125,151], [9,37,69,98,126,153], [10,38,70,99,125,154],
  [11,39,60,100,127,144], [9,32,59,94,127,155], [12,40,71,96,125,156], [12,41,72,89,128,155],
  [13,38,73,98,129,157], [14,42,74,101,130,158], [15,42,70,102,117,159], [16,43,75,97,129,155],
  [17,44,59,95,131,160], [18,45,72,82,132,161], [11,37,76,101,133,162], [18,46,77,103,134,146],
  [0,31,76,104,135,163], [19,47,72,105,122,162], [20,40,78,106,136,164], [21,41,65,107,137,151],
  [17,41,79,108,138,153], [22,48,80,109,134,165], [15,49,81,90,128,157], [2,47,62,106,123,166],
  [5,50,66,110,133,154], [23,34,76,99,121,161], [19,44,75,111,139,156], [20,35,63,91,129,158],
  [7,51,82,110,117,165], [20,52,83,112,137,167], [24,50,78,88,121,157], [21,43,74,106,132,154,171],
  [8,53,83,89,140,168], [21,53,84,109,135,160], [7,36,64,101,128,169], [18,38,84,113,138,149],
  [25,54,70,92,141,166], [26,55,64,95,132,159,173], [27,30,85,99,116,170], [27,51,69,103,131,143],
  [23,56,67,94,136,141], [6,29,71,109,142,150], [3,50,75,114,126,167], [15,44,86,113,124,171],
  [14,29,85,114,122,149], [22,45,63,90,143,172], [22,34,74,112,144,152], [13,40,86,107,116,148,169],
  [24,39,84,93,123,158], [24,57,68,115,142,173], [28,42,60,115,131,161], [14,57,87,111,120,163],
  [3,58,71,113,118,162,172], [26,46,85,97,133,152], [4,43,77,108,140], [9,45,68,102,135,164],
  [8,49,58,92,127,163], [13,56,57,108,119,165], [16,54,61,115,124,153], [2,53,69,100,139,169],
  [0,35,81,107,126,173], [4,52,80,104,139], [28,52,66,98,141,172], [17,48,73,96,114,166],
  [1,56,62,102,137,156], [25,37,78,111,134,170], [10,51,65,87,118,147], [19,39,67,116,140,159],
  [10,47,80,88,145,168], [28,46,79,91,145,171], [5,31,86,103,144,168], [26,33,73,105,130,164],
  [11,55,83,87,138], [12,55,61,110,145,170], [25,36,79,104,143,150], [16,30,81,112,120,160],
  [27,48,58,93,136], [6,54,82,100,130,167], [23,49,77,105,142,148],
];

/** Generator matrix row i, column j: whether message bit j feeds parity bit i. */
const GENERATOR: Uint8Array[] = GENERATOR_HEX.map((hex) => {
  const row = new Uint8Array(K);
  for (let col = 0; col < K; col++) {
    const nibble = parseInt(hex[col >> 2]!, 16);
    row[col] = (nibble >> (3 - (col & 3))) & 1;
  }
  return row;
});

/** For each bit, the three checks it takes part in. */
const MN: Int16Array = Int16Array.from(MN_FLAT);
/** For each check, the bits it covers (5 to 7 of them). */
const NM: Int16Array[] = NM_ROWS.map((r) => Int16Array.from(r));
/** For check i's j-th bit, which of that bit's three checks is i (saves the search in the inner loop). */
const NM_SLOT: Int8Array[] = NM.map((bits, i) =>
  Int8Array.from(bits, (b) => {
    for (let k = 0; k < 3; k++) if (MN[b * 3 + k] === i) return k;
    throw new Error("JS8 LDPC tables are inconsistent");
  }),
);

/** Pack bits (MSB first) into bytes. */
function packBits(bits: ArrayLike<number>, nbytes: number): Uint8Array {
  const out = new Uint8Array(nbytes);
  for (let i = 0; i < bits.length && i < nbytes * 8; i++) if (bits[i]) out[i >> 3]! |= 0x80 >> (i & 7);
  return out;
}

/**
 * boost::augmented_crc<12, 0xc06> over the bytes, XOR 42: the bytes are shifted through the
 * register MSB first with no initial value, the trailing zero bits of the buffer serving as
 * the augmentation.
 */
export function js8Crc12(bytes: ArrayLike<number>): number {
  let rem = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    for (let b = 7; b >= 0; b--) {
      const top = (rem >> 11) & 1;
      rem = ((rem << 1) | ((byte >> b) & 1)) & 0xfff;
      if (top) rem ^= 0xc06;
    }
  }
  return rem ^ 42;
}

/** 72 frame bits + 3 type bits → the 87 information bits with the CRC appended. */
export function withCrc12(bits75: ArrayLike<number>): Uint8Array {
  const bytes = packBits(Array.from({ length: 75 }, (_, i) => bits75[i]! & 1), 11);
  const crc = js8Crc12(bytes);
  const out = new Uint8Array(K);
  for (let i = 0; i < 75; i++) out[i] = bits75[i]! & 1;
  for (let i = 0; i < 12; i++) out[75 + i] = (crc >> (11 - i)) & 1;
  return out;
}

/** checkCRC12: does the 87-bit word carry a valid CRC over its first 75 bits? */
export function checkCrc12(bits87: ArrayLike<number>): boolean {
  const bytes = packBits(bits87, 11);
  const crc = ((bytes[9]! & 0x1f) << 7) | (bytes[10]! >> 1);
  bytes[9]! &= 0xe0;
  bytes[10] = 0;
  return crc === js8Crc12(bytes);
}

/** 87 information bits → 174-bit codeword: parity bits 0-86, message bits 87-173. */
export function ldpcEncode(bits87: ArrayLike<number>): Uint8Array {
  const cw = new Uint8Array(N);
  for (let i = 0; i < K; i++) {
    const row = GENERATOR[i]!;
    let sum = 0;
    for (let j = 0; j < K; j++) sum += row[j]! & bits87[j]!;
    cw[i] = sum & 1;
    cw[M + i] = bits87[i]! & 1;
  }
  return cw;
}

/** Number of unsatisfied parity checks for a hard-decision codeword (0 = valid). */
export function syndromeWeight(cw: ArrayLike<number>): number {
  let bad = 0;
  for (const bits of NM) {
    let s = 0;
    for (let j = 0; j < bits.length; j++) s += cw[bits[j]!]!;
    bad += s & 1;
  }
  return bad;
}

export interface BpResult {
  /** Hard-decision errors relative to the channel LLRs, or -1 if BP didn't converge. */
  hardErrors: number;
  /** The 174-bit hard-decision codeword at the last iteration. */
  cw: Uint8Array;
  /** The 87 message bits (cw[87..173]) when converged. */
  decoded: Uint8Array;
}

/**
 * Check → bit message 2·atanh(−T) through the Fortran decoder's platanh: a four-piece linear
 * fit that saturates at ±7. The C++ ports switched to an exact atanh, but on JS8Call's own
 * test recordings the exact version loses three frames that the Fortran js8 binary (which
 * the recordings' expected counts come from) decodes; the capped, piecewise messages keep
 * one confidently wrong check from swamping a bit.
 */
function checkMessage(product: number): number {
  const x = -product;
  const z = Math.abs(x);
  const sign = x < 0 ? -1 : 1;
  let y: number;
  if (z <= 0.664) y = x / 0.83;
  else if (z <= 0.9217) y = (sign * (z - 0.4064)) / 0.322;
  else if (z <= 0.9951) y = (sign * (z - 0.8378)) / 0.0524;
  else if (z <= 0.9998) y = (sign * (z - 0.9914)) / 0.0012;
  else y = sign * 7;
  return 2 * y;
}

/**
 * bpdecode174: sum-product decoding of the 174 channel LLRs. Gives up early, as JS8Call
 * does, when the number of failing checks has stopped falling for five iterations after
 * the tenth and more than 15 checks still fail.
 */
export function bpDecode174(llr: ArrayLike<number>): BpResult {
  const tov = new Float64Array(N * 3); // check → bit messages, by bit and slot
  const toc = new Float64Array(M * 7); // bit → check messages, by check and slot
  const tanhtoc = new Float64Array(M * 7);
  const zn = new Float64Array(N);
  const cw = new Uint8Array(N);
  let ncnt = 0;
  let nclast = 0;

  for (let i = 0; i < M; i++) {
    const bits = NM[i]!;
    for (let j = 0; j < bits.length; j++) toc[i * 7 + j] = llr[bits[j]!]!;
  }

  for (let iter = 0; iter <= BP_MAX_ITERATIONS; iter++) {
    for (let i = 0; i < N; i++) {
      zn[i] = llr[i]! + tov[i * 3]! + tov[i * 3 + 1]! + tov[i * 3 + 2]!;
      cw[i] = zn[i]! > 0 ? 1 : 0;
    }

    let ncheck = 0;
    for (let i = 0; i < M; i++) {
      const bits = NM[i]!;
      let s = 0;
      for (let j = 0; j < bits.length; j++) s += cw[bits[j]!]!;
      if (s & 1) ncheck++;
    }

    if (ncheck === 0) {
      let nerr = 0;
      for (let i = 0; i < N; i++) if ((2 * cw[i]! - 1) * llr[i]! < 0) nerr++;
      return { hardErrors: nerr, cw, decoded: cw.slice(M) };
    }

    if (iter > 0) {
      const nd = ncheck - nclast;
      ncnt = nd < 0 ? 0 : ncnt + 1;
      if (ncnt >= 5 && iter >= 10 && ncheck > 15) break;
    }
    nclast = ncheck;

    // Bit → check: everything the bit knows except what this check told it.
    for (let i = 0; i < M; i++) {
      const bits = NM[i]!;
      const slots = NM_SLOT[i]!;
      for (let j = 0; j < bits.length; j++) {
        const b = bits[j]!;
        const v = zn[b]! - tov[b * 3 + slots[j]!]!;
        toc[i * 7 + j] = v;
        tanhtoc[i * 7 + j] = Math.tanh(-v / 2);
      }
    }

    // Check → bit: the product over the check's other bits.
    for (let i = 0; i < M; i++) {
      const bits = NM[i]!;
      const slots = NM_SLOT[i]!;
      const n = bits.length;
      for (let j = 0; j < n; j++) {
        let t = 1;
        for (let k = 0; k < n; k++) if (k !== j) t *= tanhtoc[i * 7 + k]!;
        tov[bits[j]! * 3 + slots[j]!] = checkMessage(t);
      }
    }
  }

  return { hardErrors: -1, cw, decoded: cw.slice(M) };
}

/* -------------------------------------------------------------------------------------- */
/* Ordered-statistics decoding (osd174.f90)                                                */
/* -------------------------------------------------------------------------------------- */

/** Systematic generator rows in received (codeword) order: message bit k → its 174-bit row. */
const GEN_ROWS: Uint8Array[] = Array.from({ length: K }, (_, k) => {
  const row = new Uint8Array(N);
  for (let i = 0; i < M; i++) row[i] = GENERATOR[i]![k]!;
  row[M + k] = 1;
  return row;
});

export interface OsdResult {
  /** Hard-decision disagreements between the chosen codeword and the channel. */
  hardErrors: number;
  /** Sum of |LLR| over those disagreements (the OSD distance). */
  dmin: number;
  cw: Uint8Array;
  decoded: Uint8Array;
}

/** OSD search parameters for ndeep 1-5 (osd174.f90). */
const OSD_DEPTH = [
  null,
  { nord: 1, npre1: 0, npre2: 0, nt: 40, ntheta: 12, ntau: 0 },
  { nord: 1, npre1: 1, npre2: 0, nt: 40, ntheta: 12, ntau: 0 },
  { nord: 1, npre1: 1, npre2: 1, nt: 40, ntheta: 12, ntau: 14 },
  { nord: 2, npre1: 1, npre2: 0, nt: 40, ntheta: 12, ntau: 19 },
  { nord: 2, npre1: 1, npre2: 1, nt: 40, ntheta: 12, ntau: 19 },
] as const;

/** nextpat: step `mi` to the next weight-`iorder` pattern; returns its lowest set index, or -1 when done. */
function nextPattern(mi: Uint8Array, iorder: number): number {
  const k = mi.length;
  let ind = -1;
  for (let i = 0; i < k - 1; i++) if (mi[i] === 0 && mi[i + 1] === 1) ind = i;
  if (ind < 0) return -1;
  const ms = new Uint8Array(k);
  for (let i = 0; i < ind; i++) ms[i] = mi[i]!;
  ms[ind] = 1;
  ms[ind + 1] = 0;
  if (ind + 1 < k - 1) {
    let sum = 0;
    for (let i = 0; i < k; i++) sum += ms[i]!;
    const nz = iorder - sum;
    for (let i = k - nz; i < k; i++) ms[i] = 1;
  }
  mi.set(ms);
  for (let i = 0; i < k; i++) if (mi[i] === 1) return i;
  return -1;
}

/**
 * osd174: re-encode from the K most reliable independent positions, then try flipping one
 * (and, at higher depths, two) of those positions, keeping the codeword closest to the
 * channel. It always returns some codeword; only the caller's CRC check makes it a decode.
 */
export function osdDecode174(llr: ArrayLike<number>, ndeep: number): OsdResult {
  const rx = Float64Array.from({ length: N }, (_, i) => llr[i]!);
  const absrx0 = rx.map(Math.abs);

  // Columns by decreasing reliability.
  const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => absrx0[b]! - absrx0[a]! || b - a);
  const indices = Int32Array.from(order);
  const genmrb: Uint8Array[] = GEN_ROWS.map((row) => Uint8Array.from(indices, (c) => row[c]!));

  // Gaussian elimination so the first K columns become the identity, swapping in a later
  // column (no more than 20 past the diagonal, as the Fortran does) when a pivot is missing.
  for (let id = 0; id < K; id++) {
    for (let icol = id; icol < K + 20; icol++) {
      if (genmrb[id]![icol] !== 1) continue;
      if (icol !== id) {
        for (let r = 0; r < K; r++) {
          const row = genmrb[r]!;
          const t = row[id]!;
          row[id] = row[icol]!;
          row[icol] = t;
        }
        const t = indices[id]!;
        indices[id] = indices[icol]!;
        indices[icol] = t;
      }
      const pivot = genmrb[id]!;
      for (let ii = 0; ii < K; ii++) {
        const row = genmrb[ii]!;
        if (ii !== id && row[id] === 1) for (let c = 0; c < N; c++) row[c]! ^= pivot[c]!;
      }
      break;
    }
  }

  const hdec = Uint8Array.from(indices, (c) => (rx[c]! >= 0 ? 1 : 0));
  const absrx = Float64Array.from(indices, (c) => absrx0[c]!);
  const m0 = hdec.slice(0, K);

  const encode = (me: Uint8Array, out: Uint8Array): void => {
    out.fill(0);
    for (let k = 0; k < K; k++) {
      if (!me[k]) continue;
      const row = genmrb[k]!;
      for (let c = 0; c < N; c++) out[c]! ^= row[c]!;
    }
  };
  const distance = (c: Uint8Array): { hard: number; d: number } => {
    let hard = 0;
    let d = 0;
    for (let i = 0; i < N; i++) {
      if (c[i] !== hdec[i]) {
        hard++;
        d += absrx[i]!;
      }
    }
    return { hard, d };
  };

  let cw = new Uint8Array(N);
  encode(m0, cw);
  let { hard: nhardmin, d: dmin } = distance(cw);

  const p = ndeep > 0 ? OSD_DEPTH[Math.min(ndeep, 5)]! : null;
  if (p) {
    const ce = new Uint8Array(N);
    const me = new Uint8Array(K);
    const mi = new Uint8Array(K);
    const misub = new Uint8Array(K);
    const e2sub = new Uint8Array(M);
    const e2 = new Uint8Array(M);

    for (let iorder = 1; iorder <= p.nord; iorder++) {
      misub.fill(0);
      misub.fill(1, K - iorder);
      let iflag = K - iorder;
      while (iflag >= 0) {
        const iend = iorder === p.nord && p.npre1 === 0 ? iflag : 0;
        let d1 = 0;
        for (let n1 = iflag; n1 >= iend; n1--) {
          mi.set(misub);
          mi[n1] = 1;
          for (let k = 0; k < K; k++) me[k] = m0[k]! ^ mi[k]!;
          let nd1Kpt: number;
          if (n1 === iflag) {
            encode(me, ce);
            for (let i = 0; i < M; i++) e2sub[i] = ce[K + i]! ^ hdec[K + i]!;
            nd1Kpt = 1;
            for (let i = 0; i < p.nt; i++) nd1Kpt += e2sub[i]!;
            d1 = 0;
            for (let k = 0; k < K; k++) if (me[k] !== hdec[k]) d1 += absrx[k]!;
          } else {
            // Flipping message position n1 adds its generator row to the parity residual.
            const g = genmrb[n1]!;
            for (let i = 0; i < M; i++) e2[i] = e2sub[i]! ^ g[K + i]!;
            nd1Kpt = 2;
            for (let i = 0; i < p.nt; i++) nd1Kpt += e2[i]!;
          }
          if (nd1Kpt <= p.ntheta) {
            encode(me, ce);
            let dd = d1;
            if (n1 !== iflag && ce[n1] !== hdec[n1]) dd += absrx[n1]!;
            const e = n1 === iflag ? e2sub : e2;
            for (let i = 0; i < M; i++) if (e[i]) dd += absrx[K + i]!;
            if (dd < dmin) {
              dmin = dd;
              cw = ce.slice();
              nhardmin = distance(ce).hard;
            }
          }
        }
        iflag = nextPattern(misub, iorder);
      }
    }

    if (p.npre2 === 1) {
      // Bucket every pair of message positions by the pattern their two rows make on the
      // first ntau parity positions (boxit), so the search can go straight to the pairs
      // that would cancel the residual there (fetchit).
      const ntau = p.ntau;
      const head = new Int32Array(1 << ntau).fill(-1);
      const next: number[] = [-1];
      const pairs: [number, number][] = [[-1, -1]];
      for (let i1 = K - 1; i1 >= 0; i1--) {
        for (let i2 = i1 - 1; i2 >= 0; i2--) {
          const a = genmrb[i1]!;
          const b = genmrb[i2]!;
          let pat = 0;
          for (let t = 0; t < ntau; t++) pat = (pat << 1) | (a[K + t]! ^ b[K + t]!);
          const idx = pairs.length;
          pairs.push([i1, i2]);
          next.push(-1);
          let ip = head[pat]!;
          if (ip === -1) head[pat] = idx;
          else {
            while (next[ip] !== -1) ip = next[ip]!;
            next[ip] = idx;
          }
        }
      }

      // fetchit keeps its position between calls; a repeated pattern continues the list.
      let lastpat = -1;
      let inext = -1;
      const fetch = (pat: number): readonly [number, number] => {
        const index = head[pat]!;
        let r: readonly [number, number] = [-1, -1];
        if (lastpat !== pat && index > 0) {
          r = pairs[index]!;
          inext = next[index]!;
        } else if (lastpat === pat && inext > 0) {
          r = pairs[inext]!;
          inext = next[inext]!;
        } else inext = -1;
        lastpat = pat;
        return r;
      };

      misub.fill(0);
      misub.fill(1, K - p.nord);
      let iflag = K - p.nord;
      while (iflag >= 0) {
        for (let k = 0; k < K; k++) me[k] = m0[k]! ^ misub[k]!;
        encode(me, ce);
        for (let i = 0; i < M; i++) e2sub[i] = ce[K + i]! ^ hdec[K + i]!;
        for (let i2 = 0; i2 <= ntau; i2++) {
          let pat = 0;
          for (let t = 0; t < ntau; t++) pat = (pat << 1) | (e2sub[t]! ^ (t === i2 - 1 ? 1 : 0));
          for (;;) {
            const [in1, in2] = fetch(pat);
            if (in1 < 0 || in2 < 0) break;
            mi.set(misub);
            mi[in1] = 1;
            mi[in2] = 1;
            let w = 0;
            for (let k = 0; k < K; k++) w += mi[k]!;
            if (w < p.nord + p.npre1 + p.npre2) break;
            for (let k = 0; k < K; k++) me[k] = m0[k]! ^ mi[k]!;
            encode(me, ce);
            const { hard, d } = distance(ce);
            if (d < dmin) {
              dmin = d;
              cw = ce.slice();
              nhardmin = hard;
            }
          }
        }
        iflag = nextPattern(misub, p.nord);
      }
    }
  }

  // Back to received order.
  const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) out[indices[i]!] = cw[i]!;
  return { hardErrors: nhardmin, dmin, cw: out, decoded: out.slice(M) };
}
