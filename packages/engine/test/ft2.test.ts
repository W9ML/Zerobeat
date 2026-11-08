import { decodeFT4 } from "@e04/ft8ts";
import { describe, expect, it } from "vitest";

import { stretch2 } from "../src/digital/decode-worker.ts";
import { modeForDial, TIMING } from "../src/digital/timing.ts";
import { buildWaveform } from "../src/digital/waveform.ts";

const RATE = 12_000;

function noise(n: number, amp: number) {
  let s = 7;
  return new Float32Array(n).map(() => ((s = (s * 1103515245 + 12345) & 0x7fffffff), ((s / 0x7fffffff) * 2 - 1) * amp));
}

describe("FT2", () => {
  it("is FT4's 105 symbols at 24 ms: 2.52 s on the air", () => {
    const w = buildWaveform("CQ W9ML EN61", "FT2", 1500, RATE);
    expect(w.length).toBe(105 * 288);
    expect(TIMING.FT2.txLenMs).toBe(2_520);
    expect(TIMING.FT2.txStartMs + TIMING.FT2.txLenMs).toBeLessThan(TIMING.FT2.cutMs);
  });

  it("decodes through the FT4 decoder at half speed, with frequency and time scaled back", () => {
    const buf = noise(Math.round((TIMING.FT2.cutMs / 1000) * RATE), 0.3);
    const put = (msg: string, hz: number, startMs: number, amp: number) => {
      const w = buildWaveform(msg, "FT2", hz, RATE);
      const at = Math.round((startMs / 1000) * RATE);
      for (let i = 0; i < w.length && at + i < buf.length; i++) buf[at + i]! += (w[i]! / 0.9) * amp;
    };
    put("CQ W9ML EN61", 1500, TIMING.FT2.txStartMs, 0.06);
    put("W9ML K1ABC FN42", 2650, 0, 0.07);
    const out = decodeFT4(stretch2(buf), { sampleRate: RATE, freqLow: 50, freqHigh: 1_560, depth: 2 }).map((d) => ({ msg: d.msg.trim(), hz: d.freq * 2, dt: d.dt / 2 }));
    const cq = out.find((d) => d.msg === "CQ W9ML EN61");
    const call = out.find((d) => d.msg === "W9ML K1ABC FN42");
    expect(cq).toBeDefined();
    expect(call).toBeDefined();
    expect(Math.abs(cq!.hz - 1500)).toBeLessThan(5);
    expect(Math.abs(cq!.dt)).toBeLessThan(0.1); // our TX start is DT 0
    expect(Math.abs(call!.hz - 2650)).toBeLessThan(5);
    expect(call!.dt).toBeLessThan(-0.15); // Decodium on Linux starts at 0 s
  });

  it("knows its calling frequencies and does not confuse them with FT4's", () => {
    expect(modeForDial(14_084_000)).toBe("FT2");
    expect(modeForDial(14_080_000)).toBe("FT4");
    expect(modeForDial(14_074_000)).toBe("FT8");
    expect(modeForDial(50_318_000)).toBe("FT4"); // FT2 is only 2 kHz away on 6 m
    expect(modeForDial(50_316_000)).toBe("FT2");
    expect(modeForDial(1_840_000)).toBe("FT8");
    expect(modeForDial(1_843_000)).toBe("FT2");
  });
});

describe("first call after a click", () => {
  it("goes out in the very next slot if the click comes within the manual allowance", async () => {
    const { nextTxWindow, windowStart, TIMING: T } = await import("../src/digital/timing.ts");
    const idx = 1_000_001; // an odd FT8 window
    const clickAt = windowStart(idx, "FT8") + 2_200; // decodes shown ~1.2 s in, click a second later
    expect(nextTxWindow(clickAt, "FT8", 1)).toBe(idx + 2); // automatic rules: 30 s later
    expect(nextTxWindow(clickAt, "FT8", 1, T.FT8.manualLateMs)).toBe(idx); // a click: now
    expect(nextTxWindow(windowStart(idx, "FT8") + 3_000, "FT8", 1, T.FT8.manualLateMs)).toBe(idx + 2); // too late even for a click
  });
});
