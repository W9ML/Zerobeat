/** Public API: who received this station on PSKReporter recently (the wall's "Who hears me" card). Read-only. */
import { authorize, json, problem } from "@/lib/server/auth";
import { engine } from "@/lib/server/engine";

interface Row {
  receiver: string;
  grid: string | null;
  band: string;
  snr: number | null;
  distance_km: number | null;
  continent: string | null;
  at: number;
}
interface Heard {
  count: number;
  receivers?: number;
  byBand?: Record<string, number>;
  byContinent?: Record<string, number>;
  farthest: Row | null;
  reports: Row[];
  lastQueryAt?: number | null;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, max: number) => (typeof v === "string" && v ? v.slice(0, max) : null);
const counts = (o: unknown) =>
  Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {}).filter(([k, v]) => k.length <= 8 && typeof v === "number").slice(0, 40));
const row = (r: Row) => ({
  receiver: str(r.receiver, 20),
  grid: str(r.grid, 10),
  band: str(r.band, 8),
  snr: num(r.snr),
  km: num(r.distance_km),
  continent: str(r.continent, 2),
  at: num(r.at),
});

/** ?minutes= 5..240 (default 30). Reception reports are public data; only named fields leave. */
export async function GET(req: Request) {
  const who = authorize(req, "VIEWER", { apiKey: true });
  if (who instanceof Response) return who;
  const raw = Number(new URL(req.url).searchParams.get("minutes") ?? 30);
  const minutes = Number.isFinite(raw) ? Math.max(5, Math.min(240, Math.round(raw))) : 30;
  const r = await engine<Heard>("GET", `/heard?minutes=${minutes}`).catch(() => null);
  if (!r) return problem(503, "the engine is not running");
  if (r.status !== 200) return problem(502, "the engine could not read reception reports");
  const d = r.data;
  return json({
    minutes,
    receivers: num(d.receivers) ?? 0,
    reports: Array.isArray(d.reports) ? d.reports.map(row) : [],
    byBand: counts(d.byBand),
    byContinent: counts(d.byContinent),
    farthest: d.farthest ? row(d.farthest) : null,
    lastQueryAt: num(d.lastQueryAt),
  });
}
