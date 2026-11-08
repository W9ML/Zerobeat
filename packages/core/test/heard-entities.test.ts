import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { backfillEntities, heardNeverWorked, recordEntities } from "../src/log/heard-entities.ts";
import { createQso } from "../src/log/qsos.ts";
import { testDb } from "./testdb.ts";

const DAY = 86_400_000;
const T = Date.UTC(2026, 9, 1, 5, 10);

describe("heard entities", () => {
  it("counts days, keeps the best SNR, and ranks entities heard but never worked", () => {
    const { db, sqlite } = testDb();
    sqlite.prepare("INSERT INTO stations (id,callsign,grid,name,is_default,created_at,updated_at) VALUES ('st1','W9ML','EN61jk','Home',1,0,0)").run();
    // Bhutan (A5, 306) on 40 m at 05Z on three days; Japan (339) on 20 m once.
    for (let d = 0; d < 3; d++) {
      recordEntities(db, new Map([["40M|FT8|306|5", { decodes: 2, bestSnr: -18 + d, lastAt: T + d * DAY, lastCall: "A52AA" }]]));
    }
    // The same day twice counts once.
    recordEntities(db, new Map([["40M|FT8|306|5", { decodes: 1, bestSnr: -20, lastAt: T + 2 * DAY + 60_000, lastCall: "A52BB" }]]));
    recordEntities(db, new Map([["20M|FT8|339|12", { decodes: 5, bestSnr: -5, lastAt: T, lastCall: "JA1AA" }]]));
    const row = db.get<{ days: number; decodes: number; best_snr: number; last_call: string }>(sql`SELECT days, decodes, best_snr, last_call FROM heard_entities WHERE dxcc = 306`)!;
    expect(row).toEqual({ days: 3, decodes: 7, best_snr: -16, last_call: "A52BB" });

    let list = heardNeverWorked(db, "st1");
    expect(list.map((e) => e.dxcc)).toEqual([306, 339]);
    expect(list[0]!.best).toMatchObject({ band: "40M", hourOfDay: 5, days: 3 });
    // Worked Japan: it drops off the list.
    createQso(db, { stationId: "st1", callsign: "JA1AA", band: "20M", freqHz: 14_074_000, mode: "FT8", startTime: T, dxcc: 339 });
    list = heardNeverWorked(db, "st1");
    expect(list.map((e) => e.dxcc)).toEqual([306]);
  });

  it("fills itself once from stored decodes", () => {
    const { db, sqlite } = testDb();
    const ins = sqlite.prepare("INSERT INTO decodes (at, mode, band, dial_hz, audio_hz, snr, dt_ms, message, callsign, is_cq) VALUES (?, 'FT8', '20M', 14074000, 1500, ?, 0, ?, ?, 1)");
    ins.run(T, -10, "CQ JA1AA PM95", "JA1AA");
    ins.run(T + DAY, -8, "CQ JA2BB PM85", "JA2BB");
    expect(backfillEntities(db)).toBe(2);
    expect(backfillEntities(db)).toBe(0);
    const row = db.get<{ days: number; decodes: number }>(sql`SELECT days, decodes FROM heard_entities WHERE dxcc = 339`)!;
    expect(row).toEqual({ days: 2, decodes: 2 });
  });
});
