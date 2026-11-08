import { readFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { durationSec, MODES, modeById, type SstvMode } from "@zerobeat/core/sstv/modes";
import { SstvReceiver, type SstvEvent } from "../src/digital/sstv/decode.ts";
import { pictureSegments, sstvWaveform, visSegments } from "../src/digital/sstv/encode.ts";
import { SstvDesk } from "../src/operate/sstv.ts";

/** Colour bars over a grey ramp, with a diagonal white line (it shows slant). */
function testCard(m: SstvMode): Uint8Array {
  const { width: W, height: H } = m;
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (y < H / 2) {
        const bar = Math.floor((x / W) * 8);
        rgb[i] = bar & 1 ? 255 : 0;
        rgb[i + 1] = bar & 2 ? 255 : 0;
        rgb[i + 2] = bar & 4 ? 255 : 0;
      } else {
        const v = Math.round((x / W) * 255);
        rgb.fill(v, i, i + 3);
      }
      if (Math.abs(x - y * (W / H)) < 2) rgb.fill(255, i, i + 3);
    }
  return rgb;
}

function receive(m: SstvMode, opts: { skew?: number; offsetHz?: number; noise?: number } = {}) {
  const rgb = testCard(m);
  const w = sstvWaveform(m, rgb, 12_000 * (1 + (opts.skew ?? 0)), opts.offsetHz ?? 0);
  let s = 7;
  const x = new Float32Array(w.length + 24_000).map(() => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 2 * (opts.noise ?? 0));
  w.forEach((v, i) => (x[12_000 + i]! += v * 0.5));
  const events: SstvEvent[] = [];
  const rx = new SstvReceiver((e) => e.type !== "line" && events.push(e));
  for (let i = 0; i < x.length; i += 480) rx.push(x.subarray(i, i + 480), i / 12);
  const done = events.find((e): e is Extract<SstvEvent, { type: "done" }> => e.type === "done");
  let err = Infinity;
  if (done) {
    err = 0;
    for (let i = 0; i < rgb.length; i++) err += Math.abs(done.rgb[i]! - rgb[i]!);
    err /= rgb.length;
  }
  return { events, done, err };
}

describe("SSTV", () => {
  it("sends the VIS code LSB first with even parity", () => {
    const bits = visSegments(44).slice(4, 12).map(([hz]) => (hz === 1100 ? 1 : 0));
    expect(bits).toEqual([0, 0, 1, 1, 0, 1, 0, 1]); // 44 = 0101100, three ones → parity 1
  });

  it("times each mode as its specification says", () => {
    for (const id of ["M1", "S1", "R36", "PD120"]) {
      const m = modeById(id)!;
      const ms = pictureSegments(m, testCard(m)).reduce((a, [, d]) => a + d, 0);
      expect(ms / 1000).toBeCloseTo(durationSec(m), 3);
    }
    expect(durationSec(modeById("M1")!)).toBeCloseTo(115.2, 0);
    expect(durationSec(modeById("R36")!)).toBeCloseTo(36.9, 0);
  });

  it.each(MODES.filter((m) => m.lineMs * m.height < 140_000).map((m) => [m.id, m] as const))("receives %s from its VIS header to the last line", (_id, m) => {
    const r = receive(m);
    expect(r.events[0]).toMatchObject({ type: "start", mode: { id: m.id } });
    expect(r.done).toMatchObject({ complete: true, lines: m.height });
    // RGB modes come back almost exact; colour-difference modes lose a little to chroma sharing.
    expect(r.err).toBeLessThan(m.family === "martin" || m.family === "scottie" ? 3 : 8);
  }, 60_000);

  it("takes the slant out of a sender whose clock is off, and the error out of a mistuned one", () => {
    const fast = receive(modeById("M1")!, { skew: 0.0005 });
    expect(Math.abs(fast.done!.slantPpm - 500)).toBeLessThan(20);
    expect(fast.err).toBeLessThan(3);
    const slow = receive(modeById("S1")!, { skew: -0.0008, offsetHz: 60 });
    // The slow clock also lowers every tone a little (0.08 % of 1900 Hz), so about 61-63.
    expect(Math.abs((slow.events[0] as { offsetHz: number }).offsetHz - 61)).toBeLessThanOrEqual(3);
    expect(slow.err).toBeLessThan(3);
  }, 60_000);

  it("keeps finished pictures as PNG files with an index, the oldest dropped first", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sstv-"));
    try {
      const desk = new SstvDesk(dir);
      desk.keepDays = () => 3650; // a fixed date in the past: not deleted for its age
      const m = modeById("R36")!;
      const p = await desk.save(m, testCard(m), { at: Date.UTC(2026, 9, 20, 18, 0, 5), lines: 240, complete: true, slantPpm: 0, dir: "rx" });
      expect(p.file).toBe("20261020T180005-rx-R36.png");
      const png = fs.readFileSync(path.join(dir, "sstv", p.file));
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect(new SstvDesk(dir).pictures.map((x) => x.file)).toEqual([p.file]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps pictures for the set number of days, and pages back through them", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sstv-"));
    try {
      const desk = new SstvDesk(dir);
      desk.keepDays = () => 90;
      const m = modeById("R36")!;
      const now = Date.now();
      const day = 86_400_000;
      // Five pictures 25 days apart: the oldest, 100 days old, is past 90 days.
      for (let k = 4; k >= 0; k--) await desk.save(m, testCard(m), { at: now - k * 25 * day - 1000, lines: 240, complete: true, slantPpm: 0, dir: "rx" });
      expect(desk.pictures.length).toBe(4); // the 100-day one went at the next save
      desk.prune(now + 31 * day); // a month on, the 75-day one is past too
      expect(desk.pictures.length).toBe(3);
      expect(fs.readdirSync(path.join(dir, "sstv")).filter((x) => x.endsWith(".png")).length).toBe(3);
      // Newest first, a page at a time.
      const first = desk.page(Infinity, 2);
      expect(first.total).toBe(3);
      expect(first.pictures.map((p) => p.at)).toEqual([now - 1000, now - 25 * day - 1000]);
      const next = desk.page(first.pictures.at(-1)!.at, 2);
      expect(next.pictures.map((p) => p.at)).toEqual([now - 50 * day - 1000]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("receives a Martin 1 picture off the air (14.230 MHz, 2026-10-20), in 40 ms chunks", () => {
    // A weak, noisy signal 28 Hz off tune: the VIS search used to step over the header
    // when chunks were longer than 10 ms, and noise pulled the leader's frequency 130 Hz.
    const b = readFileSync(new URL("./fixtures/sstv-martin1-14230.wav", import.meta.url));
    const x = new Float32Array((b.length - 44) >> 1);
    for (let i = 0; i < x.length; i++) x[i] = b.readInt16LE(44 + 2 * i) / 32768;
    const events: SstvEvent[] = [];
    const rx = new SstvReceiver((e) => events.push(e));
    const all = new Float32Array(x.length + 12_000 * 6);
    all.set(x);
    for (let i = 0; i < all.length; i += 480) rx.push(all.subarray(i, i + 480), (i / 12_000) * 1000);
    const start = events.find((e) => e.type === "start");
    const done = events.find((e) => e.type === "done");
    expect(start && start.type === "start" && start.mode.name).toBe("Martin 1");
    expect(start && start.type === "start" && Math.abs(start.offsetHz - 28) <= 5).toBe(true);
    expect(done && done.type === "done" && done.complete && done.lines).toBe(256);
    expect(done && done.type === "done" && Math.abs(done.slantPpm)).toBeLessThan(200);
  }, 60_000);
});
