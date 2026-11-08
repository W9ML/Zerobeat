import { describe, expect, it } from "vitest";

import { hellPrint } from "../src/digital/keyboard/hell.ts";

import { hellPhase } from "@zerobeat/core/ham/hell-align";

/** A pseudo-random sequence, so the test is the same every run. */
function rand(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

describe("hellPhase", () => {
  const text = hellPrint("CQ CQ CQ DE W9ML W9ML W9ML K");
  const cols = (px: Uint8Array) => Math.floor(px.length / 14);

  it("lines our own print up where it starts", () => {
    expect(hellPhase(text, 0, cols(text))).toBe(0);
  });

  it("finds a column start anywhere in the stream, through noise", () => {
    const r = rand(7);
    for (let shift = 1; shift < 14; shift++) {
      const px = new Uint8Array(text.length + shift);
      text.forEach((v, i) => (px[i + shift] = Math.min(255, v * 0.7 + 100 * r())));
      expect(hellPhase(px, 0, cols(px))).toBe(shift);
    }
  });

  it("says nothing for noise alone, or too little to go on", () => {
    const r = rand(3);
    const noise = Uint8Array.from({ length: 14 * 400 }, () => 140 * r());
    expect(hellPhase(noise, 0, 400)).toBeNull();
    expect(hellPhase(text, 0, 10)).toBeNull();
  });

  it("counts only the columns asked for", () => {
    const r = rand(5);
    const px = new Uint8Array(text.length + 4);
    text.forEach((v, i) => (px[i + 4] = v));
    const n = cols(px);
    // Noise over the first half; only the second half is to be used.
    for (let i = 0; i < 14 * Math.floor(n / 2); i++) px[i] = 255 * r();
    expect(hellPhase(px, 0, n, (k) => k >= n / 2)).toBe(4);
  });
});
