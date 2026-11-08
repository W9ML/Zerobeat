/** Public API: which spotted calls the key's own log still needs (the wall's needed tags). */
import { normaliseBand } from "@zerobeat/core/ham/bands";
import { looksLikeCallsign, normaliseCallsign } from "@zerobeat/core/ham/callsign";

import { authorize, json, problem } from "@/lib/server/auth";
import { engine } from "@/lib/server/engine";
import { requestScope } from "@/lib/server/scope";

const MAX_PAIRS = 50;

/** Same rules as the engine's parseCallBands: up to 50 CALL:BAND pairs, band as Zerobeat names it. */
function callBands(raw: string | null): string[] | string {
  if (!raw?.trim()) return "calls is required: CALL:BAND,CALL:BAND";
  if (raw.length > 2_000) return "calls is too long";
  const parts = raw.split(",");
  if (parts.length > MAX_PAIRS) return `at most ${MAX_PAIRS} calls per request`;
  const out = new Set<string>();
  for (const [i, part] of parts.entries()) {
    const m = part.trim().match(/^([^:]+):([^:]+)$/);
    const call = m ? normaliseCallsign(m[1]!) : "";
    const band = m ? normaliseBand(m[2]) : null;
    if (!band || !looksLikeCallsign(call)) return `pair ${i + 1} is not CALL:BAND (e.g. K1ABC:20M)`;
    out.add(`${call}:${band}`);
  }
  return [...out];
}

export async function GET(req: Request) {
  const who = authorize(req, "VIEWER", { apiKey: true });
  if (who instanceof Response) return who;
  const pairs = callBands(new URL(req.url).searchParams.get("calls"));
  if (typeof pairs === "string") return problem(400, pairs);
  // The key's own log, not whoever has the radio.
  const { stationId } = requestScope(req, who);
  if (!stationId) return problem(409, "this account has no callsign yet, so there is no log to compare");
  const q = new URLSearchParams({ calls: pairs.join(","), station: stationId });
  const r = await engine("GET", `/needed?${q}`).catch(() => null);
  if (!r) return problem(503, "the engine is not running");
  return json(r.data, r.status);
}
