/**
 * ADIF 3.1 reader and writer.
 *
 * Reading is byte-accurate: field lengths in ADIF count bytes, so tags are found in a
 * latin1 view of the buffer and values are sliced from the bytes and decoded as UTF-8.
 * Nothing is rejected for an unfamiliar mode, and every field without a column is kept
 * in `extras` so an import followed by an export loses nothing.
 */
import { bandForHz, bandMatchesFreq, normaliseBand, bandByName } from "../ham/bands.ts";
import { isGrid } from "../ham/grid.ts";
import { normaliseCallsign, looksLikeCallsign } from "../ham/callsign.ts";
import { toAdifMode } from "../ham/modes.ts";
import { adifDate, adifTime, parseAdifDateTime } from "../util/time.ts";
import type { NewQso, Qso, QslRoute, QslStatus, Station } from "../db/schema.ts";

export const ADIF_VERSION = "3.1.5";
export type AdifFields = Record<string, string>;

export interface AdifDocument {
  header: AdifFields;
  records: AdifFields[];
}

export function parseAdif(input: string | Buffer): AdifDocument {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  const scan = buf.toString("latin1");
  const header: AdifFields = {};
  const records: AdifFields[] = [];

  const eoh = scan.search(/<EOH>/i);
  const firstEor = scan.search(/<EOR>/i);
  const hasHeader = eoh !== -1 && (firstEor === -1 || eoh < firstEor);

  let current: AdifFields = hasHeader ? header : {};
  let inHeader = hasHeader;
  let any = false;
  let i = 0;

  while (i < scan.length) {
    const lt = scan.indexOf("<", i);
    if (lt === -1) break;
    const gt = scan.indexOf(">", lt + 1);
    if (gt === -1) break;
    const spec = scan.slice(lt + 1, gt);
    const upper = spec.trim().toUpperCase();

    if (upper === "EOH") {
      inHeader = false;
      current = {};
      any = false;
      i = gt + 1;
      continue;
    }
    if (upper === "EOR") {
      if (!inHeader && any) records.push(current);
      current = {};
      any = false;
      i = gt + 1;
      continue;
    }
    const bits = spec.split(":");
    const name = (bits[0] ?? "").trim().toUpperCase();
    const length = Number(bits[1]);
    if (!name || !Number.isInteger(length) || length < 0) {
      i = gt + 1;
      continue;
    }
    current[name] = buf.subarray(gt + 1, gt + 1 + length).toString("utf8");
    any = true;
    i = gt + 1 + length;
  }
  if (!inHeader && any) records.push(current);
  return { header, records };
}

// ---------------------------------------------------------------------------
// Record → contact
// ---------------------------------------------------------------------------

/** Fields mapped to columns; everything else goes to `extras`. */
const MAPPED = new Set([
  "CALL", "QSO_DATE", "TIME_ON", "QSO_DATE_OFF", "TIME_OFF", "BAND", "FREQ", "MODE", "SUBMODE",
  "RST_SENT", "RST_RCVD", "TX_PWR", "GRIDSQUARE", "NAME", "QTH", "DXCC", "STATE", "CNTY", "CQZ",
  "ITUZ", "IOTA", "CONT", "SIG", "SIG_INFO", "POTA_REF", "MY_SIG", "MY_SIG_INFO", "MY_POTA_REF",
  "MY_GRIDSQUARE", "MY_RIG", "PROP_MODE", "SAT_NAME", "EMAIL", "COMMENT", "NOTES",
  "QSL_SENT", "QSL_RCVD", "QSLSDATE", "QSLRDATE", "QSL_SENT_VIA", "QSL_RCVD_VIA",
  "LOTW_QSL_RCVD", "LOTW_QSLRDATE", "EQSL_QSL_RCVD", "STATION_CALLSIGN",
  "APP_ZEROBEAT_SIGREFS", "APP_ZEROBEAT_TRANSCRIPT", "APP_QRZLOG_STATUS", "APP_QRZLOG_LOGID",
]);
// Not in MAPPED, so kept in extras and exported again: OPERATOR, OWNER_CALLSIGN,
// LOTW_QSL_SENT, EQSL_QSL_SENT and the services' upload statuses. A log from N1MM or
// Log4OM keeps who operated and what was already uploaded.

/** QSL letters our status columns can't hold exactly, kept so they export unchanged. */
const RAW_QSL = "_QSL_RAW";

const QSL_STATUS_IN: Record<string, QslStatus> = { Y: "CONFIRMED", V: "CONFIRMED", R: "REQUESTED", Q: "REQUESTED", I: "NONE", N: "NONE" };
const QSL_SENT_IN: Record<string, QslStatus> = { Y: "SENT", R: "REQUESTED", Q: "REQUESTED", I: "NONE", N: "NONE" };
const ROUTE_IN: Record<string, QslRoute> = { B: "BUREAU", D: "DIRECT", E: "ELECTRONIC", M: "MANAGER" };

export interface ImportedContact {
  qso: Omit<NewQso, "id" | "stationId">;
  sigRefs: { sig: string; ref: string }[];
  stationCallsign: string | null;
  warnings: string[];
}

export type ImportResult = { ok: true; value: ImportedContact } | { ok: false; error: string };

function trimOrNull(s: string | undefined): string | null {
  const t = (s ?? "").trim();
  return t ? t : null;
}

function intIn(s: string | undefined, min: number, max: number): number | null {
  const t = (s ?? "").trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function adifDateOnly(s: string | undefined): number | null {
  return parseAdifDateTime(trimOrNull(s) ?? undefined, "0000");
}

export function recordToContact(f: AdifFields): ImportResult {
  const warnings: string[] = [];
  const call = normaliseCallsign(f.CALL ?? "");
  if (!call) return { ok: false, error: "no CALL" };
  if (!looksLikeCallsign(call)) warnings.push(`unusual callsign ${call}`);

  const start = parseAdifDateTime(f.QSO_DATE, f.TIME_ON);
  if (start === null) return { ok: false, error: `${call}: bad QSO_DATE/TIME_ON` };
  let end: number | null = null;
  if (f.TIME_OFF) {
    end = parseAdifDateTime(f.QSO_DATE_OFF ?? f.QSO_DATE, f.TIME_OFF);
    if (end !== null && end < start) {
      // A contact that crosses midnight without QSO_DATE_OFF.
      end = f.QSO_DATE_OFF ? null : end + 86_400_000;
    }
  }

  // Band and frequency: FREQ wins when it lands in a band; otherwise BAND; frequency then
  // defaults to the band's lower edge so the column is never null.
  const freqMHz = Number((f.FREQ ?? "").trim());
  const freqHz = Number.isFinite(freqMHz) && freqMHz > 0 ? Math.round(freqMHz * 1_000_000) : null;
  const bandFromFreq = freqHz ? bandForHz(freqHz)?.name ?? null : null;
  const bandField = normaliseBand(f.BAND);
  let band: string | null = bandFromFreq ?? bandField;
  if (bandFromFreq && bandField && bandFromFreq !== bandField) warnings.push(`${call}: BAND ${bandField} disagrees with FREQ; using ${bandFromFreq}`);
  if (!band) return { ok: false, error: `${call}: no usable BAND or FREQ` };
  const hz = freqHz && bandMatchesFreq(band, freqHz) ? freqHz : bandByName(band)!.lowHz;

  if (!f.MODE?.trim()) return { ok: false, error: `${call}: no MODE` };
  const { mode, submode } = toAdifMode(f.MODE, f.SUBMODE);

  const grid = trimOrNull(f.GRIDSQUARE);
  const myGrid = trimOrNull(f.MY_GRIDSQUARE);

  // Special activities. SIG_INFO is the primary; APP_ZEROBEAT_SIGREFS carries n-fers.
  const sig = trimOrNull(f.SIG)?.toUpperCase() ?? (f.POTA_REF ? "POTA" : null);
  const sigRefs: { sig: string; ref: string }[] = [];
  const refs = new Set<string>();
  for (const src of [f.SIG_INFO, f.POTA_REF, f.APP_ZEROBEAT_SIGREFS]) {
    for (const r of (src ?? "").split(/[,\s]+/)) {
      const ref = r.trim().toUpperCase().replace(/@.*$/, "");
      if (ref) refs.add(ref);
    }
  }
  if (sig) for (const ref of refs) sigRefs.push({ sig, ref });
  const mySig = trimOrNull(f.MY_SIG)?.toUpperCase() ?? (f.MY_POTA_REF ? "POTA" : null);
  // An activator's n-fer is a comma list (POTA accepts it that way); keep every park.
  const mySigInfo = trimOrNull(f.MY_SIG_INFO ?? f.MY_POTA_REF)?.toUpperCase().split(/[,\s]+/).filter(Boolean).join(",") || null;

  const txPwr = Number(f.TX_PWR);

  const extras: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (!MAPPED.has(k) && v !== "") extras[k] = v;
  // NOTES is the multi-line field, COMMENT the one-line one. With both, NOTES is the
  // notes and COMMENT is kept as it was (it used to be dropped).
  if (f.NOTES && f.COMMENT) extras.COMMENT = f.COMMENT;
  else delete extras.COMMENT;
  delete extras.NOTES;
  // Q (queued), I (ignore) and V (verified) have no status of their own here: remember
  // the letter so export writes it back instead of R, N or Y.
  const raw: Record<string, string> = {};
  for (const k of ["QSL_SENT", "QSL_RCVD"] as const) {
    const v = (f[k] ?? "").trim().toUpperCase();
    if (v === "Q" || v === "I" || v === "V") raw[k] = v;
  }
  if (Object.keys(raw).length) extras[RAW_QSL] = JSON.stringify(raw);

  const cnty = trimOrNull(f.CNTY);
  const state = trimOrNull(f.STATE)?.toUpperCase() ?? null;

  const qso: ImportedContact["qso"] = {
    callsign: call,
    band,
    freqHz: hz,
    mode,
    submode,
    startTime: start,
    endTime: end,
    rstSent: trimOrNull(f.RST_SENT),
    rstRcvd: trimOrNull(f.RST_RCVD),
    txPowerW: Number.isFinite(txPwr) && txPwr > 0 && txPwr <= 2000 ? Math.round(txPwr) : null,
    grid: grid && isGrid(grid) ? grid.slice(0, 2).toUpperCase() + grid.slice(2) : null,
    name: trimOrNull(f.NAME),
    qth: trimOrNull(f.QTH),
    dxcc: intIn(f.DXCC, 1, 999),
    state,
    // ADIF CNTY is "ST,County"; keep the county part.
    county: cnty ? cnty.replace(/^[A-Z]{2},\s*/i, "") : null,
    cqZone: intIn(f.CQZ, 1, 40),
    ituZone: intIn(f.ITUZ, 1, 90),
    iota: trimOrNull(f.IOTA)?.toUpperCase() ?? null,
    continent: trimOrNull(f.CONT)?.toUpperCase() ?? null,
    sig: sigRefs.length ? sig : null,
    sigInfo: sigRefs[0]?.ref ?? null,
    mySig: mySigInfo ? mySig : null,
    mySigInfo,
    myGrid: myGrid && isGrid(myGrid) ? myGrid : null,
    radio: trimOrNull(f.MY_RIG),
    propMode: trimOrNull(f.PROP_MODE)?.toUpperCase() ?? null,
    satName: trimOrNull(f.SAT_NAME)?.toUpperCase() ?? null,
    email: trimOrNull(f.EMAIL),
    notes: trimOrNull(f.NOTES ?? f.COMMENT),
    transcript: trimOrNull(f.APP_ZEROBEAT_TRANSCRIPT),
    qslSent: QSL_SENT_IN[(f.QSL_SENT ?? "").trim().toUpperCase()] ?? "NONE",
    qslRcvd: QSL_STATUS_IN[(f.QSL_RCVD ?? "").trim().toUpperCase()] ?? "NONE",
    qslSentAt: adifDateOnly(f.QSLSDATE),
    qslRcvdAt: adifDateOnly(f.QSLRDATE),
    qslSentVia: ROUTE_IN[(f.QSL_SENT_VIA ?? "").trim().toUpperCase()] ?? null,
    qslRcvdVia: ROUTE_IN[(f.QSL_RCVD_VIA ?? "").trim().toUpperCase()] ?? null,
    lotwRcvd: /^[YV]$/i.test((f.LOTW_QSL_RCVD ?? "").trim()),
    lotwRcvdAt: adifDateOnly(f.LOTW_QSLRDATE),
    eqslRcvd: /^[YV]$/i.test((f.EQSL_QSL_RCVD ?? "").trim()),
    qrzRcvd: (f.APP_QRZLOG_STATUS ?? "").trim().toUpperCase() === "C",
    qrzLogId: intIn(f.APP_QRZLOG_LOGID, 1, 2 ** 31 - 1),
    extras: Object.keys(extras).length ? JSON.stringify(extras) : null,
  };
  return {
    ok: true,
    value: { qso, sigRefs, stationCallsign: trimOrNull(f.STATION_CALLSIGN)?.toUpperCase() ?? null, warnings },
  };
}

/** Same contact, for de-duplication: call, band, mode family, start to the minute. */
export function dupeKey(q: { callsign: string; band: string; mode: string; submode?: string | null; startTime: number }, minuteOffset = 0): string {
  const minute = Math.floor(q.startTime / 60_000) + minuteOffset;
  // The mode family: SSB and SSB/USB are one mode; within MFSK and PSK the submode is the
  // mode (FT4 is not JS8).
  const m = q.mode.toUpperCase();
  const family = (m === "MFSK" || m === "PSK") && q.submode ? q.submode.toUpperCase() : m;
  return `${q.callsign.toUpperCase()}|${q.band}|${family}|${minute}`;
}

// ---------------------------------------------------------------------------
// Contact → ADIF
// ---------------------------------------------------------------------------

export function adifField(name: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (!s) return "";
  return `<${name}:${Buffer.byteLength(s, "utf8")}>${s}`;
}

export function adifHeader(programVersion: string, now = Date.now(), comment = "Zerobeat ADIF export"): string {
  return [
    comment,
    adifField("ADIF_VER", ADIF_VERSION),
    adifField("PROGRAMID", "Zerobeat"),
    adifField("PROGRAMVERSION", programVersion),
    adifField("CREATED_TIMESTAMP", `${adifDate(now)} ${adifTime(now)}`),
    "<EOH>",
    "",
  ].join("\n");
}

const QSL_STATUS_OUT: Record<QslStatus, string> = { NONE: "N", REQUESTED: "R", SENT: "Y", CONFIRMED: "Y" };
const ROUTE_OUT: Record<QslRoute, string> = { BUREAU: "B", DIRECT: "D", ELECTRONIC: "E", MANAGER: "M" };

export interface AdifExportOptions {
  /** Include confirmation flags and APP fields (full backup) vs. a minimal upload record. */
  full?: boolean;
  /** The operator's callsign (from operatorId), written as OPERATOR unless an import kept one. */
  operator?: string | null;
  /** Extra fields to append (service-specific). */
  extra?: Record<string, string | number | null | undefined>;
}

export function qsoToAdif(
  q: Qso,
  station: Pick<Station, "callsign" | "grid">,
  sigRefs: { sig: string; ref: string }[] = [],
  opts: AdifExportOptions = {},
): string {
  const out: string[] = [];
  const add = (k: string, v: string | number | null | undefined) => {
    const s = adifField(k, v);
    if (s) out.push(s);
  };
  add("CALL", q.callsign);
  add("QSO_DATE", adifDate(q.startTime));
  add("TIME_ON", adifTime(q.startTime));
  if (q.endTime) {
    if (adifDate(q.endTime) !== adifDate(q.startTime)) add("QSO_DATE_OFF", adifDate(q.endTime));
    add("TIME_OFF", adifTime(q.endTime));
  }
  add("BAND", q.band);
  add("FREQ", (q.freqHz / 1_000_000).toFixed(6));
  add("MODE", q.mode);
  add("SUBMODE", q.submode);
  add("RST_SENT", q.rstSent);
  add("RST_RCVD", q.rstRcvd);
  add("TX_PWR", q.txPowerW);
  add("GRIDSQUARE", q.grid);
  add("NAME", q.name);
  add("QTH", q.qth);
  add("DXCC", q.dxcc);
  add("STATE", q.state);
  add("CNTY", q.county ? (q.state && q.dxcc === 291 ? `${q.state},${q.county}` : q.county) : null);
  add("CQZ", q.cqZone);
  add("ITUZ", q.ituZone);
  add("IOTA", q.iota);
  add("CONT", q.continent);
  add("SIG", q.sig);
  add("SIG_INFO", q.sigInfo);
  if (q.sig === "POTA" && sigRefs.length) add("POTA_REF", sigRefs.filter((r) => r.sig === "POTA").map((r) => r.ref).join(","));
  add("MY_SIG", q.mySig);
  add("MY_SIG_INFO", q.mySigInfo);
  if (q.mySig === "POTA") add("MY_POTA_REF", q.mySigInfo);
  add("PROP_MODE", q.propMode);
  add("SAT_NAME", q.satName);
  add("STATION_CALLSIGN", station.callsign);
  if (opts.operator && !(opts.full && q.extras && /"OPERATOR"/.test(q.extras))) add("OPERATOR", opts.operator);
  add("MY_GRIDSQUARE", q.myGrid ?? station.grid);
  add("MY_RIG", q.radio);
  if (opts.full) {
    add("EMAIL", q.email);
    let ex: Record<string, string> = {};
    try {
      ex = q.extras ? (JSON.parse(q.extras) as Record<string, string>) : {};
    } catch {
      ex = {};
    }
    let raw: Record<string, string> = {};
    try {
      raw = ex[RAW_QSL] ? (JSON.parse(ex[RAW_QSL]) as Record<string, string>) : {};
    } catch {
      raw = {};
    }
    add("COMMENT", ex.COMMENT ?? q.notes?.replace(/\r?\n/g, " "));
    if (q.notes && (ex.COMMENT || /\n/.test(q.notes))) add("NOTES", q.notes);
    const sentOut = QSL_STATUS_OUT[q.qslSent];
    const rcvdOut = q.qslRcvd === "CONFIRMED" ? "Y" : QSL_STATUS_OUT[q.qslRcvd];
    // The original letter, while the status it was read as is unchanged.
    const keep = (k: "QSL_SENT" | "QSL_RCVD", out: string | undefined) => {
      const r = raw[k];
      if (r === "Q" && out === "R") return "Q";
      if (r === "I" && out === "N") return "I";
      if (r === "V" && out === "Y") return "V";
      return out;
    };
    add("QSL_SENT", keep("QSL_SENT", sentOut));
    add("QSL_RCVD", keep("QSL_RCVD", rcvdOut));
    if (q.qrzRcvd) add("APP_QRZLOG_STATUS", "C");
    if (q.qslSentAt) add("QSLSDATE", adifDate(q.qslSentAt));
    if (q.qslRcvdAt) add("QSLRDATE", adifDate(q.qslRcvdAt));
    if (q.qslSentVia) add("QSL_SENT_VIA", ROUTE_OUT[q.qslSentVia]);
    if (q.qslRcvdVia) add("QSL_RCVD_VIA", ROUTE_OUT[q.qslRcvdVia]);
    if (q.lotwRcvd) add("LOTW_QSL_RCVD", "Y");
    if (q.lotwRcvdAt) add("LOTW_QSLRDATE", adifDate(q.lotwRcvdAt));
    if (q.eqslRcvd) add("EQSL_QSL_RCVD", "Y");
    if (sigRefs.length > 1) add("APP_ZEROBEAT_SIGREFS", sigRefs.map((r) => r.ref).join(","));
    if (q.transcript) add("APP_ZEROBEAT_TRANSCRIPT", q.transcript);
    if (q.extras) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(q.extras) as Record<string, string>)) if (k !== RAW_QSL && k !== "COMMENT") add(k, v);
      } catch {
        /* ignore a corrupt extras blob */
      }
    }
  }
  for (const [k, v] of Object.entries(opts.extra ?? {})) add(k, v);
  return out.join(" ") + " <EOR>\n";
}
