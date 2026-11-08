import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { testDb } from "../../core/test/testdb.ts";
import { runs } from "@zerobeat/core/db/schema";
import { BandMemory } from "../src/operate/band-memory.ts";
import { RunRecorder, recentRuns } from "../src/operate/runs.ts";
import { parseReports } from "../src/services/heardby.ts";
import { score, type WorkedIndex } from "../src/operate/worked.ts";

describe("band memory", () => {
  it("accumulates per hour and continent, and flushing twice does not double count", () => {
    const { db } = testDb();
    const m = new BandMemory(db);
    const h = Date.UTC(2026, 9, 20, 3, 0, 0);
    m.add(h + 15_000, "20M", "FT8", [{ sender: "JA1XYZ", snr: -12 }, { sender: "W1AW", snr: -3 }, { sender: "DL1ABC", snr: -15 }]);
    m.flush();
    m.add(h + 45_000, "20M", "FT8", [{ sender: "JA1XYZ", snr: -8 }, { sender: "JA2ABC", snr: -20 }]);
    m.flush();
    m.add(h + 3_600_000, "20M", "FT8", [{ sender: "VK3ABC", snr: -10 }]); // next hour: flushes previous
    m.flush();
    const rows = db.all<{ hour: number; continent: string; windows: number; decodes: number; stations: number; best_snr: number }>(sql`SELECT hour, continent, windows, decodes, stations, best_snr FROM band_hours ORDER BY hour, continent`);
    const at = (hour: number, c: string) => rows.find((r) => r.hour === hour && r.continent === c);
    expect(at(h, "*")).toMatchObject({ windows: 2, decodes: 5, stations: 4, best_snr: -3 });
    expect(at(h, "AS")).toMatchObject({ decodes: 3, stations: 2, best_snr: -8 });
    expect(at(h, "NA")).toMatchObject({ decodes: 1, stations: 1 });
    expect(at(h, "EU")).toMatchObject({ decodes: 1 });
    expect(at(h + 3_600_000, "OC")).toMatchObject({ decodes: 1, stations: 1 });
  });

  it("gives decodes per window at an hour of the day, and the live counts for this hour", () => {
    const { db } = testDb();
    const m = new BandMemory(db);
    const day = Date.UTC(2026, 10, 1, 22, 0, 0), now = Date.UTC(2026, 10, 6, 22, 30, 0);
    const win = (t: number, band: string, n: number) => m.add(t, band, "FT8", Array.from({ length: n }, (_, i) => ({ sender: `K${i}AB`, snr: -10 })));
    // two past evenings at 22Z: 20M 10 then 20 decodes per window (4 windows each), 40M only 2 windows (too few, ignored)
    for (const [d, n] of [[0, 10], [1, 20]] as const) for (let w = 0; w < 4; w++) win(day + d * 86_400_000 + w * 15_000, "20M", n);
    win(day + 2 * 86_400_000, "40M", 8);
    win(day + 2 * 86_400_000 + 15_000, "40M", 8);
    m.flush();
    for (let w = 0; w < 5; w++) win(day + 3_600_000 + w * 15_000, "15M", 5); // 23Z the first evening, for "next hour"
    m.flush();
    const usual = m.activityAt(22, "FT8", 30, now);
    expect(usual.get("20M")).toEqual({ perWindow: 15, samples: 2 });
    expect(usual.has("40M")).toBe(false);
    expect(m.activityAt(23, "FT8", 30, now).get("15M")).toEqual({ perWindow: 5, samples: 1 });
    // live: this hour so far, before any flush
    win(now, "20M", 30);
    win(now + 15_000, "20M", 10);
    expect(m.current("FT8", now + 20_000).get("20M")).toEqual({ windows: 2, decodes: 40, stations: 30 });
    expect(m.current("FT8", now + 3_600_000).size).toBe(0); // a later hour has nothing yet
  });
});

describe("run recorder", () => {
  it("records a run and closes a dangling one on restart", () => {
    const { db } = testDb();
    const r = new RunRecorder(db);
    r.start("hunt", "op@example.com", "20M", 1000);
    r.mode("cq", "20M");
    r.band("40M");
    r.qso("40M", [{ kind: "dxcc", label: "new DXCC: Japan", callsign: "JA1XYZ" }]);
    r.transmission(12.64);
    r.fault("SWR 3.4:1");
    const id = r.active;
    new RunRecorder(db); // a restart while the run is open
    const row = db.select().from(runs).all()[0]!;
    expect(row.id).toBe(id);
    expect(JSON.parse(row.modes)).toEqual(["hunt", "cq"]);
    expect(JSON.parse(row.bands)).toEqual(["20M", "40M"]);
    expect(row.qsos).toBe(1);
    expect(row.txSeconds).toBe(13);
    expect(JSON.parse(row.newOnes)[0].label).toBe("new DXCC: Japan");
    expect(row.stopReason).toBe("engine stopped");
    expect(recentRuns(db)).toHaveLength(1);
  });
});

describe("heard-by", () => {
  it("parses PSKReporter reception reports", () => {
    const xml = `<?xml version="1.0"?><receptionReports>
      <receptionReport receiverCallsign="dl1abc" receiverLocator="JO62qm" senderCallsign="W9ML" frequency="14075123" flowStartSeconds="1792460000" mode="FT8" sNR="-12" />
      <receptionReport receiverCallsign="JA1XYZ" receiverLocator="PM95" senderCallsign="W9ML" frequency="14075200" flowStartSeconds="1792460100" mode="FT8" />
      <activeReceiver callsign="X" /></receptionReports>`;
    const r = parseReports(xml);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ receiver: "DL1ABC", grid: "JO62qm", freqHz: 14075123, at: 1792460000000, mode: "FT8", snr: -12 });
    expect(r[1]!.snr).toBeNull();
  });
});

describe("new-one classification", () => {
  it("names what a station is new for", () => {
    const empty: WorkedIndex = { dxcc: new Set([291]), dxccBand: new Set([291]), states: new Set(), statesBand: new Set(), grids: new Set(), gridsBand: new Set(), zones: new Set([4, 5]), continents: new Set(["NA"]), calls: new Set(), parks: new Set() };
    const s = score({ callsign: "JA1XYZ", grid: "PM95", snr: -10, park: null, potaCq: false }, empty);
    expect(s.kinds).toEqual(expect.arrayContaining(["dxcc", "continent", "zone", "grid", "call"]));
    expect(s.reasons[s.kinds.indexOf("dxcc")]).toMatch(/Japan/);
    const us = score({ callsign: "W1AW", grid: null, snr: -10, park: "US-1234", potaCq: true }, empty);
    expect(us.kinds).toContain("park");
    expect(us.kinds).not.toContain("dxcc");
  });
});

describe("POTA dupes", () => {
  it("count per park, band, mode and day: the same activator at a new park is a new contact", async () => {
    const { db, sqlite } = testDb();
    const { createQso } = await import("@zerobeat/core/log/qsos");
    const { LogQueries } = await import("../src/operate/worked.ts");
    sqlite.prepare("INSERT INTO stations (id,callsign,grid,name,is_default,created_at,updated_at) VALUES ('st1','W9ML','EN61jk','Home',1,0,0)").run();
    const t = Date.UTC(2026, 9, 20, 14, 0, 0);
    createQso(db, { stationId: "st1", callsign: "K1ABC", band: "20M", freqHz: 14_074_000, mode: "FT8", startTime: t, sigRefs: [{ sig: "POTA", ref: "US-1234" }] });
    const w = new LogQueries(db);
    w.station = () => "st1";
    const day = Date.UTC(2026, 9, 20);
    expect(w.workedAtPark("K1ABC", "US-1234", "20M", "FT8", day)).toBe(true);
    expect(w.workedAtPark("K1ABC", "US-5678", "20M", "FT8", day)).toBe(false);
    expect(w.workedAtPark("K1ABC", "US-1234", "40M", "FT8", day)).toBe(false);
    expect(w.workedAtPark("K1ABC", "US-1234", "20M", "FT8", day + 86_400_000)).toBe(false);
  });

  it("read only the operator's own logbook", async () => {
    const { db, sqlite } = testDb();
    const { createQso } = await import("@zerobeat/core/log/qsos");
    const { LogQueries } = await import("../src/operate/worked.ts");
    sqlite.prepare("INSERT INTO stations (id,callsign,grid,name,is_default,created_at,updated_at) VALUES ('st1','W9ML','EN61jk','Home',1,0,0), ('st2','K9PC','EN61jk','Club',0,0,0)").run();
    const t = Date.UTC(2026, 9, 20, 14, 0, 0);
    createQso(db, { stationId: "st1", callsign: "K1ABC", band: "20M", freqHz: 14_074_000, mode: "FT8", startTime: t, dxcc: 291 });
    const w = new LogQueries(db);
    w.station = () => "st1";
    expect(w.workedSince("K1ABC", "20M", "FT8", 0)).toBe(true);
    expect(w.worked("20M").calls.has("K1ABC")).toBe(true);
    // K9PC has the radio: W9ML's contact is not theirs, so not a dupe and still new.
    w.station = () => "st2";
    expect(w.workedSince("K1ABC", "20M", "FT8", 0)).toBe(false);
    expect(w.worked("20M").calls.has("K1ABC")).toBe(false);
    expect(w.worked("20M").dxcc.size).toBe(0);
  });
});

describe("band memory by hour of day", () => {
  it("averages what each band held at this UTC hour on the days it was monitored", () => {
    const { db } = testDb();
    const m = new BandMemory(db);
    const day = 86_400_000;
    const at14 = Date.UTC(2026, 9, 1, 14, 0, 0);
    for (let k = 0; k < 3; k++) {
      // 20 m: 10, 12, 14 stations at 14Z; 40 m: 3 stations; 15 m only once (too few).
      const t = at14 + k * day;
      for (let w = 0; w < 5; w++) m.add(t + w * 15_000, "20M", "FT8", Array.from({ length: 10 + 2 * k }, (_, i) => ({ sender: `K${i}AB`, snr: -10 })));
      for (let w = 0; w < 5; w++) m.add(t + w * 15_000, "40M", "FT8", [{ sender: "W1AW", snr: -5 }, { sender: "W2AW", snr: -6 }, { sender: "W3AW", snr: -7 }]);
      if (k === 0) for (let w = 0; w < 5; w++) m.add(t + w * 15_000, "15M", "FT8", [{ sender: "JA1AA", snr: -12 }]);
      m.flush();
    }
    const y = m.yieldAt(14, "FT8", 30, at14 + 3 * day);
    expect(y.get("20M")).toMatchObject({ avg: 12, samples: 3 });
    expect(y.get("40M")).toMatchObject({ avg: 3, samples: 3 });
    expect(y.get("15M")!.samples).toBe(1);
    expect(m.yieldAt(15, "FT8", 30, at14 + 3 * day).size).toBe(0);
  });
});
