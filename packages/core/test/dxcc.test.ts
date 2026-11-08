import { describe, expect, it } from "vitest";
import { getDxcc } from "../src/dxcc/cty.ts";

const d = getDxcc();
const r = (c: string) => d.resolve(c);

describe("dxcc", () => {
  it("loads the bundled file cleanly", () => {
    expect(d.data.problems).toEqual([]);
    expect(d.data.entities.size).toBeGreaterThan(330);
  });
  it("resolves ordinary calls", () => {
    expect(r("W9ML")?.adif).toBe(291);
    expect(r("W9ML")?.cqZone).toBe(4);
    expect(r("JA1XYZ")?.adif).toBe(339);
    expect(r("G4ABC")?.adif).toBe(223);
    expect(r("VK3ABC")?.adif).toBe(150);
    expect(r("KH6ABC")?.adif).toBe(110);
    expect(r("KL7ABC")?.adif).toBe(6);
  });
  it("uses longitude east-positive", () => {
    expect(r("W9ML")!.lon).toBeLessThan(0);
    expect(r("JA1XYZ")!.lon).toBeGreaterThan(0);
  });
  it("handles portable forms", () => {
    expect(r("PJ4/K1ABC")?.adif).toBe(520);
    expect(r("K1ABC/VE3")?.adif).toBe(1);
    expect(r("K1ABC/P")?.adif).toBe(291);
    expect(r("F/K9XYZ")?.adif).toBe(227);
    expect(r("K1ABC/MM")).toBeNull();
    expect(r("VE3ABC/W4")?.adif).toBe(291);
  });
  it("applies the KG4 rule", () => {
    expect(r("KG4AB")?.adif).toBe(105);
    expect(r("KG4ABC")?.adif).toBe(291);
  });
  it("rejects non-calls", () => {
    expect(r("CQ")).toBeNull();
    expect(r("")).toBeNull();
  });
});
