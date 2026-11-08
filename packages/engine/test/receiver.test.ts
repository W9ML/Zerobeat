import { describe, expect, it } from "vitest";
import { buildWaveform } from "../src/digital/waveform.ts";
import { Receiver, type WindowResult } from "../src/digital/receiver.ts";
import { Decoder } from "../src/digital/decoder.ts";
import { windowStart } from "../src/digital/timing.ts";

function feedWindow(rx: Receiver, mode: "FT8" | "FT4", index: number, msgs: { msg: string; f: number; dtMs: number; amp: number }[], opts: { dropFromMs?: number; dropToMs?: number; counted?: boolean; burstFromMs?: number; burstToMs?: number } = {}) {
  const period = mode === "FT8" ? 15000 : 7500;
  const start = windowStart(index, mode);
  // 2 s of lead-in from the previous window, then the window itself.
  const leadMs = 2000;
  const total = Math.round(((period + leadMs) / 1000) * 24000);
  const audio = new Float32Array(total);
  let seed = 1;
  for (let i = 0; i < total; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    audio[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.05;
  }
  for (const m of msgs) {
    const w = buildWaveform(m.msg, mode, m.f, 24000);
    const off = Math.round(((leadMs + 500 + m.dtMs) / 1000) * 24000);
    for (let i = 0; i < w.length && off + i < total; i++) audio[off + i]! += w[i]! * m.amp;
  }
  let lost = 0;
  const held: { x: Float32Array; at: number }[] = [];
  for (let i = 0; i < total; i += 128) {
    const tEnd = start - leadMs + ((i + 128) / 24000) * 1000;
    const rel = tEnd - start;
    if (opts.dropFromMs !== undefined && rel > opts.dropFromMs && rel < opts.dropToMs!) {
      lost += 128;
      continue;
    }
    const at = tEnd + 3 + ((i / 128) % 7); // 3–9 ms transit jitter
    // A network stall: these packets all arrive at once, late, at burstToMs.
    if (opts.burstFromMs !== undefined && rel > opts.burstFromMs && rel < opts.burstToMs!) {
      held.push({ x: audio.subarray(i, i + 128), at });
      continue;
    }
    for (const h of held.splice(0)) rx.feed(h.x, start + opts.burstToMs! + 5, opts.counted ? 0 : undefined);
    rx.feed(audio.subarray(i, i + 128), at, opts.counted ? lost : undefined);
    lost = 0;
  }
}

describe("receiver", () => {
  it("decodes an FT8 window fed as jittery DAX packets, with DT near zero", async () => {
    const dec = new Decoder(() => {});
    const rx = new Receiver(dec, () => {});
    const results: WindowResult[] = [];
    rx.on("window", (w) => results.push(w));
    const idx = 123_000_000;
    feedWindow(rx, "FT8", idx, [
      { msg: "CQ W9ML EN61", f: 1000, dtMs: 0, amp: 0.4 },
      { msg: "W9ML K1ABC -12", f: 1600, dtMs: 600, amp: 0.2 },
    ]);
    await rx.decodeWindow(idx, "FT8");
    await dec.close();
    const w = results[0]!;
    expect(w.skipped).toBeNull();
    const texts = w.decodes.map((d) => d.text).sort();
    expect(texts).toEqual(["CQ W9ML EN61", "W9ML K1ABC -12"]);
    const cq = w.decodes.find((d) => d.text.startsWith("CQ"))!;
    expect(Math.abs(cq.dt)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(cq.offsetHz - 1000)).toBeLessThanOrEqual(4);
    expect(cq.sender).toBe("W9ML");
    const late = w.decodes.find((d) => d.text.includes("K1ABC"))!;
    expect(late.dt).toBeGreaterThan(0.4);
  }, 60000);

  it("keeps time across an audio dropout (silence-filled) and decodes FT4", async () => {
    const dec = new Decoder(() => {});
    const rx = new Receiver(dec, () => {});
    const results: WindowResult[] = [];
    rx.on("window", (w) => results.push(w));
    const idx = 246_000_001;
    feedWindow(rx, "FT4", idx, [{ msg: "CQ POTA N7XAK DN40", f: 1500, dtMs: 0, amp: 0.4 }], { dropFromMs: -1500, dropToMs: -500 });
    await rx.decodeWindow(idx, "FT4");
    await dec.close();
    const d = results[0]!.decodes[0]!;
    expect(d.text).toBe("CQ POTA N7XAK DN40");
    expect(Math.abs(d.dt)).toBeLessThanOrEqual(0.2);
  }, 60000);

  it("keeps time when DAX packets arrive late in a burst, and when the counter says some were lost", async () => {
    for (const opts of [{ counted: true, dropFromMs: -1500, dropToMs: -500 }]) {
      const dec = new Decoder(() => {});
      const rx = new Receiver(dec, () => {});
      const results: WindowResult[] = [];
      rx.on("window", (w) => results.push(w));
      const idx = 123_000_010;
      feedWindow(rx, "FT8", idx, [{ msg: "CQ W9ML EN61", f: 1000, dtMs: 0, amp: 0.4 }], opts);
      await rx.decodeWindow(idx, "FT8");
      await dec.close();
      const d = results[0]!.decodes[0]!;
      expect(d.text).toBe("CQ W9ML EN61");
      expect(Math.abs(d.dt)).toBeLessThanOrEqual(0.2);
    }
  }, 60000);

  it("stamps a late burst of packets with the time they were sent, not padded with silence", () => {
    for (const counted of [true, false]) {
      const rx = new Receiver({} as Decoder, () => {});
      const stamps: { at: number; n: number }[] = [];
      rx.on("audio", (x, at) => stamps.push({ at, n: x.length }));
      const t0 = 1_000_000_000;
      const pkt = new Float32Array(240); // 10 ms at 24 kHz
      const truth: number[] = [];
      const held: number[] = [];
      for (let k = 0; k < 400; k++) {
        const sentEnd = t0 + (k + 1) * 10;
        // Packets 200-239 (400 ms) stall in the network and arrive together at 2.4 s + 5 ms.
        if (k >= 200 && k < 240) {
          held.push(sentEnd);
          continue;
        }
        for (const h of held.splice(0)) {
          rx.feed(pkt, t0 + 2405, counted ? 0 : undefined);
          truth.push(h - 10);
        }
        rx.feed(pkt, sentEnd + 4, counted ? 0 : undefined);
        truth.push(sentEnd - 10);
      }
      expect(stamps).toHaveLength(truth.length);
      const worst = Math.max(...stamps.map((st, i) => Math.abs(st.at - truth[i]!)));
      expect(worst).toBeLessThan(15);
    }
  });

  it("skips windows we transmitted in", async () => {
    const dec = new Decoder(() => {});
    const rx = new Receiver(dec, () => {});
    const results: WindowResult[] = [];
    rx.on("window", (w) => results.push(w));
    rx.markOwnTx(5, "FT8");
    await rx.decodeWindow(5, "FT8");
    await dec.close();
    expect(results[0]).toMatchObject({ ownTx: true, skipped: "transmitting" });
  });
});

import { vi } from "vitest";
import { tonesToWaveform, atomsToTones } from "../src/digital/jtty/modem.ts";
import { packText } from "../src/digital/jtty/source.ts";
import { Waterfall } from "../src/dsp/dsp.ts";

describe("receiver: our transmission on the waterfall", () => {
  it("draws the transmit audio in real time once the radio keys, and only then", () => {
    vi.useFakeTimers();
    try {
      const rx = new Receiver({} as Decoder, () => {});
      const tx: Uint8Array[] = [];
      rx.on("waterfall-tx", (r) => tx.push(r));
      const w = tonesToWaveform(atomsToTones(packText("CQ K1ABC CQ")!.atoms), 1500, 24_000);

      // Armed but never keyed (cancelled, refused): nothing is drawn.
      rx.armTx(w, Date.now());
      vi.advanceTimersByTime(2500);
      expect(tx).toHaveLength(0);

      rx.armTx(w, Date.now() + 100);
      rx.txKeyed(true);
      vi.advanceTimersByTime(1000);
      const half = tx.length;
      expect(half).toBeGreaterThan(5); // still arriving, not all at once
      vi.advanceTimersByTime(1500);
      expect(tx.length).toBeGreaterThan(half + 10);
      // The bright bins are where we transmitted: 1500 Hz plus the four tones.
      const row = tx.at(-5)!;
      const peak = row.indexOf(Math.max(...row));
      const hz = (peak * Waterfall.RATE) / Waterfall.N;
      expect(hz).toBeGreaterThan(1490);
      expect(hz).toBeLessThan(1610);
      const n = tx.length;
      vi.advanceTimersByTime(2000);
      expect(tx.length).toBe(n); // done when the audio is
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the transmit band for a moment after unkey, so the switch back draws no bright line", () => {
    vi.useFakeTimers();
    try {
      const rx = new Receiver({} as Decoder, () => {});
      const tx: Uint8Array[] = [];
      const rxRows: Uint8Array[] = [];
      rx.on("waterfall-tx", (r) => tx.push(r));
      rx.on("waterfall", (r) => rxRows.push(r));
      const noise = (n: number, a: number) => Float32Array.from({ length: n }, (_, i) => a * Math.sin(i * 1.7) * Math.sin(i * 0.013));
      // Receive for a second, then a short transmission.
      rx.feed(noise(24_000, 0.05), Date.now());
      const before = rxRows.length;
      expect(before).toBeGreaterThan(5);
      rx.armTx(new Float32Array(2400), Date.now());
      rx.txKeyed(true);
      vi.advanceTimersByTime(200);
      rx.txKeyed(false);
      // Audio right after unkey: transmit rows (blank), not receive rows.
      const t0 = tx.length;
      rx.feed(noise(2400, 0.05), Date.now());
      expect(rxRows.length).toBe(before);
      expect(tx.length).toBeGreaterThan(t0);
      expect(tx.at(-1)!.every((v) => v === 0)).toBe(true);
      // After the tail, receive again.
      vi.advanceTimersByTime(Receiver.TX_TAIL_MS + 50);
      rx.feed(noise(4800, 0.05), Date.now());
      expect(rxRows.length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stamps each waterfall row with when its audio was on the air", () => {
    const rx = new Receiver({} as Decoder, () => {});
    const rows: number[] = [];
    rx.on("waterfall", (_r, at) => rows.push(at));
    // Two seconds of 24 kHz audio in 10 ms packets, each arriving as its last sample plays.
    const t0 = 1_800_000_000_000;
    const pkt = new Float32Array(240).map((_, i) => 0.05 * Math.sin(i));
    for (let k = 1; k <= 200; k++) rx.feed(pkt, t0 + k * 10);
    expect(rows.length).toBeGreaterThan(30);
    // Rows 50 ms apart, and the newest about 110 ms (half a window plus averaging) behind the audio.
    for (let i = 1; i < rows.length; i++) expect(rows[i]! - rows[i - 1]!).toBeCloseTo(50, 0);
    expect(t0 + 2000 - rows.at(-1)!).toBeGreaterThan(100);
    expect(t0 + 2000 - rows.at(-1)!).toBeLessThan(170);
  });
});
