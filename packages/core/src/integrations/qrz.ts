/**
 * QRZ: XML callsign lookup (subscription) and the Logbook API.
 *
 * Lookup: GET xmldata.qrz.com/xml/current/?username;password;agent → <Key>, then
 * ?s=<key>;callsign=<call>. The session key is cached and renewed on a session error.
 * HamDB is the free fallback when no QRZ login is configured.
 *
 * Logbook: POST logbook.qrz.com/api, urlencoded KEY/ACTION/ADIF. Replies are
 * `&`-separated pairs; the ADIF tail of a FETCH reply is taken verbatim.
 */
import { httpRequest, NetError, type UploadOutcome } from "./http.ts";

export interface CallsignInfo {
  callsign: string;
  name: string | null;
  qth: string | null;
  state: string | null;
  county: string | null;
  country: string | null;
  grid: string | null;
  email: string | null;
  dxcc: number | null;
  cqZone: number | null;
  ituZone: number | null;
  lotw: boolean | null;
  eqsl: boolean | null;
  qslManager: string | null;
  imageUrl: string | null;
  source: "qrz" | "hamdb";
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  if (!m) return null;
  const v = m[1]!
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
  return v || null;
}

const XML = "https://xmldata.qrz.com/xml/current/";

export class QrzLookup {
  private key: { value: string; at: number } | null = null;

  constructor(
    private readonly username: string,
    private readonly password: string,
  ) {}

  private async session(force = false): Promise<string> {
    if (!force && this.key && Date.now() - this.key.at < 20 * 3_600_000) return this.key.value;
    const url = `${XML}?username=${encodeURIComponent(this.username)};password=${encodeURIComponent(this.password)};agent=Zerobeat`;
    const r = await httpRequest(url, { timeoutMs: 15_000 });
    const key = tag(r.text, "Key");
    if (!key) throw new NetError(`QRZ login failed: ${tag(r.text, "Error") ?? `HTTP ${r.status}`}`, false);
    this.key = { value: key, at: Date.now() };
    return key;
  }

  async lookup(callsign: string): Promise<CallsignInfo | null> {
    for (const retry of [false, true]) {
      const key = await this.session(retry);
      const r = await httpRequest(`${XML}?s=${key};callsign=${encodeURIComponent(callsign)}`, { timeoutMs: 15_000 });
      const err = tag(r.text, "Error");
      if (err && /session/i.test(err) && !retry) continue;
      if (err && /not found/i.test(err)) return null;
      if (err) throw new NetError(`QRZ: ${err}`, !/subscription/i.test(err));
      const fname = tag(r.text, "fname");
      const lname = tag(r.text, "name");
      const num = (s: string | null) => (s && /^\d+$/.test(s) ? Number(s) : null);
      return {
        callsign: (tag(r.text, "call") ?? callsign).toUpperCase(),
        name: [fname, lname].filter(Boolean).join(" ") || null,
        qth: [tag(r.text, "addr2"), tag(r.text, "state")].filter(Boolean).join(", ") || null,
        state: tag(r.text, "state"),
        county: tag(r.text, "county"),
        country: tag(r.text, "country"),
        grid: tag(r.text, "grid"),
        email: tag(r.text, "email"),
        dxcc: num(tag(r.text, "dxcc")),
        cqZone: num(tag(r.text, "cqzone")),
        ituZone: num(tag(r.text, "ituzone")),
        lotw: tag(r.text, "lotw") === null ? null : tag(r.text, "lotw") === "1",
        eqsl: tag(r.text, "eqsl") === null ? null : tag(r.text, "eqsl") === "1",
        qslManager: tag(r.text, "qslmgr"),
        imageUrl: tag(r.text, "image"),
        source: "qrz",
      };
    }
    return null;
  }
}

export async function hamdbLookup(callsign: string): Promise<CallsignInfo | null> {
  const r = await httpRequest(`https://api.hamdb.org/v1/${encodeURIComponent(callsign)}/json/zerobeat`, { timeoutMs: 10_000 });
  if (r.status !== 200) return null;
  let j: { hamdb?: { callsign?: Record<string, string>; messages?: { status?: string } } };
  try {
    j = JSON.parse(r.text);
  } catch {
    return null;
  }
  const c = j.hamdb?.callsign;
  if (!c || j.hamdb?.messages?.status !== "OK" || (c.call ?? "").toUpperCase() !== callsign.toUpperCase()) return null;
  const v = (s: string | undefined) => (s && s !== "NOT_FOUND" ? s.trim() || null : null);
  return {
    callsign: callsign.toUpperCase(),
    name: [v(c.fname), v(c.name)].filter(Boolean).join(" ") || null,
    qth: [v(c.addr2), v(c.state)].filter(Boolean).join(", ") || null,
    state: v(c.state),
    county: null,
    country: v(c.country),
    grid: v(c.grid),
    email: null,
    dxcc: null,
    cqZone: null,
    ituZone: null,
    lotw: null,
    eqsl: null,
    qslManager: null,
    imageUrl: null,
    source: "hamdb",
  };
}

// ---------------------------------------------------------------------------
// Logbook API
// ---------------------------------------------------------------------------

const LOGBOOK = "https://logbook.qrz.com/api";

export function parseQrzReply(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const adifAt = text.indexOf("ADIF=");
  const head = adifAt === -1 ? text : text.slice(0, adifAt);
  for (const pair of head.split("&")) {
    const eq = pair.indexOf("=");
    if (eq > 0) out[pair.slice(0, eq).trim().toUpperCase()] = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " ")).trim();
  }
  if (adifAt !== -1) {
    out.ADIF = text
      .slice(adifAt + 5)
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }
  return out;
}

async function logbook(key: string, params: Record<string, string>): Promise<Record<string, string>> {
  const body = new URLSearchParams({ KEY: key, ...params });
  const r = await httpRequest(LOGBOOK, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" }, timeoutMs: 30_000 });
  if (r.status >= 500) throw new NetError(`QRZ Logbook HTTP ${r.status}`);
  return parseQrzReply(r.text);
}

export async function qrzInsert(key: string, adifRecord: string): Promise<UploadOutcome> {
  let reply: Record<string, string>;
  try {
    reply = await logbook(key, { ACTION: "INSERT", ADIF: adifRecord.trim() });
  } catch (e) {
    return { status: "retry", detail: (e as Error).message };
  }
  const result = (reply.RESULT ?? "").toUpperCase();
  if (result === "OK" || result === "REPLACE") return { status: "sent", remoteId: reply.LOGID };
  if (result === "AUTH") return { status: "auth", detail: `QRZ Logbook refused the API key: ${reply.REASON ?? "check it"}` };
  const reason = reply.REASON ?? "no reason given";
  if (/duplicate/i.test(reason)) return { status: "duplicate", detail: reason };
  if (/invalid api key|not authorized|key/i.test(reason) && /key/i.test(reason)) return { status: "auth", detail: reason };
  return { status: "rejected", detail: reason };
}

export async function qrzStatus(key: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await logbook(key, { ACTION: "STATUS" });
    if ((r.RESULT ?? "").toUpperCase() === "OK") return { ok: true, detail: `Logbook ${r.BOOK_NAME ?? r.CALLSIGN ?? ""} has ${r.COUNT ?? "?"} contacts` };
    return { ok: false, detail: r.REASON ?? r.RESULT ?? "unknown reply" };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

/**
 * Records after a log id, for confirmations; with modSince (yyyy-mm-dd), only records
 * modified on or after that date. Paging is by log id within that set.
 */
export async function qrzFetchAfter(key: string, afterLogId: number, max = 250, modSince?: string): Promise<{ adif: string; count: number }> {
  const opt = [modSince ? `MODSINCE:${modSince}` : null, `AFTERLOGID:${afterLogId}`, `MAX:${max}`].filter(Boolean).join(",");
  const r = await logbook(key, { ACTION: "FETCH", OPTION: opt });
  const result = (r.RESULT ?? "").toUpperCase();
  if (result === "AUTH") throw new NetError("QRZ Logbook refused the API key", false);
  if (result !== "OK") {
    if (/no log entries/i.test(r.REASON ?? "")) return { adif: "", count: 0 };
    throw new NetError(`QRZ Logbook: ${r.REASON ?? result}`);
  }
  return { adif: r.ADIF ?? "", count: Number(r.COUNT ?? 0) };
}
