/** Fixes from the 2026-10-20 panel review that live in the engine's message layer. */
import { decodeFT8, HashCallBook } from "@e04/ft8ts";
import { describe, expect, it } from "vitest";

import { contestMessages, isFoxMessage, standardMessages } from "../src/digital/message.ts";
import { buildWaveform } from "../src/digital/waveform.ts";

/** What a receiver that knows the hashed calls prints for a message we send. */
function onAir(msg: string, known: string[]): string | null {
  const book = new HashCallBook();
  for (const c of known) book.save(c);
  const w = buildWaveform(msg, "FT8", 1500, 12_000);
  const x = new Float32Array(15 * 12_000);
  x.set(w, 6_000);
  return decodeFT8(x, { sampleRate: 12_000, freqLow: 1_000, freqHigh: 2_000, hashCallBook: book })[0]?.msg.trim() ?? null;
}

describe("contest messages with a compound call", () => {
  it("fall back to the hashed standard messages where the exchange cannot be packed", () => {
    const std = standardMessages("W9ML", "PJ4/K1ABC", "EN61", -10);
    expect(contestMessages("W9ML", "PJ4/K1ABC", "EN61", -10, "field-day", "1D IN")).toEqual(std);
    expect(contestMessages("W9ML", "PJ4/K1ABC", "EN61", -10, "rtty-roundup", "IN")).toEqual(std);
    // A compound own call cannot carry a contest modifier either.
    expect(contestMessages("PY0F/PY2TF", "K1ABC", "GG66", -10, "ww-digi", "")).toEqual(standardMessages("PY0F/PY2TF", "K1ABC", "GG66", -10));
  });

  it("exchange grids in the Digi contests with the other call hashed", () => {
    const m = contestMessages("W9ML", "PJ4/K1ABC", "EN61", -10, "ww-digi", "");
    expect(m.tx2).toBe("<PJ4/K1ABC> W9ML EN61");
    expect(m.tx3).toBe("<PJ4/K1ABC> W9ML R EN61");
    expect(m.tx6).toBe("CQ WW W9ML EN61");
  });

  it("go out on the air as sent, not as truncated free text", () => {
    // The old code sent "PJ4/K1ABC W9ML EN61", which a receiver printed as "PJ4/K1ABC W9M".
    const m = contestMessages("W9ML", "PJ4/K1ABC", "EN61", -10, "ww-digi", "");
    for (const msg of [m.tx2, m.tx3, m.tx4]) expect(onAir(msg, ["PJ4/K1ABC", "W9ML"])).toBe(msg);
    expect(onAir("CQ PY0F/PY2TF", [])).toBe("CQ PY0F/PY2TF");
  }, 60_000);
});

describe("Fox detection", () => {
  it("knows a Fox by its two-contact messages, not by any semicolon", () => {
    expect(isFoxMessage("K1ABC RR73; W9XYZ <PJ4/FOX> -08")).toBe(true);
    expect(isFoxMessage("TU; K1ABC W9XYZ R 579 MA")).toBe(false);
    expect(isFoxMessage("TU; W9ML K1ABC R 1D IN")).toBe(false);
    expect(isFoxMessage("CQ K1ABC FN42")).toBe(false);
  });
});

describe("band plans", () => {
  it("keep 60 m inside the US segment and give the IARU regions their own lists", async () => {
    const { CALLING_FREQS, bandsFor, modeForDial, setBandPlan } = await import("../src/digital/timing.ts");
    const { usAllowed } = await import("@zerobeat/core/ham/privileges");
    try {
      setBandPlan("us");
      expect(CALLING_FREQS.FT2["60M"]).toBe(5_360_000);
      expect(CALLING_FREQS.WSPR["60M"]).toBe(5_364_700);
      // Every US 60 m dial puts a 1500 Hz tone inside the segment.
      for (const m of ["FT8", "JS8", "CW"] as const) {
        const hz = CALLING_FREQS[m]["60M"]!;
        expect(usAllowed("G", m === "CW" ? "C" : "D", hz + 1450, hz + 1550)).toBe(true);
      }
      expect(bandsFor("FT8")).not.toContain("4M");
      setBandPlan("r1");
      expect(CALLING_FREQS.WSPR["60M"]).toBe(5_364_700);
      expect(CALLING_FREQS.FT2["60M"]).toBe(5_360_000);
      expect(bandsFor("FT8")).toContain("4M");
      expect(bandsFor("FT8").indexOf("4M")).toBe(bandsFor("FT8").indexOf("6M") + 1);
      expect(modeForDial(70_154_000)).toBe("FT8");
      setBandPlan("r3");
      expect(CALLING_FREQS.FT4["80M"]).toBe(3_568_000);
    } finally {
      setBandPlan("us");
    }
  });
});
