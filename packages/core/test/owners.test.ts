/** Independent users: a station and personal settings and state each, moved once from the shared station. */
import { describe, expect, it } from "vitest";

import { SecretBox } from "../src/crypto/secrets.ts";
import { runs, settings, stations, userSettings, users } from "../src/db/schema.ts";
import { ensureUserStations, splitSharedStation, stationForUser } from "../src/log/owners.ts";
import { SettingsStore } from "../src/settings/store.ts";
import { EngineState } from "../src/state/engine-state.ts";
import { testDb } from "./testdb.ts";

function setup() {
  const { db } = testDb();
  const box = new SecretBox(Buffer.alloc(32, 7));
  db.insert(users).values([
    { id: "u1", email: "w9ml@example.com", name: "Michael", callsign: "W9ML", passwordHash: "x", role: "ADMIN" },
    { id: "u2", email: "k9pc@example.com", name: "PCARC", callsign: "k9pc", passwordHash: "x", role: "ADMIN" },
    { id: "u3", email: "nocall@example.com", name: "No Call", passwordHash: "x", role: "VIEWER" },
  ]).run();
  db.insert(stations).values({ id: "s1", callsign: "W9ML", grid: "EN61jk", name: "Home", isDefault: true }).run();
  db.insert(runs).values({ id: "r1", startedAt: 1, startedBy: "w9ml@example.com" }).run();
  return { db, box };
}

describe("independent users", () => {
  it("gives every user with a callsign a station, claiming theirs by call", () => {
    const { db } = setup();
    expect(ensureUserStations(db)).toBe(2);
    expect(stationForUser(db, "u1")!.id).toBe("s1");
    const k9pc = stationForUser(db, "u2")!;
    expect(k9pc.callsign).toBe("K9PC");
    expect(k9pc.grid).toBe("EN61jk");
    expect(stationForUser(db, "u3")).toBeNull();
    expect(ensureUserStations(db)).toBe(0);
  });

  it("moves the shared station's personal settings and state to its owner, once", () => {
    const { db, box } = setup();
    const store = new SettingsStore(db, box);
    store.write({ "radio.rfPowerPct": 40 }, null);
    // Before the split, a personal setting still lives with the shack (a legacy row).
    db.insert(settings).values({ key: "qrz.username", value: "w9ml", encrypted: false }).run();
    db.insert(settings).values({ key: "qrz.logbookKey", value: box.encrypt("KEY-123"), encrypted: true }).run();
    const state = new EngineState(db);
    state.set("cqSlot", 1);
    state.set("lastTune", { hz: 14_074_000, mode: "FT8" });

    const r = splitSharedStation(db);
    expect(r).toMatchObject({ owner: "u1", settings: 2, state: 1 });
    expect(db.select().from(settings).all().map((x) => x.key)).toEqual(["radio.rfPowerPct"]);
    expect(db.select().from(userSettings).all().map((x) => x.key).sort()).toEqual(["qrz.logbookKey", "qrz.username"]);
    expect(db.select().from(runs).get()!.stationId).toBe("s1");

    // Michael sees his own; K9PC sees defaults; both see the shack's.
    store.invalidate();
    expect(store.snapshot("u1")["qrz.username"]).toBe("w9ml");
    expect(store.snapshot("u1")["qrz.logbookKey"]).toBe("KEY-123");
    expect(store.snapshot("u2")["qrz.username"]).toBe("");
    expect(store.snapshot("u2")["radio.rfPowerPct"]).toBe(40);

    // Personal engine state follows the owner; the radio's stays shared.
    expect(state.forUser("u1").get("cqSlot")).toBe(1);
    expect(state.forUser("u2").get("cqSlot")).toBeUndefined();
    expect(state.forUser("u2").get("lastTune")).toEqual({ hz: 14_074_000, mode: "FT8" });

    expect(splitSharedStation(db)).toMatchObject({ owner: null, settings: 0 });
  });

  it("writes personal settings to the user and the shack's to everyone", () => {
    const { db, box } = setup();
    splitSharedStation(db);
    const store = new SettingsStore(db, box);
    store.write({ "udp.targets": "1.2.3.4:2237", "app.sessionDays": 7 }, "u2");
    expect(store.snapshot("u2")["udp.targets"]).toBe("1.2.3.4:2237");
    expect(store.snapshot("u1")["udp.targets"]).toBe("");
    expect(store.snapshot("u1")["app.sessionDays"]).toBe(7);
    expect(() => store.write({ "udp.targets": "x:1" }, null)).toThrow(/not valid/);
    // The engine reads as whoever has the radio.
    store.actAs("u2");
    expect(store.get("udp.targets")).toBe("1.2.3.4:2237");
    // A cleared secret stays cleared, not the shack's old value.
    store.write({ "qrz.logbookKey": "K2" }, "u2");
    expect(store.snapshot("u2")["qrz.logbookKey"]).toBe("K2");
    store.write({ "qrz.logbookKey": "" }, "u2");
    expect(store.snapshot("u2")["qrz.logbookKey"]).toBe("");
  });
});
