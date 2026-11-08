/** GET ?to=GRID[&call=THEIRS][&from=GRID]: a map of the path from our station, as SVG. */
import { looksLikeCallsign, normaliseCallsign } from "@zerobeat/core/ham/callsign";
import { gridToLatLon, isGrid } from "@zerobeat/core/ham/grid";

import { authorize, problem } from "@/lib/server/auth";
import { db } from "@/lib/server/ctx";
import { pathMapSvg } from "@/lib/server/path-map";
import { requestScope } from "@/lib/server/scope";

export async function GET(req: Request) {
  const who = authorize(req, "VIEWER");
  if (who instanceof Response) return who;
  const u = new URL(req.url);
  const sc = requestScope(req, who);
  const st = sc.grid ? { grid: sc.grid, callsign: sc.callsign ?? "" } : null;
  const to = u.searchParams.get("to");
  const from = u.searchParams.get("from") || st?.grid || null;
  if (!isGrid(to) || !isGrid(from)) return problem(400, "give ?to= (and a station grid, or ?from=) as Maidenhead locators");
  const raw = u.searchParams.get("call") ?? "";
  const call = raw && looksLikeCallsign(raw) ? normaliseCallsign(raw) : "";
  const svg = pathMapSvg({ from: gridToLatLon(from)!, to: gridToLatLon(to)!, fromLabel: st?.callsign.toUpperCase() ?? "", toLabel: call });
  // The night side moves: ten minutes at most.
  return new Response(svg, {
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "private, max-age=600", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" },
  });
}
