/**
 * Everything the entry form and the Operate station card want to know about a callsign,
 * in one call: DXCC, the callbook record, the log's history with them, and the path
 * from our station (?grid= gives their grid as just decoded, ahead of the callbook's).
 */
import { getDxcc } from "@zerobeat/core/dxcc/cty";
import { looksLikeCallsign, normaliseCallsign } from "@zerobeat/core/ham/callsign";
import { bearingDeg, distanceKm, gridToLatLon, isGrid } from "@zerobeat/core/ham/grid";
import { workedBefore } from "@zerobeat/core/log/qsos";

import { authorize, json, problem } from "@/lib/server/auth";
import { requestScope } from "@/lib/server/scope";
import { db } from "@/lib/server/ctx";
import { lookupCall } from "@/lib/server/lookup";

export async function GET(req: Request, ctx: { params: Promise<{ call: string }> }) {
  const who = authorize(req, "VIEWER");
  if (who instanceof Response) return who;
  const call = normaliseCallsign(decodeURIComponent((await ctx.params).call));
  if (!looksLikeCallsign(call)) return problem(400, "not a callsign");
  const u = new URL(req.url);
  const dx = getDxcc().resolve(call);
  const info = await lookupCall(call, who.kind === "user" ? who.id : null);
  // A viewer sees that the callbook has an address, not the address.
  const shown = info && who.kind === "user" && who.role === "VIEWER" ? { ...info, email: null } : info;

  // From the viewer's station, and their logbook for "worked before".
  const scope = requestScope(req, who);
  const st = scope.grid ? { grid: scope.grid } : null;
  const asked = u.searchParams.get("grid");
  const theirGrid = isGrid(asked) ? asked : isGrid(info?.grid) ? info!.grid : null;
  const a = st && isGrid(st.grid) ? gridToLatLon(st.grid) : null;
  const b = theirGrid ? gridToLatLon(theirGrid) : null;
  const path =
    a && b
      ? (() => {
          const km = distanceKm(a, b);
          const sp = bearingDeg(a, b);
          return {
            from: st!.grid,
            to: theirGrid,
            km: Math.round(km),
            bearing: Math.round(sp),
            longKm: Math.round(40_030 - km),
            longBearing: Math.round((sp + 180) % 360),
          };
        })()
      : null;

  return json({
    callsign: call,
    dxcc: dx ? { adif: dx.adif, name: dx.name, continent: dx.continent, cqZone: dx.cqZone, ituZone: dx.ituZone } : null,
    info: shown ? { ...shown, imageUrl: null, photo: !!info?.imageUrl } : null,
    worked: workedBefore(db(), scope.stationId, call, u.searchParams.get("band") ?? undefined, u.searchParams.get("mode") ?? undefined),
    path,
  });
}
