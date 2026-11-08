import { asc, sql } from "drizzle-orm";
import { requireUser } from "@/lib/server/auth";

import { stations } from "@zerobeat/core/db/schema";

import { db } from "@/lib/server/ctx";

import { StationsView } from "./view";

export const dynamic = "force-dynamic";

export default async function StationsPage() {
  await requireUser("ADMIN");
  const rows = db().select().from(stations).orderBy(asc(stations.createdAt)).all();
  const counts = new Map(db().all<{ id: string; n: number }>(sql`SELECT station_id AS id, COUNT(*) AS n FROM qsos GROUP BY station_id`).map((r) => [r.id, r.n]));
  return <StationsView rows={rows.map((s) => ({ id: s.id, callsign: s.callsign, grid: s.grid, name: s.name, isDefault: s.isDefault, qsos: counts.get(s.id) ?? 0 }))} />;
}
