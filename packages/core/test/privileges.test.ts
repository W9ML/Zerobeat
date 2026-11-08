import { describe, expect, it } from "vitest";

import { higherClass, privilegeProblem, usAllowed } from "../src/ham/privileges.ts";

const ft8 = (dialHz: number, offset = 1500) => [dialHz + offset - 50, dialHz + offset + 50] as const;

describe("US privileges", () => {
  it("lets a Technician use FT8 on 10 m and 6 m, and nowhere on 20 m or 40 m", () => {
    expect(usAllowed("T", "D", ...ft8(28_074_000))).toBe(true);
    expect(usAllowed("T", "D", ...ft8(50_313_000))).toBe(true);
    expect(usAllowed("T", "D", ...ft8(14_074_000))).toBe(false);
    expect(usAllowed("T", "D", ...ft8(7_074_000))).toBe(false);
    expect(privilegeProblem("T", "D", ...ft8(14_074_000))).toMatch(/Technician license has no data privileges/);
  });

  it("lets a Technician send CW in the old Novice segments but not data", () => {
    expect(usAllowed("T", "C", 7_040_000, 7_040_100)).toBe(true);
    expect(usAllowed("T", "D", 7_040_000, 7_040_100)).toBe(false);
  });

  it("gives a General every FT8 calling frequency, but not the Extra-only edges or 40 m SSTV at 7.171", () => {
    for (const hz of [1_840_000, 3_573_000, 5_357_000, 7_074_000, 10_136_000, 14_074_000, 18_100_000, 21_074_000, 24_915_000, 28_074_000]) {
      expect(usAllowed("G", "D", ...ft8(hz))).toBe(true);
    }
    expect(usAllowed("G", "D", ...ft8(14_000_000, 1000))).toBe(false);
    expect(usAllowed("E", "D", ...ft8(14_000_000, 1000))).toBe(true);
    expect(usAllowed("G", "I", 7_171_000 + 1100, 7_171_000 + 2300)).toBe(false);
    expect(usAllowed("E", "I", 7_171_000 + 1100, 7_171_000 + 2300)).toBe(true);
    expect(usAllowed("G", "I", 14_230_000 + 1100, 14_230_000 + 2300)).toBe(true);
  });

  it("follows 60 m since FCC 25-60: the segment anywhere, four channels, no Technicians", () => {
    expect(usAllowed("G", "D", ...ft8(5_357_000))).toBe(true);
    expect(usAllowed("G", "D", ...ft8(5_360_000, 2900))).toBe(true); // 5362.9 kHz: segment
    expect(usAllowed("G", "D", ...ft8(5_364_700, 1500))).toBe(true); // WSPR 5.3647
    expect(usAllowed("G", "D", ...ft8(5_366_000, 1500))).toBe(false); // past 5366.5
    expect(usAllowed("G", "D", ...ft8(5_330_500))).toBe(true); // channel 1, carrier 1.5 kHz low
    expect(usAllowed("G", "D", ...ft8(5_330_500, 2900))).toBe(false); // outside the channel
    expect(usAllowed("G", "C", 5_331_990, 5_332_010)).toBe(true); // CW on the centre
    expect(usAllowed("G", "C", 5_331_000, 5_331_020)).toBe(false);
    expect(usAllowed("T", "D", ...ft8(5_357_000))).toBe(false);
    expect(privilegeProblem("E", "D", ...ft8(5_287_200))).toMatch(/outside the US data segments/);
  });

  it("does not check a user with no class, and takes the higher of operator and control operator", () => {
    expect(privilegeProblem(null, "D", ...ft8(14_074_000))).toBeNull();
    expect(higherClass("T", "E")).toBe("E");
    expect(higherClass("G", null)).toBe("G");
  });
});
