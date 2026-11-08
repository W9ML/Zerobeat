import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { bpDecode174, checkCrc12, js8Crc12, ldpcEncode, osdDecode174, syndromeWeight, withCrc12 } from "../src/digital/js8/ldpc.ts";
import { decodeJs8, encodeJs8, js8FrameBits, js8Waveform, type Js8Decode } from "../src/digital/js8/modem.ts";
import { COSTAS_MODIFIED, COSTAS_ORIGINAL, JS8_SUBMODES, SYNC_POSITIONS, type Js8Submode } from "../src/digital/js8/params.ts";

/** Deterministic Gaussian noise (LCG + Box-Muller) so failures reproduce. */
function makeNoise(seed: number): () => number {
  let s = seed >>> 0;
  const u = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s + 0.5) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

function readWav(name: string): Float32Array {
  const b = readFileSync(new URL(`./fixtures/js8/${name}`, import.meta.url));
  for (let o = 12; o + 8 <= b.length; ) {
    const id = b.toString("ascii", o, o + 4);
    const size = b.readUInt32LE(o + 4);
    if (id === "data") {
      const n = size >> 1;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(o + 8 + 2 * i) / 32768;
      return out;
    }
    o += 8 + size + (size & 1);
  }
  throw new Error(`${name}: no data chunk`);
}

const randomBits = (n: number, next: () => number) => Array.from({ length: n }, () => (next() > 0 ? 1 : 0));

describe("JS8 CRC-12 and (174,87) LDPC", () => {
  it("round-trips the CRC and rejects any single-bit error", () => {
    const g = makeNoise(1);
    for (let t = 0; t < 20; t++) {
      const bits = withCrc12(randomBits(75, g));
      expect(checkCrc12(bits)).toBe(true);
      for (const flip of [0, 40, 74, 75, 86]) {
        const bad = bits.slice();
        bad[flip]! ^= 1;
        expect(checkCrc12(bad)).toBe(false);
      }
    }
  });

  it("computes the augmented CRC over zero-padded bytes and XORs 42", () => {
    // An all-zero message has remainder 0, so the transmitted CRC is just the XOR constant.
    expect(js8Crc12(new Uint8Array(11))).toBe(42);
    const bits = withCrc12(new Array(75).fill(0));
    let crc = 0;
    for (let i = 75; i < 87; i++) crc = (crc << 1) | bits[i]!;
    expect(crc).toBe(42);
  });

  it("encodes to valid codewords that BP and OSD both recover", () => {
    const g = makeNoise(2);
    for (let t = 0; t < 10; t++) {
      const info = withCrc12(randomBits(75, g));
      const cw = ldpcEncode(info);
      expect(syndromeWeight(cw)).toBe(0);
      expect(Array.from(cw.slice(87))).toEqual(Array.from(info));

      // Noisy LLRs at a few dB Eb/N0: BP fixes the hard-decision errors.
      const llr = Array.from(cw, (b) => (b ? 1 : -1) * 2.5 + 1.6 * g());
      const hardErrs = llr.reduce((n, v, i) => n + ((v > 0 ? 1 : 0) !== cw[i] ? 1 : 0), 0);
      const bp = bpDecode174(llr);
      expect(bp.hardErrors).toBe(hardErrs);
      expect(Array.from(bp.decoded)).toEqual(Array.from(info));

      // Erase a third of the bits outright, which usually stalls BP: OSD still finds it.
      const erased = Array.from(cw, (b, i) => (i % 3 === 0 ? 0 : (b ? 1 : -1) * 2.5 + 1.0 * g()));
      const osd = osdDecode174(erased, 3);
      expect(Array.from(osd.decoded)).toEqual(Array.from(info));
    }
  });
});

describe("JS8 framing and waveform", () => {
  it("lays out Costas, parity and message symbols as JS8Call does", () => {
    for (const [mode, costas] of [["normal", COSTAS_ORIGINAL], ["fast", COSTAS_MODIFIED]] as const) {
      const tones = encodeJs8("SIUT1UuGBfqb", 3, mode);
      expect(tones).toHaveLength(79);
      SYNC_POSITIONS.forEach((pos, b) => expect(tones.slice(pos, pos + 7)).toEqual(costas[b]));
      const cw = ldpcEncode(js8FrameBits("SIUT1UuGBfqb", 3));
      const data = [...tones.slice(7, 36), ...tones.slice(43, 72)];
      data.forEach((tone, j) => expect(tone).toBe(4 * cw[3 * j]! + 2 * cw[3 * j + 1]! + cw[3 * j + 2]!));
    }
    expect(() => encodeJs8("too short", 0)).toThrow();
    expect(() => encodeJs8("HELLO WORLD!", 0)).toThrow();
  });

  it("derives the submode timing JS8Call uses", () => {
    expect(JS8_SUBMODES.normal).toMatchObject({ nsps: 1920, periodSec: 15, startDelayMs: 500, toneSpacingHz: 6.25, bandwidthHz: 50, samplesNeeded: 151680 + 12000 });
    expect(JS8_SUBMODES.fast).toMatchObject({ nsps: 1200, periodSec: 10, startDelayMs: 200, toneSpacingHz: 10 });
    expect(JS8_SUBMODES.turbo).toMatchObject({ nsps: 600, periodSec: 6, startDelayMs: 100, toneSpacingHz: 20 });
    expect(JS8_SUBMODES.slow).toMatchObject({ nsps: 3840, periodSec: 30, startDelayMs: 500, toneSpacingHz: 3.125 });
    expect(JS8_SUBMODES.normal.txDurationSec).toBeCloseTo(0.5 + 12.64, 6);
  });

  it("is phase-continuous 8-FSK at the requested rate", () => {
    const tones = encodeJs8("VlPJy-uGBfqI", 3);
    const w = js8Waveform(tones, 1000, 48000);
    expect(w.length).toBe(79 * 1920 * 4);
    let maxStep = 0;
    for (let i = 1; i < w.length; i++) maxStep = Math.max(maxStep, Math.abs(w[i]! - w[i - 1]!));
    // The steepest sample-to-sample change of a unit sine at ≤1044 Hz sampled at 48 kHz.
    expect(maxStep).toBeLessThan((2 * Math.PI * 1044) / 48000 + 1e-3);
    expect(Math.abs(w[w.length - 1]!)).toBeLessThan(0.1); // faded out at key-up
  });
});

describe("JS8 encode → waveform → decode", () => {
  const cases: [Js8Submode, string, number, number][] = [
    ["normal", "SKflsHSNwzqH", 3, 1210.0],
    ["fast", "u3ipItc4eML+", 0, 875.0],
    ["turbo", "TrMcT8++++++", 7, 1500.0],
    ["slow", "Vk4xfHSNwzaX", 5, 731.0],
  ];
  it.each(cases)("%s round trip in noise", (mode, msg, i3, f0) => {
    const p = JS8_SUBMODES[mode];
    const g = makeNoise(42 + i3);
    const x = new Float32Array(p.periodSec * 12000);
    const sigma = 0.05;
    // -12 dB in 2500 Hz.
    const amp = Math.sqrt(2 * ((sigma * sigma * 2500) / 6000) * 10 ** (-12 / 10));
    const dt = 0.3;
    const off = Math.round((p.startDelayMs / 1000 + dt) * 12000);
    const w = js8Waveform(encodeJs8(msg, i3, mode), f0, 12000, mode);
    for (let i = 0; i < x.length; i++) x[i] = sigma * g();
    for (let i = 0; i < w.length && off + i < x.length; i++) x[off + i]! += amp * w[i]!;
    const got = decodeJs8(x, mode);
    expect(got).toHaveLength(1);
    expect(got[0]!.message12).toBe(msg);
    expect(got[0]!.i3).toBe(i3);
    expect(Math.abs(got[0]!.freqHz - f0)).toBeLessThan(p.toneSpacingHz / 4);
    expect(Math.abs(got[0]!.dtSec - dt)).toBeLessThan(((p.nsps / 12000) * 0.25) + 0.01);
  });

  it("decodes several clean signals together and doesn't confuse submodes", () => {
    const p = JS8_SUBMODES.normal;
    const x = new Float32Array(p.periodSec * 12000);
    const g = makeNoise(7);
    for (let i = 0; i < x.length; i++) x[i] = 0.01 * g();
    const msgs = ["VkDSPUuGBfqa", "SIUT1UuGBfqb", "SQu8IUuGBfqL"];
    msgs.forEach((m, k) => {
      const w = js8Waveform(encodeJs8(m, 3), 700 + 300 * k);
      const off = 6000 + 1200 * k;
      for (let i = 0; i < w.length && off + i < x.length; i++) x[off + i]! += 0.2 * w[i]!;
    });
    const got = decodeJs8(x, "normal").map((d) => d.message12).sort();
    expect(got).toEqual([...msgs].sort());
    // Fast uses different Costas arrays and timing; nothing should come out.
    expect(decodeJs8(x.subarray(0, 120000), "fast")).toEqual([]);
  });
});

/**
 * JS8Call's media/tests recordings, named {MODE}_{DEPTH}_{EXPECTED}.wav. `reference` is what
 * the Fortran js8 decoder from JS8Call 2.2 (js8.exe -8 -b MODE -d DEPTH) prints for each
 * file: frame and reported SNR.
 */
const RECORDINGS: { file: string; reference: [string, number][]; note?: string }[] = [
  { file: "A_1_4.wav", reference: [["SKflsHSNwzqH", -1], ["Vk4xfHSNwzaX", -11], ["SJWkJnSNwzqH", -3], ["2Y-wUW3FOjFp", -19]] },
  { file: "A_2_1.wav", reference: [], note: "js8.exe itself decodes nothing from this file at any depth" },
  { file: "A_2_3.wav", reference: [["Uw2nt-xLZLqO", -14], ["VlPJy-uGBfqF", -2]], note: "js8.exe finds the third frame (SJDRf-vSO3y0) only at depth 3, with OSD" },
  { file: "A_2_5.wav", reference: [["SKflsHSNwzqH", -1], ["Vk4xfHSNwzaX", -11], ["SJWkJnSNwzqH", -3], ["2Y-wUW3FOjFp", -19], ["UctD9HSNwzqE", -11]] },
  {
    file: "A_2_6.wav",
    reference: [["SIUT18l+CDqE", 11], ["VkB4eel+CDqS", 0], ["SQu8I8l+CDqR", 4], ["u3ipItc4eML+", 0], ["SJff78l+CDqP", -9], ["VlKXp8l+CDqI", -1]],
  },
  {
    file: "A_2_9.wav",
    reference: [
      ["VkDSPUuGBfqa", 5], ["SIUT1UuGBfqb", 13], ["VkNoM-uGBfqK", 4], ["SKgyQ-uGBfqU", -22], ["Uw2nt-uGBfqS", -16],
      ["SQu8IUuGBfqL", 0], ["VlPJy-uGBfqI", -4], ["SJff7UuGBfqY", -5], ["QB+p3UuGBfqK", -3],
    ],
  },
  { file: "A_3_3.wav", reference: [["Uw2nt-xLZLqO", -14], ["VlPJy-uGBfqF", -2], ["SJDRf-vSO3y0", -18]] },
  { file: "E_1_1.wav", reference: [["TrMcT8++++++", 28]] },
  { file: "E_2_1.wav", reference: [["TrMcT8++++++", 28]] },
];

/** Recordings whose file-name count JS8Call 2.2's own decoder doesn't reach either (see `note`). */
const UNREACHABLE = new Set(["A_2_1.wav", "A_2_3.wav"]);

describe("JS8Call's test recordings", () => {
  const results = new Map<string, { decodes: Js8Decode[]; ms: number }>();
  const run = (file: string) => {
    let r = results.get(file);
    if (!r) {
      const [mode, depth] = file.replace(".wav", "").split("_");
      const audio = readWav(file);
      const t0 = performance.now();
      const decodes = decodeJs8(audio, mode === "A" ? "normal" : "slow", { depth: Number(depth) as 1 | 2 | 3 });
      r = { decodes, ms: performance.now() - t0 };
      results.set(file, r);
      console.log(
        `${file}: ${decodes.length} decode(s) in ${r.ms.toFixed(0)} ms\n` +
          decodes
            .slice()
            .sort((a, b) => a.freqHz - b.freqHz)
            .map((d) => `  ${d.message12}  i3=${d.i3}  ${d.freqHz.toFixed(1)} Hz  dt ${d.dtSec.toFixed(2)} s  ${d.snrDb.toFixed(0)} dB  hard ${d.hardErrors}`)
            .join("\n"),
      );
    }
    return r;
  };

  /** Same frames as js8.exe, each SNR within 1 dB of what it reports (all match exactly today). */
  const expectLikeReference = (decodes: Js8Decode[], reference: [string, number][]) => {
    expect(decodes.map((d) => d.message12).sort()).toEqual(reference.map(([m]) => m).sort());
    for (const [m, snr] of reference) expect(Math.abs(Math.round(decodes.find((d) => d.message12 === m)!.snrDb) - snr)).toBeLessThanOrEqual(1);
  };

  it.each(RECORDINGS.filter((r) => !UNREACHABLE.has(r.file)))("$file gives the expected count, frames and SNRs", ({ file, reference }) => {
    const expected = Number(file.replace(".wav", "").split("_")[2]);
    const { decodes } = run(file);
    expect(decodes).toHaveLength(expected);
    expectLikeReference(decodes, reference);
  });

  it.each(RECORDINGS.filter((r) => UNREACHABLE.has(r.file)))("$file matches js8.exe, short of the name — $note", ({ file, reference }) => {
    const expected = Number(file.replace(".wav", "").split("_")[2]);
    const { decodes } = run(file);
    expectLikeReference(decodes, reference);
    expect(decodes.length).toBeLessThan(expected);
  });

  // A speed budget for a desktop; skipped on a busy station (deploy/build.sh sets this).
  it.skipIf(!!process.env.ZEROBEAT_SKIP_SPEED)("decodes a 15 s Normal period well under 2 s", () => {
    const { ms } = run("A_2_9.wav");
    expect(ms).toBeLessThan(2000);
  });
});

describe("JS8 SNR scale", () => {
  // Four signals in white noise at a known SNR in 2500 Hz. The expected readings are what
  // JS8Call 2.2's js8.exe reports for the same files (it reads Normal 1 dB low, Slow 1 dB
  // high, and Fast and Turbo several dB low; it compresses strong signals).
  it.each([
    ["normal", -18, -19],
    ["normal", -10, -11],
    ["normal", 0, -1],
    ["normal", 10, 8],
    ["fast", -10, -14],
    ["turbo", 0, -9],
    ["slow", -18, -17],
    ["slow", -10, -9],
  ] as [Js8Submode, number, number][])("%s at %d dB reads %d dB, as js8.exe does", (mode, snr, reads) => {
    const p = JS8_SUBMODES[mode];
    const g = makeNoise(777 + snr);
    const sigma = 300 / 32768;
    const x = new Float32Array(p.periodSec * 12000);
    for (let i = 0; i < x.length; i++) x[i] = sigma * g();
    const amp = Math.sqrt(2 * ((sigma * sigma * 2500) / 6000) * 10 ** (snr / 10));
    const msgs = ["SKflsHSNwzqH", "Vk4xfHSNwzaX", "SJWkJnSNwzqH", "2Y-wUW3FOjFp"];
    msgs.forEach((m, k) => {
      const w = js8Waveform(encodeJs8(m, 3, mode), 600 + 500 * k, 12000, mode);
      const off = p.startDelayMs * 12 + 1200;
      for (let i = 0; i < w.length; i++) x[off + i]! += amp * w[i]!;
    });
    const got = decodeJs8(x, mode);
    expect(got.map((d) => d.message12).sort()).toEqual([...msgs].sort());
    for (const d of got) expect(Math.abs(d.snrDb - reads)).toBeLessThanOrEqual(1.5);
  });
});

describe("JS8 false-decode resistance", () => {
  it("finds nothing in 60 s of Gaussian noise", () => {
    const g = makeNoise(20261020);
    const noise = new Float32Array(60 * 12000);
    for (let i = 0; i < noise.length; i++) noise[i] = 0.05 * g();
    const found: string[] = [];
    for (let k = 0; k < 4; k++) {
      const period = noise.subarray(k * 180000, (k + 1) * 180000);
      for (const depth of [1, 2, 3] as const) found.push(...decodeJs8(period, "normal", { depth }).map((d) => `normal d${depth}: ${d.message12}`));
    }
    for (let k = 0; k < 6; k++) found.push(...decodeJs8(noise.subarray(k * 120000, (k + 1) * 120000), "fast").map((d) => `fast: ${d.message12}`));
    for (let k = 0; k < 10; k++) found.push(...decodeJs8(noise.subarray(k * 72000, (k + 1) * 72000), "turbo").map((d) => `turbo: ${d.message12}`));
    for (let k = 0; k < 2; k++) found.push(...decodeJs8(noise.subarray(k * 360000, (k + 1) * 360000), "slow").map((d) => `slow: ${d.message12}`));
    expect(found).toEqual([]);
  });
});
