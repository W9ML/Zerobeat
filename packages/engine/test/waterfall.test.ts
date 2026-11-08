import { describe, expect, it } from "vitest";

import { Waterfall } from "../src/dsp/dsp.ts";

function noise(n: number, amp: number, seed = 1): Float32Array {
  let s = seed;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((s / 0x7fffffff) * 2 - 1) * amp;
  }
  return out;
}

describe("Waterfall", () => {
  it("makes 20 rows a second once the first FFT is full", () => {
    const wf = new Waterfall();
    const rows = wf.push(noise(Waterfall.RATE * 3, 0.01));
    // 3 s of audio, first row after N samples, then one every HOP.
    expect(rows.length).toBe(Math.floor((Waterfall.RATE * 3 - Waterfall.N) / Waterfall.HOP) + 1);
    expect(Waterfall.ROWS_PER_SEC).toBe(20);
    expect(rows[0]!.length).toBe(wf.bins);
  });

  it("puts the noise near the floor and a tone well above it", () => {
    const wf = new Waterfall();
    const n = Waterfall.RATE * 4;
    const audio = noise(n, 0.01);
    for (let i = 0; i < n; i++) audio[i]! += 0.05 * Math.sin((2 * Math.PI * 1500 * i) / Waterfall.RATE);
    const rows = wf.push(audio);
    const last = rows.at(-1)!;
    const toDb = (v: number) => v / Waterfall.STEPS_PER_DB - Waterfall.DB_OFFSET;
    const toneBin = Math.round((1500 * Waterfall.N) / Waterfall.RATE);
    const sorted = [...last].sort((a, b) => a - b);
    const median = toDb(sorted[Math.floor(sorted.length / 2)]!);
    expect(Math.abs(median)).toBeLessThan(4);
    expect(toDb(last[toneBin]!)).toBeGreaterThan(30);
  });
});
