import { describe, expect, it } from "vitest";
import { bandName, normaliseBand, bandMatchesFreq } from "../src/ham/bands.ts";
import { toAdifMode, displayMode, digitalMode, modeClass } from "../src/ham/modes.ts";
import { gridToLatLon, latLonToGrid, gridDistanceKm, bearingDeg, isGrid } from "../src/ham/grid.ts";
import { splitCallsign, looksLikeCallsign } from "../src/ham/callsign.ts";
import { adifDate, adifTime, parseAdifDateTime, utcDateTime } from "../src/util/time.ts";

describe("bands", () => {
  it("maps frequencies to ADIF band names", () => {
    expect(bandName(14_074_000)).toBe("20M");
    expect(bandName(7_074_000)).toBe("40M");
    expect(bandName(50_313_000)).toBe("6M");
    expect(bandName(146_520_000)).toBe("2M");
    expect(bandName(13_000_000)).toBeNull();
  });
  it("normalises band spelling", () => {
    expect(normaliseBand("20m")).toBe("20M");
    expect(normaliseBand(" 70 cm")).toBe("70CM");
    expect(normaliseBand("11M")).toBeNull();
  });
  it("checks band/frequency agreement", () => {
    expect(bandMatchesFreq("20M", 14_074_000)).toBe(true);
    expect(bandMatchesFreq("40M", 14_074_000)).toBe(false);
  });
});

describe("modes", () => {
  it("places submodes under their ADIF mode", () => {
    expect(toAdifMode("FT4")).toEqual({ mode: "MFSK", submode: "FT4" });
    expect(toAdifMode("MFSK", "FT4")).toEqual({ mode: "MFSK", submode: "FT4" });
    expect(toAdifMode("usb")).toEqual({ mode: "SSB", submode: "USB" });
    expect(toAdifMode("FT8")).toEqual({ mode: "FT8", submode: null });
    expect(toAdifMode("PSK31")).toEqual({ mode: "PSK", submode: "PSK31" });
    expect(toAdifMode("SSB")).toEqual({ mode: "SSB", submode: null });
  });
  it("displays and classifies", () => {
    expect(displayMode("MFSK", "FT4")).toBe("FT4");
    expect(digitalMode("MFSK", "FT4")).toBe("FT4");
    expect(digitalMode("FT8", null)).toBe("FT8");
    expect(digitalMode("SSB", "USB")).toBeNull();
    expect(modeClass("FT8")).toBe("DATA");
    expect(modeClass("USB")).toBe("SSB");
    expect(modeClass("CW")).toBe("CW");
  });
});

describe("grids", () => {
  it("round-trips a 6-char locator", () => {
    const p = gridToLatLon("EN61jk")!;
    expect(p.lat).toBeCloseTo(41.4375, 3);
    expect(p.lon).toBeCloseTo(-87.2083, 3);
    expect(latLonToGrid(p.lat, p.lon, 6)).toBe("EN61jk");
    expect(latLonToGrid(p.lat, p.lon, 4)).toBe("EN61");
  });
  it("computes distance and bearing", () => {
    const km = gridDistanceKm("EN61", "JO01")!;
    expect(km).toBeGreaterThan(6300);
    expect(km).toBeLessThan(6500);
    const b = bearingDeg(gridToLatLon("EN61")!, gridToLatLon("JO01")!);
    expect(b).toBeGreaterThan(40);
    expect(b).toBeLessThan(60);
  });
  it("validates", () => {
    expect(isGrid("EN61")).toBe(true);
    expect(isGrid("EN61jk")).toBe(true);
    expect(isGrid("RR73")).toBe(false);
    expect(isGrid("E61")).toBe(false);
  });
});

describe("callsigns", () => {
  it("splits portable forms", () => {
    expect(splitCallsign("PJ4/K1ABC")).toMatchObject({ base: "K1ABC", entityPrefixPart: "PJ4" });
    expect(splitCallsign("K1ABC/VE3")).toMatchObject({ base: "K1ABC", entityPrefixPart: "VE3" });
    expect(splitCallsign("K1ABC/P")).toMatchObject({ base: "K1ABC", entityPrefixPart: "K1ABC" });
    expect(splitCallsign("W1ABC/7")).toMatchObject({ base: "W1ABC", entityPrefixPart: "W7ABC" });
    expect(splitCallsign("W9ML")).toMatchObject({ base: "W9ML", entityPrefixPart: "W9ML" });
    expect(splitCallsign("F/K9XYZ")).toMatchObject({ base: "K9XYZ", entityPrefixPart: "F0" });
  });
  it("recognises callsign shapes", () => {
    expect(looksLikeCallsign("W9ML")).toBe(true);
    expect(looksLikeCallsign("pj4/k1abc/p")).toBe(true);
    expect(looksLikeCallsign("RR73")).toBe(true); // shape only; the grammar decides
    expect(looksLikeCallsign("CQ")).toBe(false);
    expect(looksLikeCallsign("EN61")).toBe(true);
  });
});

describe("time", () => {
  it("formats ADIF date/time and parses back", () => {
    const ms = Date.UTC(2026, 9, 19, 23, 5, 7);
    expect(adifDate(ms)).toBe("20261019");
    expect(adifTime(ms)).toBe("230507");
    expect(parseAdifDateTime("20261019", "2305")).toBe(Date.UTC(2026, 9, 19, 23, 5, 0));
    expect(parseAdifDateTime("20261019", "230507")).toBe(ms);
    expect(parseAdifDateTime("2026101", "2305")).toBeNull();
    expect(utcDateTime(ms)).toBe("2026-10-19 23:05:07Z");
  });
});
