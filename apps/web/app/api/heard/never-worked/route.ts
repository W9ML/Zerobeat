/** DXCC entities this station hears and has never worked, best first. */
import { heardNeverWorked } from "@zerobeat/core/log/heard-entities";

import { authorize, json } from "@/lib/server/auth";
import { requestScope } from "@/lib/server/scope";
import { db } from "@/lib/server/ctx";

export async function GET(req: Request) {
  const who = authorize(req, "VIEWER");
  if (who instanceof Response) return who;
  const limit = Math.min(200, Math.max(1, Number(new URL(req.url).searchParams.get("limit") ?? 50)));
  return json({ entities: heardNeverWorked(db(), requestScope(req, who).stationId, { limit }) });
}
