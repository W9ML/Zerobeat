import { describe, expect, it } from "vitest";

import { createQso } from "../../core/src/log/qsos.ts";
import { testDb } from "../../core/test/testdb.ts";
import { isStationId, NeededLogs, parseCallBands } from "../src/api/needed.ts";

const T = Date.UTC(2026, 10, 5, 18, 0);

describe("needed calls", () => {
  it("reads CALL:BAND pairs, normalising case and dropping repeats", () => {
    expect(parseCallBands("k1abc:20m, JA1XYZ:17M,K1ABC:20M,VP2V/W9ML:6m")).toEqual([
      { call: "K1ABC", band: "20M" },
      { call: "JA1XYZ", band: "17M" },
      { call: "VP2V/W9ML", band: "6M" },
    ]);
  });

  it("refuses malformed pairs, unknown bands and more than 50", () => {
    for (const bad of [null, "", " ", "K1ABC", "K1ABC:20", "K1ABC:21M", ":20M", "K1ABC:20M:x", "K1ABC:20M,", "<b>:20M", "ABC:20M"]) {
      expect(typeof parseCallBands(bad)).toBe("string");
    }
    const many = (n: number) => Array.from({ length: n }, (_, i) => `K${i}ABC:20M`).join(",");
    expect(parseCallBands(many(50))).toHaveLength(50);
    expect(parseCallBands(many(51))).toBe("at most 50 calls per request");
  });

  it("checks station ids", () => {
    expect(isStationId("st1")).toBe(true);
    expect(isStationId("")).toBe(false);
    expect(isStationId(null)).toBe(false);
    expect(isStationId("a b")).toBe(false);
    expect(isStationId("x".repeat(65))).toBe(false);
  });

  it("scores against the asked station's log, not another's", () => {
    const { db, sqlite } = testDb();
    sqlite.prepare("INSERT INTO stations (id,callsign,grid,name,is_default,created_at,updated_at) VALUES ('st1','W9ML','EN61jk','Home',1,0,0)").run();
    sqlite.prepare("INSERT INTO stations (id,callsign,grid,name,is_default,created_at,updated_at) VALUES ('st2','KD9NSC','EN61','Tav',0,0,0)").run();
    createQso(db, { stationId: "st1", callsign: "JA1AA", band: "20M", freqHz: 14_074_000, mode: "FT8", startTime: T, dxcc: 339, continent: "AS", cqZone: 25 });
    const logs = new NeededLogs(db);

    const mine = logs.needed("st1", [{ call: "JA1XYZ", band: "20M" }, { call: "JA1XYZ", band: "17M" }, { call: "JA1AA", band: "20M" }], T);
    expect(mine.at).toBe(T);
    expect(mine.needed[0]).toEqual({ call: "JA1XYZ", band: "20M", kinds: ["call"], points: 12, dxcc: 339 });
    expect(mine.needed[1]!.kinds).toEqual(["band", "call"]);
    expect(mine.needed[2]).toMatchObject({ kinds: [], points: 0 });

    const theirs = logs.needed("st2", [{ call: "JA1XYZ", band: "20M" }], T);
    expect(theirs.needed[0]!.kinds.slice(0, 3)).toEqual(["dxcc", "continent", "zone"]);
  });

  it("forgets the worked index when told a contact was logged", () => {
    const { db, sqlite } = testDb();
    sqlite.prepare("INSERT INTO stations (id,callsign,grid,name,is_default,created_at,updated_at) VALUES ('st1','W9ML','EN61jk','Home',1,0,0)").run();
    const logs = new NeededLogs(db);
    expect(logs.needed("st1", [{ call: "JA1AA", band: "20M" }], T).needed[0]!.kinds).toContain("dxcc");
    createQso(db, { stationId: "st1", callsign: "JA1AA", band: "20M", freqHz: 14_074_000, mode: "FT8", startTime: T, dxcc: 339 });
    expect(logs.needed("st1", [{ call: "JA1AA", band: "20M" }], T + 1).needed[0]!.kinds).toContain("dxcc");
    logs.invalidate();
    expect(logs.needed("st1", [{ call: "JA1AA", band: "20M" }], T + 2).needed[0]!.kinds).not.toContain("dxcc");
  });
});
