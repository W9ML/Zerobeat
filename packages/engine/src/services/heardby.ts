/**
 * Who heard us: PSKReporter reception reports of our own callsign.
 *
 * GET retrieve.pskreporter.info/query?senderCallsign=…&flowStartSeconds=-N&rronly=1
 * returns <receptionReport receiverCallsign= receiverLocator= frequency= flowStartSeconds=
 * mode= sNR= …/>. PSKReporter asks for no more than one query per five minutes; the
 * last query time is persisted so restarts cannot exceed that. Only asked while the
 * station has transmitted recently, since otherwise there is nothing to hear.
 */
import { sql } from "drizzle-orm";

import type { Db } from "@zerobeat/core/db/client";
import { heardReports } from "@zerobeat/core/db/schema";
import { getDxcc } from "@zerobeat/core/dxcc/cty";
import { bandName } from "@zerobeat/core/ham/bands";
import { distanceKm, gridDistanceKm, gridToLatLon } from "@zerobeat/core/ham/grid";
import { httpRequest } from "@zerobeat/core/integrations/http";
import type { EngineState } from "@zerobeat/core/state/engine-state";

const MIN_INTERVAL_MS = 5 * 60_000;

export interface Report {
  receiver: string;
  grid: string | null;
  freqHz: number;
  at: number;
  mode: string;
  snr: number | null;
}

export function parseReports(xml: string): Report[] {
  const out: Report[] = [];
  for (const m of xml.matchAll(/<receptionReport\s([^>]*?)\/?>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of m[1]!.matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]!] = a[2]!;
    const freq = Number(attrs.frequency);
    const at = Number(attrs.flowStartSeconds) * 1000;
    if (!attrs.receiverCallsign || !Number.isFinite(freq) || !Number.isFinite(at)) continue;
    out.push({
      receiver: attrs.receiverCallsign.toUpperCase(),
      grid: attrs.receiverLocator || null,
      freqHz: Math.round(freq),
      at,
      mode: (attrs.mode ?? "").toUpperCase(),
      snr: attrs.sNR !== undefined && attrs.sNR !== "" ? Number(attrs.sNR) : null,
    });
  }
  return out;
}

export async function fetchHeardBy(
  db: Db,
  state: EngineState,
  opts: { callsign: string; grid: string; contact: string; lastTxAt: number | null; force?: boolean },
): Promise<string> {
  const now = Date.now();
  if (!opts.force && (!opts.lastTxAt || now - opts.lastTxAt > 30 * 60_000)) return "not transmitting recently";
  const last = state.get("heardLastQueryAt") ?? 0;
  if (now - last < MIN_INTERVAL_MS) return "PSKReporter allows one query per 5 minutes";
  state.set("heardLastQueryAt", now);
  const lookback = Math.min(3600, Math.max(900, Math.round((now - last) / 1000) + 120));
  const params = new URLSearchParams({ senderCallsign: opts.callsign, flowStartSeconds: String(-lookback), rronly: "1" });
  if (opts.contact) params.set("appcontact", opts.contact);
  const r = await httpRequest(`https://retrieve.pskreporter.info/query?${params}`, { timeoutMs: 30_000 });
  if (r.status === 503 || /too often|slow down/i.test(r.text)) return "PSKReporter asked us to slow down";
  if (r.status !== 200) throw new Error(`PSKReporter HTTP ${r.status}`);
  const reports = parseReports(r.text);
  let added = 0;
  const dx = getDxcc();
  db.transaction((tx) => {
    for (const rep of reports) {
      const band = bandName(rep.freqHz);
      if (!band) continue;
      const ent = dx.resolve(rep.receiver);
      const km = rep.grid ? gridDistanceKm(opts.grid, rep.grid) : null;
      const res = tx
        .insert(heardReports)
        .values({
          at: rep.at,
          receiver: rep.receiver,
          grid: rep.grid,
          freqHz: rep.freqHz,
          band,
          mode: rep.mode,
          snr: rep.snr,
          distanceKm: km !== null ? Math.round(km) : null,
          dxcc: ent?.adif ?? null,
          continent: ent?.continent ?? null,
        })
        .onConflictDoNothing()
        .run();
      added += res.changes;
    }
    tx.run(sql`DELETE FROM heard_reports WHERE at < ${now - 30 * 86_400_000}`);
  });
  return `${reports.length} reports, ${added} new`;
}

export function heardSummary(db: Db, sinceMs: number) {
  const rows = db.all<{ receiver: string; grid: string | null; band: string; snr: number | null; distance_km: number | null; continent: string | null; dxcc: number | null; at: number }>(
    sql`SELECT receiver, grid, band, snr, distance_km, continent, dxcc, MAX(at) AS at FROM heard_reports WHERE at >= ${sinceMs} GROUP BY receiver, band ORDER BY at DESC`,
  );
  // The continent comes from the receiver's callsign. Beacon and listener names (AC0G/B4, SWL/FN11OD) read as
  // another country, so when the receiver's own grid square is far from that country the continent is unknown
  // rather than wrong. 6000 km leaves room for the big countries (Canada to the Yukon is about 4500).
  const dx = getDxcc();
  for (const r of rows) {
    if (!r.continent || !r.grid) continue;
    const at = gridToLatLon(r.grid), ent = dx.resolve(r.receiver);
    if (at && ent && distanceKm(at, ent) > 6000) r.continent = null;
  }
  const far = rows.reduce<(typeof rows)[number] | null>((a, b) => ((b.distance_km ?? 0) > (a?.distance_km ?? -1) ? b : a), null);
  const continents = [...new Set(rows.map((r) => r.continent).filter(Boolean))] as string[];
  // Distinct receivers overall, per band and per continent (rows are one per receiver and band).
  const tally = (key: (r: (typeof rows)[number]) => string | null) => {
    const sets = new Map<string, Set<string>>();
    for (const r of rows) {
      const k = key(r);
      if (k) (sets.get(k) ?? sets.set(k, new Set()).get(k)!).add(r.receiver);
    }
    return Object.fromEntries([...sets].map(([k, s]) => [k, s.size]));
  };
  return {
    count: rows.length,
    receivers: new Set(rows.map((r) => r.receiver)).size,
    byBand: tally((r) => r.band),
    byContinent: tally((r) => r.continent),
    farthest: far,
    continents,
    reports: rows.slice(0, 100),
  };
}
