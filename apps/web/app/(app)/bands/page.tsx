/**
 * Band memory: when each band opens from this station, learned from everything the
 * receiver has decoded. Cells are the average number of distinct stations heard in that
 * UTC hour, over the days the receiver was actually on that band then.
 */
import Link from "next/link";
import { sql } from "drizzle-orm";

import { CONTINENTS } from "@zerobeat/core/ham/us-states";

import { Card, cn, Empty, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/server/auth";
import { db } from "@/lib/server/ctx";

export const metadata = { title: "Band memory" };

const BAND_ORDER = ["160M", "80M", "60M", "40M", "30M", "20M", "17M", "15M", "12M", "10M", "6M", "2M"];
const RANGES = [
  { id: "7", label: "7 days" },
  { id: "30", label: "30 days" },
  { id: "90", label: "90 days" },
  { id: "365", label: "1 year" },
];

export default async function BandsPage({ searchParams }: { searchParams: Promise<{ days?: string; cont?: string; mode?: string }> }) {
  await requireUser();
  const sp = await searchParams;
  const days = RANGES.some((r) => r.id === sp.days) ? Number(sp.days) : 30;
  const cont = sp.cont && CONTINENTS[sp.cont] ? sp.cont : "*";
  const mode = sp.mode === "FT4" || sp.mode === "FT8" || sp.mode === "FT2" ? sp.mode : null;
  const since = Date.now() - days * 86_400_000;

  // Stations per hour for the chosen continent, and the hours the band was monitored.
  const rows = db().all<{ band: string; h: number; avg: number; samples: number; best: number | null }>(sql`
    SELECT s.band AS band, CAST(strftime('%H', s.hour / 1000, 'unixepoch') AS INTEGER) AS h,
           AVG(COALESCE(c.stations, 0)) AS avg, COUNT(*) AS samples, MAX(c.best_snr) AS best
    FROM band_hours s
    LEFT JOIN band_hours c ON c.hour = s.hour AND c.band = s.band AND c.mode = s.mode AND c.continent = ${cont}
    WHERE s.continent = '*' AND s.hour >= ${since} AND s.windows >= 4 ${mode ? sql`AND s.mode = ${mode}` : sql``}
    GROUP BY s.band, h
  `);
  const coverage = db().get<{ hours: number; first: number | null }>(sql`SELECT COUNT(DISTINCT hour) AS hours, MIN(hour) AS first FROM band_hours WHERE continent = '*' AND hour >= ${since}`);
  const bands = BAND_ORDER.filter((b) => rows.some((r) => r.band === b));
  const cell = new Map(rows.map((r) => [`${r.band}|${r.h}`, r]));
  const max = Math.max(1, ...rows.map((r) => r.avg));
  const nowH = new Date().getUTCHours();
  const bestNow = rows
    .filter((r) => r.h === nowH && r.samples >= 2)
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 3);

  const q = (p: Record<string, string | null>) => {
    const u = new URLSearchParams();
    const merged = { days: String(days), cont: cont === "*" ? null : cont, mode, ...p };
    for (const [k, v] of Object.entries(merged)) if (v) u.set(k, v);
    return `/bands?${u}`;
  };
  const chip = (active: boolean) => cn("px-2.5 py-1 text-xs", active ? "bg-panel-3 text-fg" : "bg-panel-2 text-muted hover:text-fg");

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader
        title="Band memory"
        subtitle={`When your bands open, learned from what this station has decoded. ${coverage?.hours ?? 0} hours of listening in the last ${days} days.`}
      />
      <div className="flex flex-wrap gap-3">
        <div className="flex overflow-hidden rounded-md border border-line-strong">
          {RANGES.map((r) => (
            <Link key={r.id} href={q({ days: r.id })} className={chip(String(days) === r.id)}>
              {r.label}
            </Link>
          ))}
        </div>
        <div className="flex overflow-hidden rounded-md border border-line-strong">
          <Link href={q({ cont: null })} className={chip(cont === "*")}>
            Everyone
          </Link>
          {Object.keys(CONTINENTS).map((c) => (
            <Link key={c} href={q({ cont: c })} className={chip(cont === c)} title={CONTINENTS[c]}>
              {c}
            </Link>
          ))}
        </div>
        <div className="flex overflow-hidden rounded-md border border-line-strong">
          {[null, "FT8", "FT4", "FT2"].map((m) => (
            <Link key={m ?? "all"} href={q({ mode: m })} className={chip(mode === m)}>
              {m ?? "All"}
            </Link>
          ))}
        </div>
      </div>

      {bands.length === 0 ? (
        <Empty>Nothing yet. The engine records every window it decodes; give it a day on the air.</Empty>
      ) : (
        <>
          {bestNow.length > 0 && (
            <Card title={`At ${String(nowH).padStart(2, "0")}Z, historically`}>
              <div className="flex flex-wrap gap-6">
                {bestNow.map((b, i) => (
                  <div key={b.band}>
                    <div className={cn("font-mono text-2xl", i === 0 ? "text-accent-strong" : "text-fg")}>{b.band.toLowerCase()}</div>
                    <div className="text-xs text-muted">
                      {b.avg.toFixed(1)} {cont === "*" ? "" : `${cont} `}stations an hour{b.best !== null ? `, best ${b.best} dB` : ""}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
          <Card title={`Average ${cont === "*" ? "" : `${CONTINENTS[cont]} `}stations heard per hour (UTC)`} pad={false}>
            <div className="overflow-x-auto p-4">
              <table className="w-full border-separate border-spacing-[3px] text-xs">
                <thead>
                  <tr>
                    <th />
                    {Array.from({ length: 24 }, (_, h) => (
                      <th key={h} className={cn("w-[3.6%] font-mono font-normal", h === nowH ? "text-accent-strong" : "text-subtle")}>
                        {String(h).padStart(2, "0")}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {bands.map((b) => (
                    <tr key={b}>
                      <td className="pr-2 text-right font-mono text-muted">{b.toLowerCase()}</td>
                      {Array.from({ length: 24 }, (_, h) => {
                        const c = cell.get(`${b}|${h}`);
                        if (!c) return <td key={h} className="h-7 rounded-sm bg-panel-2/40" title="not monitored" />;
                        const v = c.avg / max;
                        return (
                          <td
                            key={h}
                            className={cn("h-7 rounded-sm text-center font-mono text-[10px]", v > 0.55 ? "text-bg" : "text-fg/80", h === nowH && "outline outline-1 outline-accent")}
                            style={{ background: `color-mix(in oklab, var(--color-accent) ${Math.round(8 + v * 92)}%, var(--color-panel-2))` }}
                            title={`${b} ${String(h).padStart(2, "0")}Z: ${c.avg.toFixed(1)} stations/hour over ${c.samples} hour(s)${c.best !== null ? `, best ${c.best} dB` : ""}`}
                          >
                            {c.avg >= 1 ? Math.round(c.avg) : ""}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-subtle">Gray cells are hours the receiver was not on that band, not hours the band was closed. The more you listen, the better this gets.</p>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
