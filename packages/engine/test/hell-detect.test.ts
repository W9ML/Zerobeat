import { describe, expect, it } from "vitest";

import { cwWaveform } from "../src/digital/keyboard/cw.ts";
import { HellDetector, type HellSeen } from "../src/digital/keyboard/hell-detect.ts";
import { HELL_SPEEDS, hellWaveform, type HellSpeed } from "../src/digital/keyboard/hell.ts";
import { KeyboardDesk } from "../src/operate/keyboard.ts";

const RATE = 12_000;

/** Gaussian-ish noise, the same every run. */
function noise(n: number, level: number, seed = 1): Float32Array {
  let s = seed;
  const r = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return Float32Array.from({ length: n }, () => level * (r() + r() + r() + r() - 2));
}

/** Everything the detector said about `signal` (at `amp`) in noise, the marker at `rxHz`. */
function detect(signal: Float32Array, rxHz = 1500, amp = 0.3): HellSeen[] {
  const x = noise(signal.length + RATE * 2, 0.1);
  for (let i = 0; i < signal.length; i++) x[i + RATE] = x[i + RATE]! + amp * signal[i]!;
  const seen: HellSeen[] = [];
  const d = new HellDetector((s) => seen.push(s));
  d.rxHz = rxHz;
  for (let i = 0; i < x.length; i += 480) d.push(x.subarray(i, i + 480), (i / RATE) * 1000);
  return seen;
}

/** Enough text to fill `seconds` at a speed. */
function text(speed: HellSpeed, seconds: number): string {
  const chars = Math.ceil((seconds * HELL_SPEEDS[speed].pxPerSec) / 14 / 7);
  return "CQ CQ DE W9ML W9ML K RYRY 73 ".repeat(Math.ceil(chars / 29)).slice(0, chars);
}

/** The answer it settled on: the most common one in the second half. */
function settled(seen: HellSeen[]): string {
  const late = seen.slice(Math.floor(seen.length / 2)).map((s) => `${s.kind}${s.speed ? ` ${s.speed}` : ""}${s.reverse ? " rev" : ""}`);
  const count = new Map<string, number>();
  for (const k of late) count.set(k, (count.get(k) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "nothing";
}

describe("HellDetector", () => {
  for (const speed of Object.keys(HELL_SPEEDS) as HellSpeed[]) {
    it(`names ${HELL_SPEEDS[speed].label}`, () => {
      const seconds = speed === "slow" ? 40 : 12;
      const seen = detect(hellWaveform(text(speed, seconds), 1500, RATE, speed));
      expect(settled(seen)).toBe(`hell ${speed}`);
      expect(Math.abs(seen.at(-1)!.centreHz - 1500)).toBeLessThan(5);
    }, 30_000);
  }

  it("says when a two-tone station is sending reversed", () => {
    expect(settled(detect(hellWaveform(text("fsk105", 12), 1500, RATE, "fsk105", true)))).toBe("hell fsk105 rev");
  });

  it("finds a station off the marker and says where it is", () => {
    const seen = detect(hellWaveform(text("feld", 12), 1540, RATE, "feld"), 1500);
    expect(settled(seen)).toBe("hell feld");
    expect(Math.abs(seen.at(-1)!.centreHz - 1540)).toBeLessThan(5);
  });

  it("calls CW CW, at any usual speed", () => {
    for (const wpm of [15, 22, 30]) {
      expect(settled(detect(cwWaveform("CQ CQ DE W9ML W9ML K TEST TEST 73 ".repeat(3), 1500, RATE, wpm)))).toBe("cw");
    }
  }, 30_000);

  it("says nothing about an empty channel", () => {
    expect(detect(new Float32Array(RATE * 10))).toEqual([]);
  });

  it("runs on the desk in Hell, at the marker, and not while we transmit", () => {
    const desk = new KeyboardDesk();
    const seen: HellSeen[] = [];
    desk.on("hellSeen", (s) => seen.push(s));
    desk.start("HELL");
    desk.rxHz = 1200;
    const w = hellWaveform(text("fsk245", 10), 1200, RATE, "fsk245");
    const x = noise(w.length, 0.05);
    for (let i = 0; i < w.length; i++) x[i] = x[i]! + 0.3 * w[i]!;
    desk.muted = true;
    for (let i = 0; i < x.length; i += 480) desk.feed(x.subarray(i, i + 480), i / 12);
    expect(seen).toEqual([]);
    desk.muted = false;
    for (let i = 0; i < x.length; i += 480) desk.feed(x.subarray(i, i + 480), i / 12);
    expect(settled(seen)).toBe("hell fsk245");
    expect(desk.hellSeen?.speed).toBe("fsk245");
    desk.start("CW");
    expect(desk.hellSeen).toBeNull();
  });
});
