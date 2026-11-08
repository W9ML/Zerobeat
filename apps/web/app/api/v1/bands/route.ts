/** Public API: what this station's receiver hears per band, now against its own history (the wall's band card). */
import { authorize, json, problem } from "@/lib/server/auth";
import { engine } from "@/lib/server/engine";

interface Band {
  band: string;
  usual: number | null;
  samples: number;
  next: number | null;
  now: { perWindow: number; windows: number; stations: number } | null;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** ?mode=FT8 (default). Decodes per window: this UTC hour so far, and the 30-day average at this hour and the next. */
export async function GET(req: Request) {
  const who = authorize(req, "VIEWER", { apiKey: true });
  if (who instanceof Response) return who;
  const mode = (new URL(req.url).searchParams.get("mode") ?? "FT8").toUpperCase();
  if (!/^[A-Z0-9]{2,6}$/.test(mode)) return problem(400, "mode must be like FT8");
  const r = await engine<{ hour: number; days: number; bands: Band[] }>("GET", `/bands?mode=${mode}`).catch(() => null);
  if (!r) return problem(503, "the engine is not running");
  if (r.status !== 200) return problem(502, "the engine could not read band memory");
  const d = r.data;
  return json({
    mode,
    hour: num(d.hour),
    days: num(d.days),
    bands: (Array.isArray(d.bands) ? d.bands : []).slice(0, 20).map((b) => ({
      band: typeof b.band === "string" ? b.band.slice(0, 8) : null,
      usual: num(b.usual),
      samples: num(b.samples) ?? 0,
      next: num(b.next),
      now: b.now ? { perWindow: num(b.now.perWindow), windows: num(b.now.windows), stations: num(b.now.stations) } : null,
    })),
  });
}
