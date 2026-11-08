import { afterEach, describe, expect, it, vi } from "vitest";

import { wrlPayload, wrlStatus, wrlUpload, type WrlContactSource } from "../src/integrations/wrl.ts";

const Q: WrlContactSource = {
  callsign: "k1abc",
  startTime: Date.UTC(2026, 9, 19, 14, 35, 0, 400),
  freqHz: 14_075_512,
  band: "20M",
  mode: "MFSK",
  submode: "FT4",
  rstSent: "-10",
  rstRcvd: "-12",
  txPowerW: 50.4,
  notes: null,
  name: "",
  qth: null,
  state: "MA",
  grid: "FN42",
  myGrid: "EN61jk",
  mySig: null,
  mySigInfo: null,
  stationCallsign: "w9ml",
  theirRefs: [
    { sig: "POTA", ref: "us-0662" },
    { sig: "WAB", ref: "SU12" },
  ],
};

type Call = { url: string; method: string; body: unknown; auth: string | null };

function mockFetch(responses: { status: number; body?: unknown; headers?: Record<string, string> }[]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null, auth: (init.headers as Record<string, string>).authorization ?? null });
      const r = responses.shift() ?? { status: 500 };
      return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: r.headers });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("WRL payload", () => {
  it("uses only spec fields, the submode, MHz and lower-case band", () => {
    const p = wrlPayload(Q, null);
    expect(p).toEqual({
      programId: "Zerobeat",
      call: "K1ABC",
      timestamp: "2026-10-19T14:35:00Z",
      freq: 14.075512,
      band: "20m",
      mode: "FT4",
      rstSent: "-10",
      rstRcvd: "-12",
      txPwr: "50",
      state: "MA",
      stationCallsign: "W9ML",
      gridsquare: "FN42",
      myGridsquare: "EN61jk",
      theirActivities: [{ type: "POTA", ref: "US-0662" }],
    });
  });

  it("drops a malformed grid instead of sending something WRL refuses", () => {
    expect(wrlPayload({ ...Q, grid: "XX99" }, null).gridsquare).toBeUndefined();
  });
});

describe("WRL upload", () => {
  it("posts with the bearer key and reports the new id", async () => {
    const calls = mockFetch([{ status: 201, body: { data: { id: "c1" }, meta: {}, error: null } }]);
    const o = await wrlUpload("wrl_live_x", Q, { logbookId: null, checkFirst: false });
    expect(o).toEqual({ status: "sent", remoteId: "c1", detail: undefined });
    expect(calls[0]).toMatchObject({ method: "POST", auth: "Bearer wrl_live_x" });
    expect(calls[0]!.url).toBe("https://api.worldradioleague.com/v1/contacts");
  });

  it("looks before re-posting, so a timed-out attempt is not logged twice", async () => {
    const calls = mockFetch([{ status: 200, body: { data: [{ id: "c9", mode: "FT4" }], meta: {}, error: null } }]);
    const o = await wrlUpload("k", Q, { logbookId: null, checkFirst: true });
    expect(o.status).toBe("duplicate");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("call=K1ABC");
  });

  it("retries once without activities WRL does not know", async () => {
    const calls = mockFetch([
      { status: 422, body: { data: null, meta: null, error: { code: "UNKNOWN_ACTIVITY_REFERENCE", message: "no such park" } } },
      { status: 201, body: { data: { id: "c2" }, meta: {}, error: null } },
    ]);
    const o = await wrlUpload("k", Q, { logbookId: null, checkFirst: false });
    expect(o.status).toBe("sent");
    expect((calls[1]!.body as Record<string, unknown>).theirActivities).toBeUndefined();
  });

  it("maps failures to the queue's outcomes", async () => {
    mockFetch([{ status: 401, body: { error: { code: "INVALID_KEY", message: "bad key" } } }]);
    expect((await wrlUpload("k", Q, { logbookId: null, checkFirst: false })).status).toBe("auth");
    mockFetch([{ status: 422, body: { error: { code: "LOGBOOK_REQUIRED" } } }]);
    expect((await wrlUpload("k", Q, { logbookId: null, checkFirst: false })).status).toBe("auth");
    mockFetch([{ status: 422, body: { error: { code: "VALIDATION_ERROR", message: "bad band", field: "band" } } }]);
    expect(await wrlUpload("k", Q, { logbookId: null, checkFirst: false })).toEqual({ status: "rejected", detail: "VALIDATION_ERROR: bad band: (field band)" });
    mockFetch([{ status: 429, headers: { "retry-after": "30" } }]);
    expect((await wrlUpload("k", Q, { logbookId: null, checkFirst: false })).status).toBe("retry");
    mockFetch([{ status: 503 }]);
    expect((await wrlUpload("k", Q, { logbookId: null, checkFirst: false })).status).toBe("retry");
  });

  it("refuses a contact with no frequency without calling WRL", async () => {
    const calls = mockFetch([]);
    expect((await wrlUpload("k", { ...Q, freqHz: null }, { logbookId: null, checkFirst: false })).status).toBe("rejected");
    expect(calls).toHaveLength(0);
  });
});

describe("WRL key check", () => {
  it("lists logbooks when there is no default to fall back on", async () => {
    mockFetch([
      { status: 200, body: { data: { scopes: ["contacts:rw", "logbooks:rw"], defaultLogbook: { logbookId: null, resolution: "ambiguous" } } } },
      { status: 200, body: { data: [{ id: "a", name: "Home" }, { id: "b", name: "POTA" }] } },
    ]);
    const r = await wrlStatus("k", null);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("Home = a");
    expect(r.detail).toContain("POTA = b");
  });
});

describe("WRL logbook picker", () => {
  it("returns the logbooks and the default", async () => {
    const { wrlLogbooks } = await import("../src/integrations/wrl.ts");
    mockFetch([
      { status: 200, body: { data: { scopes: ["contacts:rw"], defaultLogbook: { logbookId: "b", resolution: "configured" } } } },
      { status: 200, body: { data: [{ id: "a", name: "Home", defaultCallSign: "W9ML" }, { id: "b", name: "POTA", isLocked: true }] } },
    ]);
    expect(await wrlLogbooks("k")).toEqual({
      ok: true,
      defaultId: "b",
      logbooks: [
        { id: "a", name: "Home", locked: false, callsign: "W9ML" },
        { id: "b", name: "POTA", locked: true, callsign: null },
      ],
    });
    mockFetch([{ status: 401, body: { error: { code: "INVALID_KEY" } } }]);
    expect(await wrlLogbooks("k")).toEqual({ ok: false, error: "World Radio League refused this key" });
  });
});
