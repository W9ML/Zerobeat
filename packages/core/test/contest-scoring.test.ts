import { describe, expect, it } from "vitest";

import { checkStation, grid4Km, roundupMissing, summarize, type ContestQso } from "../src/contest/scoring.ts";

const T = Date.UTC(2026, 7, 29, 14, 0);
const q = (over: Partial<Omit<ContestQso, "extras">> & { extras?: Record<string, string> }): ContestQso => ({
  callsign: "K1ABC",
  band: "20M",
  mode: "FT8",
  submode: null,
  startTime: T,
  grid: null,
  dxcc: 291,
  state: null,
  ...over,
  extras: JSON.stringify(over.extras ?? {}),
});

describe("contest scoring", () => {
  it("ARRL Digi: 1 point plus 1 per 500 km between square centres, rounded up, at least 1", () => {
    // The rules' own example: 1,565 km scores 1 + 4.
    const near = grid4Km("EN61", "EN61")!;
    expect(near).toBe(0);
    const pick = (to: string) => summarize("arrl-digi", [q({ extras: { CONTEST_ID: "ARRL-DIGI", STX_STRING: "EN61", SRX_STRING: to } })], { myGrid: "EN61" });
    expect(pick("EN61").points).toBe(2);
    const km = grid4Km("EN61", "FN42")!;
    expect(pick("FN42").points).toBe(1 + Math.ceil(km / 500));
    expect(pick("FN42").mults).toBe(0);
    expect(pick("FN42").score).toBe(pick("FN42").points);
  });

  it("WW Digi: 1 point plus 1 per 3000 km; a field per band; once per band, FT4 or FT8; no WARC", () => {
    const rows = [
      q({ callsign: "DL1ABC", extras: { CONTEST_ID: "WW-DIGI", SRX_STRING: "JO62" } }),
      q({ callsign: "DL1ABC", submode: "FT4", mode: "MFSK", startTime: T + 60_000, extras: { CONTEST_ID: "WW-DIGI", SRX_STRING: "JO62" } }),
      q({ callsign: "DL2XYZ", startTime: T + 120_000, extras: { CONTEST_ID: "WW-DIGI", SRX_STRING: "JO41" } }),
      q({ callsign: "DL1ABC", band: "40M", startTime: T + 180_000, extras: { CONTEST_ID: "WW-DIGI", SRX_STRING: "JO62" } }),
      q({ callsign: "G4ABC", band: "30M", startTime: T + 240_000, extras: { CONTEST_ID: "WW-DIGI", SRX_STRING: "IO91" } }),
    ];
    const s = summarize("ww-digi", rows, { myGrid: "EN61", now: T + 300_000 });
    const km = grid4Km("EN61", "JO62")!;
    expect(s.dupes).toBe(1);
    expect(s.qsos).toBe(3);
    expect(s.rows[0]!.points).toBe(1 + Math.floor(km / 3000));
    expect(s.multList).toEqual(["20M:JO", "40M:JO"]);
    expect(s.rows.at(-1)!.invalid).toMatch(/30m is not/);
    expect(s.score).toBe(s.points * 2);
    expect(checkStation("ww-digi", s, { callsign: "DL1ABC", band: "20M", mode: "FT4" }).dupe).toBe(true);
    expect(checkStation("ww-digi", s, { callsign: "VK3ABC", band: "20M", mode: "FT8", grid: "QF22" }).newMults).toEqual(["20M:QF"]);
  });

  it("Field Day: once per band per mode; CW and digital 2, phone 1; times the power multiplier", () => {
    const rows = [
      q({ callsign: "W1AW", mode: "FT8", extras: { CONTEST_ID: "ARRL-FD", SRX_STRING: "3A CT" } }),
      q({ callsign: "W1AW", mode: "CW", startTime: T + 1, extras: { CONTEST_ID: "ARRL-FD" } }),
      q({ callsign: "W1AW", mode: "SSB", startTime: T + 2, extras: { CONTEST_ID: "ARRL-FD" } }),
      q({ callsign: "W1AW", mode: "RTTY", startTime: T + 3, extras: { CONTEST_ID: "ARRL-FD" } }),
    ];
    const s = summarize("field-day", rows, { myGrid: "EN61", fdPowerMult: 2 });
    expect(s.dupes).toBe(1); // RTTY and FT8 are both digital on 20 m
    expect(s.points).toBe(2 + 2 + 1);
    expect(s.score).toBe(10);
  });

  it("RTTY Roundup: RTTY only, once per band, multipliers once; KH6 is DX, DC is Maryland", () => {
    const rows = [
      q({ callsign: "K9AA", mode: "RTTY", extras: { CONTEST_ID: "ARRL-RTTY", SRX_STRING: "599 WI" } }),
      q({ callsign: "K9AB", mode: "RTTY", band: "40M", startTime: T + 1, extras: { CONTEST_ID: "ARRL-RTTY", SRX_STRING: "599 WI" } }),
      q({ callsign: "KH6AA", mode: "RTTY", dxcc: 110, startTime: T + 2, extras: { CONTEST_ID: "ARRL-RTTY", SRX_STRING: "599 HI" } }),
      q({ callsign: "W3DC", mode: "RTTY", startTime: T + 3, extras: { CONTEST_ID: "ARRL-RTTY", SRX_STRING: "599 DC" } }),
      q({ callsign: "VE3AA", mode: "RTTY", dxcc: 1, startTime: T + 4, extras: { CONTEST_ID: "ARRL-RTTY", SRX_STRING: "599 ON" } }),
      q({ callsign: "DL1AA", mode: "RTTY", dxcc: 230, startTime: T + 5, extras: { CONTEST_ID: "ARRL-RTTY", SRX_STRING: "599 0012" } }),
      q({ callsign: "K9AC", mode: "FT8", startTime: T + 6, extras: { CONTEST_ID: "ARRL-RTTY", SRX_STRING: "529 IL" } }),
    ];
    const s = summarize("rtty-roundup", rows, { myGrid: "EN61" });
    expect(s.multList).toEqual(["DXCC-110", "DXCC-230", "MD", "ON", "WI"]);
    expect(s.qsos).toBe(6);
    expect(s.rows.at(-1)!.invalid).toMatch(/RTTY contacts only/);
    expect(s.score).toBe(6 * 5);
    expect(roundupMissing(s.multList)).not.toContain("WI");
    expect(roundupMissing(s.multList)).toContain("IL");
  });

  it("keeps the highest serial sent, for picking up after a restart", () => {
    const rows = [
      q({ mode: "RTTY", extras: { CONTEST_ID: "ARRL-RTTY", STX_STRING: "0007", STX: "7" } }),
      q({ callsign: "K2X", mode: "RTTY", startTime: T + 1, extras: { CONTEST_ID: "ARRL-RTTY", STX_STRING: "0012", STX: "12" } }),
    ];
    expect(summarize("rtty-roundup", rows, { myGrid: "EN61" }).lastSerialSent).toBe(12);
  });
});
