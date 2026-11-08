import Link from "next/link";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import landTopo from "world-atlas/land-110m.json";

import { mapPoints } from "@zerobeat/core/log/stats";
import { gridToLatLon } from "@zerobeat/core/ham/grid";

import { Card, cn, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/server/auth";
import { pageScope } from "@/lib/server/scope";
import { db } from "@/lib/server/ctx";

export const metadata = { title: "Map" };

const W = 1440;
const H = 720;
const x = (lon: number) => ((lon + 180) / 360) * W;
const y = (lat: number) => ((90 - lat) / 180) * H;

let landPath: string | null = null;
function land(): string {
  if (landPath) return landPath;
  const topo = landTopo as unknown as Topology<{ land: GeometryCollection }>;
  const fc = feature(topo, topo.objects.land) as unknown as FeatureCollection<Polygon | MultiPolygon>;
  const parts: string[] = [];
  for (const f of fc.features) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) {
      for (const ring of poly) {
        let d = "";
        let prevLon: number | null = null;
        for (const [lon, lat] of ring as [number, number][]) {
          // Break the path where a ring crosses the antimeridian.
          const jump = prevLon !== null && Math.abs(lon - prevLon) > 180;
          d += `${d && !jump ? "L" : "M"}${x(lon).toFixed(1)},${y(lat).toFixed(1)}`;
          prevLon = lon;
        }
        parts.push(d + "Z");
      }
    }
  }
  landPath = parts.join("");
  return landPath;
}

const RANGES = [
  { id: "all", label: "All time", ms: 0 },
  { id: "year", label: "12 months", ms: 365 * 86_400_000 },
  { id: "month", label: "30 days", ms: 30 * 86_400_000 },
  { id: "week", label: "7 days", ms: 7 * 86_400_000 },
];

export default async function MapPage({ searchParams }: { searchParams: Promise<{ range?: string; band?: string }> }) {
  const scope = await pageScope(await requireUser());
  const sp = await searchParams;
  const range = RANGES.find((r) => r.id === sp.range) ?? RANGES[0]!;
  const points = mapPoints(db(), { stationId: scope.stationId, since: range.ms ? Date.now() - range.ms : 0, band: sp.band || undefined });
  const home = scope.grid ? { grid: scope.grid, callsign: scope.callsign ?? "" } : null;
  const homePos = home ? gridToLatLon(home.grid) : null;
  const confirmed = points.filter((p) => p.confirmed > 0).length;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Map"
        subtitle={`${points.length} grid squares worked, ${confirmed} confirmed`}
        actions={
          <div className="flex overflow-hidden rounded-md border border-line-strong text-sm">
            {RANGES.map((r) => (
              <Link key={r.id} href={`/map?range=${r.id}${sp.band ? `&band=${sp.band}` : ""}`} className={cn("px-3 py-1.5", r.id === range.id ? "bg-panel-3 text-fg" : "bg-panel-2 text-muted hover:text-fg")}>
                {r.label}
              </Link>
            ))}
          </div>
        }
      />
      <Card pad={false}>
        <svg viewBox={`0 0 ${W} ${H}`} className="block w-full rounded-lg bg-[#0b1220]" role="img" aria-label="Worked grid squares">
          {Array.from({ length: 17 }, (_, i) => (
            <line key={`v${i}`} x1={x(-180 + i * 20)} x2={x(-180 + i * 20)} y1={0} y2={H} stroke="#1a2436" strokeWidth={1} />
          ))}
          {Array.from({ length: 17 }, (_, i) => (
            <line key={`h${i}`} y1={y(-90 + i * 10)} y2={y(-90 + i * 10)} x1={0} x2={W} stroke="#1a2436" strokeWidth={1} />
          ))}
          <path d={land()} fill="#1c2638" stroke="#2d3b55" strokeWidth={0.6} />
          {points.map((p) => {
            const c = gridToLatLon(p.grid);
            if (!c) return null;
            const lon0 = c.lon - 1;
            const lat1 = c.lat + 0.5;
            return (
              <rect key={p.grid} x={x(lon0)} y={y(lat1)} width={W / 180} height={H / 180} fill={p.confirmed ? "#3ecf8e" : "#f2662f"} fillOpacity={p.confirmed ? 0.85 : 0.75}>
                {/* One string: React 19 treats <title> children as a single text node. */}
                <title>{`${p.grid}: ${p.count} contact${p.count === 1 ? "" : "s"}, ${p.confirmed} confirmed`}</title>
              </rect>
            );
          })}
          {homePos && <circle cx={x(homePos.lon)} cy={y(homePos.lat)} r={5} fill="#fff" stroke="#f2662f" strokeWidth={2} />}
        </svg>
      </Card>
      <div className="mt-2 flex gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm bg-ok" /> confirmed
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm bg-accent" /> worked
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-full border-2 border-accent bg-white" /> home
        </span>
      </div>
    </div>
  );
}
