/**
 * World Radio League logbook (api.worldradioleague.com, OpenAPI 1.1).
 *
 *   GET  /v1/me         key check, default logbook, limits
 *   GET  /v1/logbooks   the account's logbooks
 *   GET  /v1/contacts   search (call, since, until) — used to make retries safe
 *   POST /v1/contacts   one contact per request, JSON with camelCased ADIF names
 *
 * Auth is `Authorization: Bearer wrl_live_…` (an account-wide key from Integrations →
 * Developer API). Unknown fields are refused with 400, so only fields in the spec are
 * sent, and empty ones are left out.
 *
 * POST has no idempotency key and WRL keeps duplicates (it only flags them), so a
 * request that timed out or failed with 5xx may have landed anyway. Before trying a
 * contact again we look for it first; only if it is not there do we post again.
 */
import { httpRequest, NetError, type UploadOutcome } from "./http.ts";

export const WRL_BASE = "https://api.worldradioleague.com/v1";
const PROGRAM_ID = "Zerobeat";
const GRID = /^[A-Ra-r]{2}(?:[0-9]{2}(?:[A-Xa-x]{2}(?:[0-9]{2})?)?)?$/;
const ACTIVITY_TYPES = new Set(["POTA", "SOTA", "WWFF", "IOTA"]);

export interface WrlContactSource {
  callsign: string;
  startTime: number;
  freqHz: number | null;
  band: string;
  mode: string;
  submode: string | null;
  rstSent: string | null;
  rstRcvd: string | null;
  txPowerW: number | null;
  notes: string | null;
  name: string | null;
  qth: string | null;
  state: string | null;
  grid: string | null;
  myGrid: string | null;
  mySig: string | null;
  mySigInfo: string | null;
  stationCallsign: string;
  theirRefs: { sig: string; ref: string }[];
}

interface WrlError {
  code?: string;
  message?: string;
  field?: string;
  hint?: string;
}

/** The JSON body for POST /v1/contacts. Pure, for tests. */
export function wrlPayload(q: WrlContactSource, logbookId: string | null, withActivities = true): Record<string, unknown> {
  const out: Record<string, unknown> = {
    programId: PROGRAM_ID,
    call: q.callsign.toUpperCase(),
    timestamp: new Date(q.startTime).toISOString().replace(/\.\d{3}Z$/, "Z"),
    band: q.band.toLowerCase(),
    freq: Math.round(q.freqHz ?? 0) / 1e6,
    mode: q.submode || q.mode,
  };
  const put = (k: string, v: string | null | undefined, max: number) => {
    const t = (v ?? "").trim();
    if (t) out[k] = t.slice(0, max);
  };
  if (logbookId) out.logbookId = logbookId;
  put("rstSent", q.rstSent, 10);
  put("rstRcvd", q.rstRcvd, 10);
  if (q.txPowerW) out.txPwr = String(Math.round(q.txPowerW));
  put("notes", q.notes, 2000);
  put("name", q.name, 255);
  put("qth", q.qth, 100);
  put("state", q.state, 50);
  put("stationCallsign", q.stationCallsign.toUpperCase(), 20);
  if (q.grid && GRID.test(q.grid)) out.gridsquare = q.grid;
  if (q.myGrid && GRID.test(q.myGrid)) out.myGridsquare = q.myGrid;
  if (withActivities) {
    const theirs = q.theirRefs.filter((r) => ACTIVITY_TYPES.has(r.sig.toUpperCase())).slice(0, 7).map((r) => ({ type: r.sig.toUpperCase(), ref: r.ref.toUpperCase() }));
    if (theirs.length) out.theirActivities = theirs;
    if (q.mySig && q.mySigInfo && ACTIVITY_TYPES.has(q.mySig.toUpperCase())) {
      out.myActivities = q.mySigInfo
        .split(/[,\s]+/)
        .filter(Boolean)
        .slice(0, 7)
        .map((ref, i) => ({ type: q.mySig!.toUpperCase(), ref: ref.toUpperCase(), ...(i === 0 ? { isPrimary: true } : {}) }));
    }
  }
  return out;
}

async function call(key: string, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: { data?: unknown; meta?: Record<string, unknown>; error?: WrlError } | null; retryAfter: number | null }> {
  const r = await httpRequest(`${WRL_BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    timeoutMs: 20_000,
  });
  let json = null;
  try {
    json = r.text ? JSON.parse(r.text) : null;
  } catch {
    json = null;
  }
  const ra = Number(r.headers.get("retry-after"));
  return { status: r.status, json, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : null };
}

function describe(e: WrlError | undefined, status: number): string {
  if (!e) return `HTTP ${status}`;
  return [e.code, e.message, e.field ? `(field ${e.field})` : null, e.hint].filter(Boolean).join(": ");
}

/** Is this contact already in the WRL log? Matches call and time within a minute. */
export async function wrlFind(key: string, q: WrlContactSource, logbookId: string | null): Promise<string | null> {
  const p = new URLSearchParams({
    call: q.callsign.toUpperCase(),
    since: new Date(q.startTime - 60_000).toISOString(),
    until: new Date(q.startTime + 60_000).toISOString(),
    limit: "10",
  });
  if (logbookId) p.set("logbookId", logbookId);
  const r = await call(key, "GET", `/contacts?${p}`);
  if (r.status !== 200) throw new NetError(`WRL search: ${describe(r.json?.error, r.status)}`);
  const rows = (Array.isArray(r.json?.data) ? r.json!.data : []) as { id?: string; band?: string | number; mode?: string }[];
  const want = (q.submode || q.mode).toUpperCase();
  const hit = rows.find((x) => !x.mode || String(x.mode).toUpperCase() === want);
  return hit?.id ?? null;
}

/**
 * Send one contact. `checkFirst` is set when an earlier attempt may have landed.
 */
export async function wrlUpload(key: string, q: WrlContactSource, opts: { logbookId: string | null; checkFirst: boolean }): Promise<UploadOutcome> {
  if (!q.freqHz) return { status: "rejected", detail: "World Radio League needs the frequency, and this contact has none" };
  try {
    if (opts.checkFirst) {
      const id = await wrlFind(key, q, opts.logbookId);
      if (id) return { status: "duplicate", detail: "already in World Radio League from an earlier attempt", remoteId: id };
    }
    let withActivities = true;
    for (;;) {
      const r = await call(key, "POST", "/contacts", wrlPayload(q, opts.logbookId, withActivities));
      const err = r.json?.error;
      if (r.status === 201 || r.status === 200) {
        const id = (r.json?.data as { id?: string } | undefined)?.id;
        const warn = Array.isArray(r.json?.meta?.warnings) ? (r.json!.meta!.warnings as unknown[]).join("; ") : "";
        const note = [withActivities ? "" : "sent without park/summit references WRL did not recognise", warn].filter(Boolean).join("; ");
        return { status: "sent", remoteId: id, detail: note || undefined };
      }
      if (r.status === 401 || r.status === 403) return { status: "auth", detail: `World Radio League refused the API key: ${describe(err, r.status)}` };
      if (r.status === 404 || r.status === 409) return { status: "auth", detail: `World Radio League logbook problem: ${describe(err, r.status)}` };
      if (r.status === 422 && err?.code === "LOGBOOK_REQUIRED") return { status: "auth", detail: "World Radio League needs a logbook: choose a default under Integrations → Developer API, or set the logbook ID in Settings" };
      if (r.status === 422 && withActivities && /ACTIVITY_REFERENCE/.test(err?.code ?? "")) {
        withActivities = false;
        continue;
      }
      if (r.status === 429) return { status: "retry", detail: `rate limited${r.retryAfter ? `; retry after ${r.retryAfter}s` : ""}` };
      if (r.status === 400 || r.status === 413 || r.status === 422) return { status: "rejected", detail: describe(err, r.status) };
      if (r.status >= 500) return { status: "retry", detail: `World Radio League: ${describe(err, r.status)}` };
      return { status: "rejected", detail: describe(err, r.status) };
    }
  } catch (e) {
    return { status: "retry", detail: (e as Error).message };
  }
}

/** Key check for the settings page. */
export async function wrlStatus(key: string, logbookId: string | null): Promise<{ ok: boolean; detail: string }> {
  if (!key) return { ok: false, detail: "no World Radio League API key" };
  try {
    const me = await call(key, "GET", "/me");
    if (me.status !== 200) return { ok: false, detail: describe(me.json?.error, me.status) };
    const d = (me.json?.data ?? {}) as { environment?: string; membershipTier?: string; scopes?: string[]; defaultLogbook?: { logbookId: string | null; resolution: string | null } };
    if (!(d.scopes ?? []).some((s) => /contacts:(rw|w)/.test(s))) return { ok: false, detail: "this key cannot write contacts (needs the contacts:rw scope)" };
    const books = await call(key, "GET", "/logbooks");
    const list = (Array.isArray(books.json?.data) ? books.json!.data : []) as { id: string; name?: string; defaultCallSign?: string; isLocked?: boolean }[];
    // Always list them: the ID is what the logbook ID setting takes, and WRL does not show it.
    const all = list.length ? ` Your logbooks: ${list.map((x) => `${x.name ?? "?"} = ${x.id}${x.isLocked ? " (locked)" : ""}`).join("; ")}.` : "";
    if (logbookId) {
      const b = list.find((x) => x.id === logbookId);
      if (!b) return { ok: false, detail: `logbook ${logbookId} is not one of this account's (${list.map((x) => `${x.name ?? "?"} = ${x.id}`).join(", ") || "none"})` };
      return { ok: true, detail: `key works (${d.environment ?? "live"}, ${d.membershipTier ?? "?"}); contacts go to "${b.name ?? b.id}".${all}` };
    }
    const res = d.defaultLogbook?.resolution;
    if (res === "configured" || res === "sole") {
      const b = list.find((x) => x.id === d.defaultLogbook?.logbookId);
      return { ok: true, detail: `key works (${d.environment ?? "live"}, ${d.membershipTier ?? "?"}); contacts go to your default logbook "${b?.name ?? d.defaultLogbook?.logbookId}".${all}` };
    }
    if (res === "none") return { ok: false, detail: "the account has no logbook yet; create one in World Radio League first" };
    return { ok: false, detail: `several logbooks and no default; put one of their IDs in Settings → Logbook services → World Radio League logbook ID.${all}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

export interface WrlLogbook {
  id: string;
  name: string;
  locked: boolean;
  callsign: string | null;
}

/** The account's logbooks and which one is the default, for the settings page's picker. */
export async function wrlLogbooks(key: string): Promise<{ ok: true; logbooks: WrlLogbook[]; defaultId: string | null } | { ok: false; error: string }> {
  try {
    const me = await call(key, "GET", "/me");
    if (me.status === 401 || me.status === 403) return { ok: false, error: "World Radio League refused this key" };
    if (me.status !== 200) return { ok: false, error: describe(me.json?.error, me.status) };
    const d = (me.json?.data ?? {}) as { defaultLogbook?: { logbookId: string | null } };
    const books = await call(key, "GET", "/logbooks");
    if (books.status !== 200) return { ok: false, error: describe(books.json?.error, books.status) };
    const list = (Array.isArray(books.json?.data) ? books.json!.data : []) as { id: string; name?: string; isLocked?: boolean; defaultCallSign?: string | null }[];
    return {
      ok: true,
      defaultId: d.defaultLogbook?.logbookId ?? null,
      logbooks: list.map((b) => ({ id: b.id, name: b.name || b.id, locked: !!b.isLocked, callsign: b.defaultCallSign ?? null })),
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
