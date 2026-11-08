/** Unauthenticated liveness: no data, just whether the pieces answer. */
import { sql } from "drizzle-orm";

import { db, VERSION } from "@/lib/server/ctx";
import { engine } from "@/lib/server/engine";

export const dynamic = "force-dynamic";

export async function GET() {
  let dbOk = false;
  try {
    db().get(sql`SELECT 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const e = await engine<{ ok: boolean; radio: string }>("GET", "/health", undefined, 3000).catch(() => null);
  const ok = dbOk && !!e?.data?.ok;
  return Response.json({ ok, version: VERSION, db: dbOk, engine: !!e?.data?.ok }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
