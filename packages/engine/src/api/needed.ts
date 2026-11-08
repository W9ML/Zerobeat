/**
 * What a station's log still needs from a list of spotted calls, for the wall's needed tags
 * (GET /needed). Scored the same way as decodes and spots, with no grid and no SNR bonus.
 */
import type { Db } from "@zerobeat/core/db/client";
import { normaliseBand } from "@zerobeat/core/ham/bands";
import { looksLikeCallsign, normaliseCallsign } from "@zerobeat/core/ham/callsign";

import { LogQueries, score, type NewKind } from "../operate/worked.ts";

export const MAX_NEEDED_PAIRS = 50;

export interface CallBand {
  call: string;
  band: string;
}

export interface Needed {
  call: string;
  band: string;
  kinds: NewKind[];
  points: number;
  dxcc: number | null;
}

/** `K1ABC:20M,JA1XYZ:17m` → normalised pairs without repeats, or the reason it is refused. */
export function parseCallBands(raw: string | null | undefined): CallBand[] | string {
  if (!raw?.trim()) return "calls is required: CALL:BAND,CALL:BAND";
  if (raw.length > 2_000) return "calls is too long";
  const parts = raw.split(",");
  if (parts.length > MAX_NEEDED_PAIRS) return `at most ${MAX_NEEDED_PAIRS} calls per request`;
  const out: CallBand[] = [];
  const seen = new Set<string>();
  for (const [i, part] of parts.entries()) {
    const m = part.trim().match(/^([^:]+):([^:]+)$/);
    const call = m ? normaliseCallsign(m[1]!) : "";
    const band = m ? normaliseBand(m[2]) : null;
    if (!band || !looksLikeCallsign(call)) return `pair ${i + 1} is not CALL:BAND (e.g. K1ABC:20M)`;
    if (seen.has(`${call}|${band}`)) continue;
    seen.add(`${call}|${band}`);
    out.push({ call, band });
  }
  return out;
}

export function isStationId(s: string | null | undefined): s is string {
  return !!s && /^[A-Za-z0-9_-]{1,64}$/.test(s);
}

/** One LogQueries per station, so each log keeps its minute-long worked cache between requests. */
export class NeededLogs {
  private logs = new Map<string, LogQueries>();

  constructor(
    private readonly db: Db,
    private readonly max = 8,
  ) {}

  invalidate(): void {
    for (const lq of this.logs.values()) lq.invalidate();
  }

  private log(stationId: string): LogQueries {
    let lq = this.logs.get(stationId);
    if (!lq) {
      if (this.logs.size >= this.max) this.logs.delete(this.logs.keys().next().value!);
      lq = new LogQueries(this.db);
      lq.station = () => stationId;
      this.logs.set(stationId, lq);
    }
    return lq;
  }

  needed(stationId: string, pairs: CallBand[], now = Date.now()): { needed: Needed[]; at: number } {
    const lq = this.log(stationId);
    return {
      needed: pairs.map(({ call, band }) => {
        // SNR -24 adds nothing: the points are the log's, not the signal's.
        const s = score({ callsign: call, grid: null, snr: -24, park: null, potaCq: false }, lq.worked(band, now));
        return { call, band, kinds: s.kinds, points: s.points, dxcc: s.dxcc };
      }),
      at: now,
    };
  }
}
