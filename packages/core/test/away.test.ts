import { describe, expect, it } from "vitest";

import { awaySummary } from "../src/log/away.ts";
import { createQso } from "../src/log/qsos.ts";
import { testDb } from "./testdb.ts";

describe("while you were away", () => {
  it("lists needed entities decoded and not worked, best decode first, and skips worked ones", () => {
    const { db, sqlite } = testDb();
    sqlite.prepare("INSERT INTO stations (id,callsign,grid,name,is_default,created_at,updated_at) VALUES ('st1','W9ML','EN61jk','Home',1,0,0)").run();
    const since = Date.UTC(2026, 9, 21, 2, 0);
    const ins = sqlite.prepare("INSERT INTO decodes (at, mode, band, dial_hz, audio_hz, snr, dt_ms, message, callsign, is_cq) VALUES (?, 'FT8', ?, 14074000, 1500, ?, 0, ?, ?, 1)");
    ins.run(since + 60_000, "20M", -18, "CQ 9H1AB JM75", "9H1AB");
    ins.run(since + 120_000, "17M", -11, "CQ 9H1AB JM75", "9H1AB");
    ins.run(since + 180_000, "20M", -5, "CQ JA1AA PM95", "JA1AA");
    ins.run(since - 600_000, "20M", -3, "CQ A52AA NL49", "A52AA"); // before: not counted
    createQso(db, { stationId: "st1", callsign: "JA2BB", band: "20M", freqHz: 14_074_000, mode: "FT8", startTime: since - 86_400_000, dxcc: 339 });
    const a = awaySummary(db, "st1", since);
    expect(a.missed.map((m) => m.callsign)).toEqual(["9H1AB"]);
    expect(a.missed[0]).toMatchObject({ band: "17M", snr: -11, times: 2 });
    expect(a.contacts).toBe(1); // created now, so after since
  });
});
