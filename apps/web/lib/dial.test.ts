import { describe, expect, it } from "vitest";

import { parseDial } from "./dial.ts";

describe("parseDial", () => {
  it("reads MHz, kHz and commas the way hams type them", () => {
    expect(parseDial("14.074")).toBe(14_074_000);
    expect(parseDial("14074")).toBe(14_074_000);
    expect(parseDial("14,074")).toBe(14_074_000);
    expect(parseDial("7074 kHz")).toBe(7_074_000);
    expect(parseDial("144.174")).toBe(144_174_000);
    expect(parseDial("1296.1 MHz")).toBe(1_296_100_000);
    expect(parseDial("abc")).toBeNull();
    expect(parseDial("0.05")).toBeNull();
  });
});
