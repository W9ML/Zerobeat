import { describe, expect, it } from "vitest";

import { HELL_COLS, HELL_ROWS, hellColumns, hellDurationMs, hellPrint, HellReceiver, hellText, hellWaveform, type HellChunk, type HellSpeed } from "../src/digital/keyboard/hell.ts";
import { fft } from "../src/dsp/dsp.ts";
import { KeyboardDesk } from "../src/operate/keyboard.ts";

function noise(n: number, amp: number, seed = 5): Float32Array {
  let s = seed;
  const u = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) + 1) / 0x80000000;
  return new Float32Array(n).map(() => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()) * amp);
}

/** Best correlation of what was printed with what was sent, over every pixel offset. */
function copy(sent: Uint8Array, heard: Uint8Array): number {
  const a = Array.from(sent, (v) => v / 255);
  const b = Array.from(heard, (v) => v / 255);
  const ma = a.reduce((x, y) => x + y, 0) / a.length;
  let best = -1;
  for (let lag = 0; lag + a.length <= b.length; lag++) {
    let mb = 0;
    for (let i = 0; i < a.length; i++) mb += b[lag + i]!;
    mb /= a.length;
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i]! - ma;
      const y = b[lag + i]! - mb;
      sab += x * y;
      saa += x * x;
      sbb += y * y;
    }
    best = Math.max(best, sab / Math.sqrt(saa * sbb || 1));
  }
  return best;
}

function receive(text: string, speed: HellSpeed, amp: number, hz = 1000, opt: { txReverse?: boolean; rxReverse?: boolean; rxHz?: number } = {}): Uint8Array {
  const w = hellWaveform(text, hz, 12_000, speed, opt.txReverse);
  const x = noise(w.length + 24_000, 0.3);
  w.forEach((v, i) => (x[12_000 + i]! += v * amp));
  const chunks: HellChunk[] = [];
  const rx = new HellReceiver((c) => chunks.push(c), speed, opt.rxReverse);
  rx.rxHz = opt.rxHz ?? hz;
  for (let i = 0; i < x.length; i += 480) rx.push(x.subarray(i, i + 480), i / 12);
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.px.length, 0));
  let o = 0;
  for (const c of chunks) {
    all.set(c.px, o);
    o += c.px.length;
  }
  return all;
}

describe("Hellschreiber", () => {
  it("prints capitals and the characters the font has", () => {
    expect(hellText("cq de w9ml ~ k")).toBe("CQ DE W9ML K");
    expect(hellColumns("A")).toHaveLength(HELL_COLS);
    expect(hellPrint("AB")).toHaveLength(2 * HELL_COLS * HELL_ROWS);
    // Feld Hell is 2.5 characters a second; the lead-in and tail add 4 blank characters.
    expect(hellDurationMs("CQCQCQCQCQ", "feld")).toBeCloseTo(14 * 400, 0);
    expect(hellDurationMs("CQCQCQCQCQ", "x9")).toBeCloseTo((14 * 400) / 9, 0);
  });

  it("keys a carrier that stays within a few hundred hertz", () => {
    const w = hellWaveform("CQ CQ DE W9ML", 1000, 12_000, "feld");
    const N = 1 << 17;
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    re.set(w.subarray(0, N));
    fft(re, im);
    let near = 0;
    let total = 0;
    for (let k = 1; k < N / 2; k++) {
      const p = re[k]! * re[k]! + im[k]! * im[k]!;
      total += p;
      if (Math.abs((k * 12_000) / N - 1000) <= 250) near += p;
    }
    expect(near / total).toBeGreaterThan(0.99);
    expect(Math.max(...w.map(Math.abs))).toBeLessThanOrEqual(0.91);
  });

  for (const speed of ["feld", "x5", "slow"] as const) {
    it(`prints what was sent (${speed})`, () => {
      const text = "CQ DE W9ML";
      const heard = receive(text, speed, 0.5);
      // Faster speeds hear more noise (a wider filter), so they print a little greyer.
      expect(copy(hellPrint(text), heard)).toBeGreaterThan(speed === "x5" ? 0.75 : 0.85);
    });
  }

  it("still prints a readable copy in noise", () => {
    const text = "W9ML EN61";
    // About 0 dB in 2.5 kHz: the eye still reads it.
    const heard = receive(text, "feld", 0.27);
    expect(copy(hellPrint(text), heard)).toBeGreaterThan(0.5);
  });

  it("FSK Hell 105 keys two tones 55 Hz apart and stays narrow", () => {
    const w = hellWaveform("CQ CQ DE W9ML", 1500, 12_000, "fsk105");
    const N = 1 << 17;
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    re.set(w.subarray(0, N));
    fft(re, im);
    let near = 0;
    let total = 0;
    let lo = 0;
    let hi = 0;
    for (let k = 1; k < N / 2; k++) {
      const p = re[k]! * re[k]! + im[k]! * im[k]!;
      const f = (k * 12_000) / N;
      total += p;
      if (Math.abs(f - 1500) <= 120) near += p;
      if (Math.abs(f - 1472.5) < 3) lo += p;
      if (Math.abs(f - 1527.5) < 3) hi += p;
    }
    expect(near / total).toBeGreaterThan(0.97);
    // Mostly paper, so the upper (paper) tone carries more than the lower (ink) one.
    expect(hi).toBeGreaterThan(lo);
    expect(lo).toBeGreaterThan(0);
  });

  for (const speed of ["fsk105", "fsk245"] as const) {
    it(`prints what was sent (${speed})`, () => {
      const text = "CQ DE W9ML";
      expect(copy(hellPrint(text), receive(text, speed, 0.5, 1500))).toBeGreaterThan(0.85);
    });
  }

  it("FSK Hell: prints with the marker 12 Hz off, inverts with Reverse set on one side only, and leaves an empty channel as paper", () => {
    const text = "W9ML EN61";
    expect(copy(hellPrint(text), receive(text, "fsk105", 0.5, 1500, { rxHz: 1512 }))).toBeGreaterThan(0.75);
    expect(copy(hellPrint(text), receive(text, "fsk105", 0.5, 1500, { txReverse: true, rxReverse: true }))).toBeGreaterThan(0.85);
    expect(copy(hellPrint(text), receive(text, "fsk105", 0.5, 1500, { txReverse: true }))).toBeLessThan(0.4); // prints as a negative: no good copy at any offset
    const chunks: HellChunk[] = [];
    const rx = new HellReceiver((c) => chunks.push(c), "fsk105");
    rx.rxHz = 1500;
    const x = noise(12_000 * 6, 0.3, 9);
    for (let i = 0; i < x.length; i += 480) rx.push(x.subarray(i, i + 480), i / 12);
    const px = chunks.flatMap((c) => [...c.px]).slice(14 * 20);
    // Faint speckle at most: on average under the tape's default contrast cut (about 18%).
    expect(px.reduce((a, b) => a + b, 0) / px.length).toBeLessThan(255 * 0.18);
  });

  it("is a keyboard mode on the desk, with its speed in the context", () => {
    const desk = new KeyboardDesk();
    const chunks: HellChunk[] = [];
    desk.on("hell", (c) => chunks.push(c));
    desk.start("HELL");
    const c = desk.compose({ text: "cq de %M" }, "W9ML");
    expect(c).toEqual({ text: "CQ DE W9ML" });
    const w = desk.waveform(c as { text: string }, 1000);
    expect(w.length / 24).toBeCloseTo(hellDurationMs("CQ DE W9ML", "feld"), -1);
    desk.setContext({ hellSpeed: "x9" });
    expect(desk.waveform(c as { text: string }, 1000).length).toBeLessThan(w.length / 5);
    desk.sent("CQ DE W9ML", 1000, Date.now());
    expect(chunks.at(-1)?.tx).toBe(true);
    expect(desk.hellHistory().length).toBe(1);
    // Slow Hell refuses a message that would hold the radio for minutes.
    desk.setContext({ hellSpeed: "slow" });
    expect(desk.compose({ text: "CQ ".repeat(60) }, "W9ML")).toHaveProperty("error");
  });
});
