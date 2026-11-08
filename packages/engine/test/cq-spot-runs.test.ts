/** CQ moving off a taken frequency, and an automatic run carried on across restarts. */
import { describe, expect, it } from "vitest";

import { runs } from "@zerobeat/core/db/schema";

import { cqClearSpot } from "../src/operate/cq-spot.ts";
import { Guards } from "../src/operate/guards.ts";
import { RunRecorder } from "../src/operate/runs.ts";
import { testDb } from "../../core/test/testdb.ts";

const at = (offsetHz: number, sender = "K1ABC") => ({ offsetHz, sender });

describe("CQ clear spot", () => {
  it("stays put when no one in our slot is on our frequency", () => {
    expect(cqClearSpot([], 1500, "FT8")).toBeNull();
    expect(cqClearSpot([at(1400), at(1600)], 1500, "FT8")).toBeNull();
  });

  it("moves to the nearest spot clear of everyone in the slot", () => {
    const s = cqClearSpot([at(1510), at(1440), at(1620)], 1500, "FT8")!;
    expect(s.call).toBe("K1ABC");
    expect(s.theirHz).toBe(1510);
    for (const f of [1510, 1440, 1620]) expect(Math.abs(s.hz - f)).toBeGreaterThanOrEqual(65);
    expect(Math.abs(s.hz - 1500)).toBeLessThan(200);
  });

  it("allows for FT4's wider signal", () => {
    expect(cqClearSpot([at(1430)], 1500, "FT4")).not.toBeNull();
    expect(cqClearSpot([at(1430)], 1500, "FT8")).toBeNull();
  });

  it("goes to the widest gap when the band is full", () => {
    const heard = Array.from({ length: 45 }, (_, i) => at(400 + i * 50));
    const s = cqClearSpot(heard, 1500, "FT8")!;
    expect(s.hz).toBeGreaterThan(2600);
  });
});

describe("run across restarts", () => {
  it("carries on the interrupted run, folding in earlier pieces", () => {
    const { db } = testDb();
    const start = 1_000_000;
    let r = new RunRecorder(db);
    r.start("cq", "op@example.com", "20M", start);
    for (let i = 0; i < 4; i++) r.qso("20M", []);
    r.stop("engine stopped", start + 10_000);
    // An earlier restart had already split it once.
    r = new RunRecorder(db);
    r.start("cq", "resume after restart", "20M", start + 1);
    r.qso("40M", []);
    r.stop("engine stopped", start + 20_000);

    r = new RunRecorder(db);
    const sofar = r.resume(start, "cq", "20M");
    expect(sofar).toBe(5);
    const all = db.select().from(runs).all();
    expect(all).toHaveLength(1);
    expect(all[0]!.endedAt).toBeNull();
    expect(JSON.parse(all[0]!.bands)).toEqual(["20M", "40M"]);
    r.qso("20M", []);
    expect(db.select().from(runs).all()[0]!.qsos).toBe(6);

    const g = new Guards(() => ({}) as never);
    g.beginRun(start + 30_000, start, sofar!);
    expect(g.state.qsosThisRun).toBe(5);
    expect(g.state.runStartedAt).toBe(start);
  });

  it("does not reopen a run a person stopped", () => {
    const { db } = testDb();
    const r = new RunRecorder(db);
    r.start("cq", "op@example.com", "20M", 5000);
    r.stop("transmit turned off");
    expect(new RunRecorder(db).resume(5000, "cq", "20M")).toBeNull();
  });
});
