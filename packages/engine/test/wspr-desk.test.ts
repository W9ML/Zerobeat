import { describe, expect, it, vi } from "vitest";

import type { AuxDecoder } from "../src/digital/aux-decoder.ts";
import { receiveGap, WsprDesk, wsprMessage, wsprnetSpotForm, wsprnetStatusForm, type WsprConfig, type WsprSpot } from "../src/operate/wspr.ts";

describe("WSPR desk", () => {
  it("beacons a type 1 message for a standard call, type 2 for a compound one", () => {
    expect(wsprMessage("w9ml", "EN61jk", 30)).toBe("W9ML EN61 30");
    expect(wsprMessage("PJ4/K1ABC", "FK52", 37)).toBe("PJ4/K1ABC 37");
  });

  it("waits 2-5 periods between beacons at 25 %, as K1JT's scheduler does, and never transmits at 0 %", () => {
    const gaps = Array.from({ length: 200 }, (_, i) => receiveGap(25, () => (i % 100) / 100));
    expect(Math.min(...gaps)).toBe(2);
    expect(Math.max(...gaps)).toBe(4);
    expect(receiveGap(20, () => 0.99)).toBe(5);
    expect(receiveGap(0)).toBe(Infinity);
  });

  it("posts spots to WSPRnet with WSJT-X's fields", () => {
    const s: WsprSpot = { message: "K1ABC FN42 37", type: 1, callsign: "K1ABC", grid: "FN42", dbm: 37, freqHz: 14_097_046, dtSec: 1.13, driftHz: 0, snrDb: -9, sync: 0.5, pass: 1, cycles: 10, at: Date.UTC(2026, 9, 20, 18, 4), dialHz: 14_095_600, uploaded: false };
    const c = { call: "W9ML", grid6: "EN61jk", dialHz: 14_095_600, txPct: 20, dbm: 30, upload: true, version: "Zerobeat" };
    expect(Object.fromEntries(wsprnetSpotForm(s, c))).toEqual({
      function: "wspr", rcall: "W9ML", rgrid: "EN61jk", rqrg: "14.097100", date: "261020", time: "1804", sig: "-9", dt: "1.1", drift: "0",
      tqrg: "14.097046", tcall: "K1ABC", tgrid: "FN42", dbm: "37", version: "Zerobeat", mode: "2",
    });
    expect(Object.fromEntries(wsprnetStatusForm(c))).toMatchObject({ function: "wsprstat", tpct: "20", rqrg: "14.097100", mode: "2" });
  });

  it("plans no beacon while transmit is off, and does once it is on", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 20, 17, 0, 30));
    try {
      let canTransmit = false;
      const tx: number[] = [];
      const config = (): WsprConfig => ({ call: "W9ML", grid6: "EN61JK", dialHz: 14_095_600, txPct: 100, dbm: 30, upload: false, version: "t", canTransmit });
      const d = new WsprDesk({} as AuxDecoder, "/nonexistent", config, async (t) => void tx.push(t), () => {});
      d.start();
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(120_000);
      expect(tx).toEqual([]);
      expect(d.nextTx).toBeNull();
      canTransmit = true;
      for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(120_000);
      expect(tx.length).toBeGreaterThan(0);
      d.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
