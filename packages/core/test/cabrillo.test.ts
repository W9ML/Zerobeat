import { describe, expect, it } from "vitest";

import { cabrilloLog, qsoLine, type CabrilloQso } from "../src/contest/cabrillo.ts";

const q = (over: Partial<CabrilloQso>): CabrilloQso => ({
  startTime: Date.UTC(2026, 5, 27, 18, 2),
  freqHz: 14_075_123,
  band: "20M",
  mode: "FT8",
  submode: null,
  callsign: "K1ABC",
  rstSent: null,
  rstRcvd: null,
  grid: "FN42",
  extras: null,
  ...over,
});
const st = { callsign: "W9ML", grid: "EN61jk", location: "IN" };

describe("Cabrillo", () => {
  it("writes Field Day lines with class and section each way", () => {
    const line = qsoLine(q({ extras: JSON.stringify({ CONTEST_ID: "ARRL-FD", STX_STRING: "1D IN", SRX_STRING: "3A CT" }) }), "ARRL-FD", st);
    expect(line).toBe("QSO: 14075 DG 2026-06-27 1802 W9ML          1D  IN  K1ABC         3A  CT");
  });

  it("writes RTTY Roundup lines with RST and state, RTTY as RY", () => {
    const line = qsoLine(q({ mode: "RTTY", rstSent: "599", rstRcvd: "579", freqHz: 7_080_500, extras: JSON.stringify({ CONTEST_ID: "ARRL-RTTY", STX_STRING: "IN", SRX_STRING: "579 MA" }) }), "ARRL-RTTY", st);
    expect(line).toBe("QSO:  7081 RY 2026-06-27 1802 W9ML          599 IN     K1ABC         579 MA");
  });

  it("writes WW Digi lines with grids, and only that contest's contacts, between the header and END-OF-LOG", () => {
    const log = cabrilloLog(
      [
        q({ extras: JSON.stringify({ CONTEST_ID: "WW-DIGI", STX_STRING: "EN61", SRX_STRING: "FN42" }) }),
        q({ callsign: "N0XYZ", extras: JSON.stringify({ CONTEST_ID: "ARRL-FD" }) }),
        q({ callsign: "G4ZZZ", freqHz: 50_313_000, band: "6M", extras: JSON.stringify({ CONTEST_ID: "WW-DIGI", STX_STRING: "EN61", SRX_STRING: "IO91" }) }),
      ],
      "WW-DIGI",
      st,
      "Zerobeat test",
    );
    const lines = log.trimEnd().split("\r\n");
    expect(lines[0]).toBe("START-OF-LOG: 3.0");
    expect(lines).toContain("CONTEST: WW-DIGI");
    expect(lines).toContain("CATEGORY-MODE: DIGI");
    expect(lines.filter((l) => l.startsWith("QSO:"))).toEqual([
      "QSO: 14075 DG 2026-06-27 1802 W9ML          EN61 K1ABC         FN42",
      "QSO:    50 DG 2026-06-27 1802 W9ML          EN61 G4ZZZ         IO91",
    ]);
    expect(lines.at(-1)).toBe("END-OF-LOG:");
  });
});
