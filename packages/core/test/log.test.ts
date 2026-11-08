import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "./testdb.ts";
import { stations, users, uploadState, qsos } from "../src/db/schema.ts";
import { createQso, searchQsos, updateQso, workedBefore, queueUploads, getQso } from "../src/log/qsos.ts";
import { importAdif } from "../src/log/import.ts";
import { computeAwards } from "../src/log/awards.ts";
import { summary } from "../src/log/stats.ts";
import { SettingsStore, SettingsError } from "../src/settings/store.ts";
import { SecretBox } from "../src/crypto/secrets.ts";
import { login, userForSession, createApiKey, identityForApiKey } from "../src/auth/sessions.ts";
import { hashPassword } from "../src/auth/password.ts";

const { db } = testDb();
const T0 = Date.UTC(2026, 9, 19, 18, 0, 0);

beforeAll(() => {
  db.insert(stations).values({ id: "st1", callsign: "W9ML", grid: "EN61jk", isDefault: true }).run();
});

describe("logbook", () => {
  it("creates with DXCC enrichment, sig refs and upload rows", () => {
    const { qso } = createQso(db, { stationId: "st1", callsign: "ja1xyz", band: "20M", freqHz: 14_074_500, mode: "FT8", startTime: T0, sigRefs: [] }, { uploadServices: ["qrz", "lotw"] });
    expect(qso.dxcc).toBe(339);
    expect(qso.continent).toBe("AS");
    expect(db.select().from(uploadState).where(eq(uploadState.qsoId, qso.id)).all()).toHaveLength(2);
    const { qso: p } = createQso(db, { stationId: "st1", callsign: "N7XAK", band: "20M", freqHz: 14_074_000, mode: "FT4", startTime: T0 + 60_000, sigRefs: [{ sig: "pota", ref: "us-1234" }, { sig: "POTA", ref: "US-5678" }] });
    expect(p.mode).toBe("MFSK");
    expect(p.submode).toBe("FT4");
    expect(p.sigInfo).toBe("US-1234");
    expect(getQso(db, p.id)!.sigRefs).toHaveLength(2);
  });
  it("is idempotent on clientId", () => {
    const a = createQso(db, { stationId: "st1", callsign: "K1ABC", band: "40M", freqHz: 7_074_000, mode: "SSB", startTime: T0, clientId: "c-1" });
    const b = createQso(db, { stationId: "st1", callsign: "K1ABC", band: "40M", freqHz: 7_074_000, mode: "SSB", startTime: T0, clientId: "c-1" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.qso.id).toBe(a.qso.id);
  });
  it("searches and reports worked-before", () => {
    expect(searchQsos(db, { q: "ja1" }).total).toBe(1);
    expect(searchQsos(db, { mode: "FT4" }).total).toBe(1);
    expect(searchQsos(db, { park: "US-5678" }).total).toBe(1);
    const w = workedBefore(db, "st1", "ja1xyz", "20M", "FT8", T0 + 1000);
    expect(workedBefore(db, "other", "ja1xyz").total).toBe(0); // another station's log
    expect(w).toMatchObject({ total: 1, thisBand: 1, thisBandMode: 1, today: 1 });
  });
  it("re-resolves DXCC when the callsign is corrected", () => {
    const { qso } = createQso(db, { stationId: "st1", callsign: "G4ABC", band: "20M", freqHz: 14_074_000, mode: "FT8", startTime: T0 });
    const u = updateQso(db, qso.id, { callsign: "VK3ABC" })!;
    expect(u.dxcc).toBe(150);
  });
  it("imports ADIF as history without queueing, and skips duplicates", () => {
    const adif = "<EOH><CALL:6>JA1XYZ<QSO_DATE:8>20261019<TIME_ON:6>180010<BAND:3>20M<MODE:3>FT8<EOR><CALL:4>W1AW<QSO_DATE:8>20261018<TIME_ON:4>1200<FREQ:5>7.030<MODE:2>CW<QSL_RCVD:1>Y<STATE:2>CT<EOR>";
    const r = importAdif(db, adif, { stationId: "st1", skipDuplicates: true, uploadServices: [] });
    expect(r).toMatchObject({ records: 2, imported: 1, duplicates: 1 });
    const w1aw = db.select().from(qsos).where(eq(qsos.callsign, "W1AW")).get()!;
    expect(db.select().from(uploadState).where(eq(uploadState.qsoId, w1aw.id)).all()).toHaveLength(0);
    expect(queueUploads(db, "eqsl", { stationId: "st1" })).toBeGreaterThan(0);
    expect(queueUploads(db, "clublog", { stationId: "another" })).toBe(0);
  });
  it("computes awards with one confirmation rule", () => {
    const a = computeAwards(db);
    const dxcc = a.find((x) => x.id === "dxcc")!;
    expect(dxcc.worked).toBeGreaterThanOrEqual(3);
    expect(dxcc.confirmed).toBe(1);
    const was = a.find((x) => x.id === "was")!;
    expect(was.entries.map((e) => e.key)).toEqual(["CT"]);
    expect(a.find((x) => x.id === "pota")!.worked).toBe(2);
    expect(summary(db, "st1", T0 + 1000).total).toBe(5);
  });
});

describe("settings", () => {
  const box = new SecretBox(Buffer.alloc(32, 7));
  const store = new SettingsStore(db, box);
  it("returns defaults, validates and encrypts secrets", () => {
    // Personal settings (QRZ, band hopping) are a user's own: write and read as one.
    db.insert(users).values({ id: "us", email: "settings@example.com", name: "S", passwordHash: "x", role: "ADMIN" }).run();
    store.actAs("us");
    expect(store.get("radio.rfPowerPct")).toBe(30);
    store.write({ "radio.rfPowerPct": "45", "qrz.password": "hunter2hunter2", "hop.bands": "40m, 20m" }, "us");
    expect(store.get("radio.rfPowerPct")).toBe(45);
    expect(store.get("qrz.password")).toBe("hunter2hunter2");
    expect(store.get("hop.bands")).toBe("40M,20M");
    const view = store.describe().find((v) => v.key === "qrz.password")!;
    expect(view).toMatchObject({ value: "", set: true, hint: "••••••ter2" });
    expect(() => store.write({ "radio.rfPowerPct": 500 }, null)).toThrow(SettingsError);
    expect(() => store.write({ "nope.key": 1 }, null)).toThrow(SettingsError);
    store.write({ "qrz.password": "" }, "us");
    expect(store.get("qrz.password")).toBe("");
  });
  it("sees another connection's writes", () => {
    const other = new SettingsStore(db, box);
    other.get("radio.daxChannel");
    store.write({ "radio.daxChannel": 2 }, null);
    expect(other.get("radio.daxChannel")).toBe(2);
  });
});

describe("auth", () => {
  it("logs in by email or callsign, throttles, and issues sessions", async () => {
    db.insert(users).values({ id: "u1", email: "op@example.com", name: "Op", callsign: "W9ML", passwordHash: await hashPassword("correct horse battery"), role: "ADMIN" }).run();
    const ok = await login(db, { identifier: "w9ml", password: "correct horse battery", ip: "1.2.3.4", userAgent: null, sessionDays: 1 });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(userForSession(db, ok.token)?.email).toBe("op@example.com");
    for (let i = 0; i < 8; i++) await login(db, { identifier: "op@example.com", password: "wrong", ip: `9.9.9.${i}`, userAgent: null, sessionDays: 1 });
    const locked = await login(db, { identifier: "op@example.com", password: "correct horse battery", ip: "5.5.5.5", userAgent: null, sessionDays: 1 });
    expect(locked).toMatchObject({ ok: false, reason: "locked" });
  }, 20000);
  it("issues API keys that resolve to a role", () => {
    const { token } = createApiKey(db, { name: "test", role: "OPERATOR", createdById: "u1" });
    expect(identityForApiKey(db, token)?.role).toBe("OPERATOR");
    expect(identityForApiKey(db, token + "x")).toBeNull();
  });
});
