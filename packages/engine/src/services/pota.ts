/** POTA activator spots (api.pota.app, public). Fetched at most once a minute. */
import { httpRequest } from "@zerobeat/core/integrations/http";

export interface PotaSpot {
  activator: string;
  freqHz: number;
  mode: string;
  reference: string;
  name: string;
  location: string;
  spotTime: number;
}

let cache: { at: number; spots: PotaSpot[] } | null = null;
let inflight: Promise<PotaSpot[]> | null = null;

export async function potaSpots(now = Date.now()): Promise<PotaSpot[]> {
  if (cache && now - cache.at < 60_000) return cache.spots;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await httpRequest("https://api.pota.app/spot/activator", { timeoutMs: 15_000 });
      if (r.status !== 200) return cache?.spots ?? [];
      const raw = JSON.parse(r.text) as Record<string, unknown>[];
      const spots: PotaSpot[] = [];
      for (const s of raw) {
        const khz = Number(s.frequency);
        if (!Number.isFinite(khz) || khz < 1800 || khz > 1_300_000 || s.invalid) continue;
        spots.push({
          activator: String(s.activator ?? "").toUpperCase(),
          freqHz: Math.round(khz * 1000),
          mode: String(s.mode ?? "").toUpperCase(),
          reference: String(s.reference ?? "").toUpperCase(),
          name: String(s.name ?? ""),
          location: String(s.locationDesc ?? ""),
          spotTime: Date.parse(String(s.spotTime ?? "") + "Z") || now,
        });
      }
      cache = { at: now, spots };
      return spots;
    } catch {
      return cache?.spots ?? [];
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** The park an activator is spotted at on this band, if any. */
export function parkFor(spots: PotaSpot[], call: string, bandOf: (hz: number) => string | null, band: string): string | null {
  const base = call.toUpperCase();
  const hit = spots.find((s) => (s.activator === base || s.activator.split("/").includes(base)) && bandOf(s.freqHz) === band);
  return hit?.reference ?? null;
}

/** Cached spots without waiting; refreshes in the background when stale. */
export function potaSpotsCached(now = Date.now()): PotaSpot[] {
  if (!cache || now - cache.at >= 60_000) void potaSpots(now);
  return cache?.spots ?? [];
}
