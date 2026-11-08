import { describe, expect, it } from "vitest";

import { testDb } from "../../core/test/testdb.ts";
import { heardSummary } from "../src/services/heardby.ts";

describe("heard-by summary", () => {
  it("counts distinct receivers per band and continent, and drops continents the grid contradicts", () => {
    const { db, sqlite } = testDb();
    const now = Date.now();
    const add = (receiver: string, grid: string | null, band: string, km: number | null, continent: string | null, ago = 60_000) =>
      sqlite
        .prepare("INSERT INTO heard_reports (at,receiver,grid,freq_hz,band,mode,snr,distance_km,dxcc,continent) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(now - ago, receiver, grid, 7_074_000, band, "FT8", -10, km, null, continent);
    add("K4MPM", "EM73VX", "40M", 870, "NA");
    add("K4MPM", "EM73VX", "20M", 870, "NA");
    add("DL1ABC", "JO31", "20M", 6900, "EU");
    add("AC0G/B4", "EM38ww", "40M", 502, "AS"); // a beacon suffix that reads as China, in Missouri
    add("SWL/FN11OD", "FN11od", "40M", 870, "EU"); // a listener, in Pennsylvania
    add("JA1XYZ", null, "20M", null, "AS"); // no grid: the callsign is all there is
    add("OLD1", "EM73", "40M", 870, "NA", 3 * 3_600_000); // outside the window

    const s = heardSummary(db, now - 30 * 60_000);
    expect(s.receivers).toBe(5);
    expect(s.count).toBe(6); // rows are one per receiver and band
    expect(s.byBand).toEqual({ "40M": 3, "20M": 3 });
    expect(s.byContinent).toEqual({ NA: 1, EU: 1, AS: 1 });
    expect(s.farthest?.receiver).toBe("DL1ABC");
  });
});
