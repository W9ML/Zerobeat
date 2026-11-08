/** Fixes from the 2026-10-20 panel review that live in core. */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { LoginThrottle } from "../src/auth/sessions.ts";
import { uploadState } from "../src/db/schema.ts";
import { createQso, getQso, updateQso } from "../src/log/qsos.ts";
import { SETTINGS } from "../src/settings/registry.ts";
import { testDb } from "./testdb.ts";

const { db, sqlite } = testDb();
sqlite.prepare("INSERT INTO stations (id,callsign,grid,name,is_default,created_at,updated_at) VALUES ('st1','W9ML','EN61jk','Home',1,0,0)").run();
const T0 = Date.UTC(2026, 9, 20, 18, 0, 0);

describe("login throttle", () => {
  it("slows an account down after repeated failures but never locks it: its name is public", () => {
    const t = new LoginThrottle(db);
    let now = T0;
    for (let i = 0; i < 4; i++) t.fail("10.0.0.1", "w9ml", now);
    expect(t.blockedFor("10.0.0.2", "w9ml", now)).toBe(0);
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      t.fail("10.0.0.1", "w9ml", now);
      waits.push(t.blockedFor("10.0.0.2", "W9ML", now));
      now += 31_000; // the owner waits the delay out before the next attempt
    }
    expect(waits.slice(0, 4)).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(Math.max(...waits)).toBe(30_000);
    // The delay is a delay, not a lock: it has passed by the next attempt.
    expect(t.blockedFor("10.0.0.2", "w9ml", now)).toBe(0);
  });

  it("still locks an address that keeps failing", () => {
    const t = new LoginThrottle(db);
    for (let i = 0; i < 20; i++) t.fail("10.9.9.9", `user${i}`, T0);
    expect(t.blockedFor("10.9.9.9", "someone", T0 + 1000)).toBe(15 * 60_000 - 1000);
  });
});

describe("editing a contact", () => {
  it("keeps activity references the form does not edit", () => {
    const { qso } = createQso(db, { stationId: "st1", callsign: "K1ABC", band: "20M", freqHz: 14_074_000, mode: "FT8", startTime: T0, sigRefs: [{ sig: "SOTA", ref: "W4C/CM-001" }, { sig: "POTA", ref: "US-1234" }] });
    updateQso(db, qso.id, { sigRefs: [{ sig: "POTA", ref: "US-9999" }] });
    const refs = getQso(db, qso.id)!.sigRefs.map((r) => `${r.sig}:${r.ref}`).sort();
    expect(refs).toEqual(["POTA:US-9999", "SOTA:W4C/CM-001"]);
  });

  it("drops confirmations and re-queues every service when the call, band, mode or minute changes", () => {
    const { qso } = createQso(db, { stationId: "st1", callsign: "G4ABC", band: "20M", freqHz: 14_074_000, mode: "FT8", startTime: T0, lotwRcvd: true, lotwRcvdAt: T0 + 1 }, { uploadServices: ["lotw", "qrz"] });
    db.update(uploadState).set({ status: "sent" }).where(eq(uploadState.qsoId, qso.id)).run();
    // A note changes nothing.
    updateQso(db, qso.id, { notes: "nice chat" });
    expect(getQso(db, qso.id)!.qso.lotwRcvd).toBe(true);
    expect(db.select().from(uploadState).where(and(eq(uploadState.qsoId, qso.id), eq(uploadState.service, "lotw"))).get()!.status).toBe("sent");
    // A band change is a different contact to the services.
    updateQso(db, qso.id, { band: "40M", freqHz: 7_074_000 });
    expect(getQso(db, qso.id)!.qso.lotwRcvd).toBe(false);
    for (const service of ["lotw", "qrz"] as const) {
      expect(db.select().from(uploadState).where(and(eq(uploadState.qsoId, qso.id), eq(uploadState.service, service))).get()!.status).toBe("pending");
    }
  });
});

describe("settings", () => {
  it("accepts a real time for the morning summary", () => {
    const def = SETTINGS.find((d) => d.key.toLowerCase().includes("digest") && d.default === "07:00")!;
    expect(def).toBeTruthy();
    expect(def.schema.safeParse("06:30").success).toBe(true);
    expect(def.schema.safeParse("23:59").success).toBe(true);
    expect(def.schema.safeParse("").success).toBe(true);
    expect(def.schema.safeParse("6:30").success).toBe(false);
    expect(def.schema.safeParse("24:00").success).toBe(false);
  });
});

describe("ADIF round trip", () => {
  it("keeps what it reads: operator, upload statuses, COMMENT beside NOTES, Q/I/V letters, n-fers", async () => {
    const { parseAdif, qsoToAdif, recordToContact, dupeKey } = await import("../src/adif/adif.ts");
    const r = recordToContact({
      CALL: "K1ABC", QSO_DATE: "20261019", TIME_ON: "1234", FREQ: "14.074", MODE: "FT8",
      OPERATOR: "N1MM", OWNER_CALLSIGN: "W1AW", LOTW_QSL_SENT: "Y", CLUBLOG_QSO_UPLOAD_STATUS: "Y",
      NOTES: "line one\nline two", COMMENT: "short one", QSL_SENT: "Q", QSL_RCVD: "V",
      MY_SIG: "POTA", MY_SIG_INFO: "US-1234,US-5678",
    });
    if (!r.ok) throw new Error(r.error);
    const q = { id: "x", stationId: "s", operatorId: null, clientId: null, createdAt: 0, updatedAt: 0, ...r.value.qso } as never;
    const back = parseAdif(qsoToAdif(q, { callsign: "W9ML", grid: "EN61jk" }, [], { full: true })).records[0]!;
    expect(back.OPERATOR).toBe("N1MM");
    expect(back.OWNER_CALLSIGN).toBe("W1AW");
    expect(back.LOTW_QSL_SENT).toBe("Y");
    expect(back.CLUBLOG_QSO_UPLOAD_STATUS).toBe("Y");
    expect(back.COMMENT).toBe("short one");
    expect(back.NOTES).toBe("line one\nline two");
    expect(back.QSL_SENT).toBe("Q");
    expect(back.QSL_RCVD).toBe("V");
    expect(back.MY_SIG_INFO).toBe("US-1234,US-5678");
    expect(back._QSL_RAW).toBeUndefined();
    // SSB and SSB/USB are one mode for dupes; FT4 and JS8 are not.
    const t = Date.UTC(2026, 9, 19, 12, 34);
    expect(dupeKey({ callsign: "K1ABC", band: "20M", mode: "SSB", startTime: t })).toBe(dupeKey({ callsign: "K1ABC", band: "20M", mode: "SSB", submode: "USB", startTime: t }));
    expect(dupeKey({ callsign: "K1ABC", band: "20M", mode: "MFSK", submode: "FT4", startTime: t })).not.toBe(dupeKey({ callsign: "K1ABC", band: "20M", mode: "MFSK", submode: "JS8", startTime: t }));
  });
});

describe("awards", () => {
  it("count six continents, DC as Maryland, and keep unknown entities out of the DXCC total", async () => {
    const { computeAwards } = await import("../src/log/awards.ts");
    const base = { stationId: "st1", band: "20M", freqHz: 14_074_000, mode: "FT8", startTime: T0 + 3_600_000 };
    createQso(db, { ...base, callsign: "W3DC", state: "DC", dxcc: 291, continent: "NA" });
    createQso(db, { ...base, callsign: "PJ2ABC", dxcc: 85, continent: "SA", startTime: T0 + 3_700_000 });
    const a = computeAwards(db);
    const wac = a.find((x) => x.id === "wac")!;
    const was = a.find((x) => x.id === "was")!;
    const dx = a.find((x) => x.id === "dxcc")!;
    expect(wac.total).toBe(6);
    expect(was.entries.some((e) => e.key === "MD")).toBe(true);
    expect(dx.entries.some((e) => e.key === "85")).toBe(false);
    expect(dx.outside?.some((e) => e.key === "85")).toBe(true);
    expect(a.find((x) => x.id === "pota")!.confirms).toBe(false);
  });
});

describe("operator attribution", () => {
  it("keeps one operator row per user per station and writes OPERATOR on export", async () => {
    const { operatorForUser, operatorCalls } = await import("../src/log/operators.ts");
    const { qsoToAdif } = await import("../src/adif/adif.ts");
    sqlite.prepare("INSERT INTO users (id,email,name,callsign,password_hash,role,license_class,active,created_at,updated_at) VALUES ('u1','kd9xyz@example.test','Pat','KD9XYZ','x','OPERATOR','T',1,0,0)").run();
    const a = operatorForUser(db, "st1", "u1", "W9ML")!;
    expect(operatorForUser(db, "st1", "u1", "W9ML")).toBe(a);
    expect(operatorCalls(db).get(a)).toBe("KD9XYZ");
    const { qso } = createQso(db, { stationId: "st1", operatorId: a, callsign: "K1ABC", band: "10M", freqHz: 28_074_000, mode: "FT8", startTime: T0 + 7_200_000 });
    const rec = qsoToAdif(qso, { callsign: "W9ML", grid: "EN61jk" }, [], { operator: operatorCalls(db).get(a) });
    expect(rec).toContain("<OPERATOR:6>KD9XYZ");
    expect(rec).toContain("<STATION_CALLSIGN:4>W9ML");
  });
});
