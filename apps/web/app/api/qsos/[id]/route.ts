import { deleteQso, getQso, updateQso } from "@zerobeat/core/log/qsos";

import { authorize, json, problem, readJson } from "@/lib/server/auth";
import { db } from "@/lib/server/ctx";
import { QsoBody } from "@/lib/server/qso-input";
import { ownScope, ownsQso, requestScope } from "@/lib/server/scope";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const who = authorize(req, "VIEWER", { apiKey: true });
  if (who instanceof Response) return who;
  const id = (await ctx.params).id;
  if (!ownsQso(requestScope(req, who), id)) return problem(404, "no such contact");
  const r = getQso(db(), id);
  return r ? json(r) : problem(404, "no such contact");
}

export async function PATCH(req: Request, ctx: Ctx) {
  const who = authorize(req, "OPERATOR");
  if (who instanceof Response) return who;
  const parsed = QsoBody.safeParse(await readJson(req));
  if (!parsed.success) return problem(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const { clientId: _c, stationId: _s, ...patch } = parsed.data;
  const id = (await ctx.params).id;
  // Only your own contacts (an admin viewing someone else's log cannot change it).
  if (!ownsQso(ownScope(who), id)) return problem(404, "no such contact");
  const q = updateQso(db(), id, patch);
  return q ? json({ qso: q }) : problem(404, "no such contact");
}

export async function DELETE(req: Request, ctx: Ctx) {
  const who = authorize(req, "OPERATOR");
  if (who instanceof Response) return who;
  const id = (await ctx.params).id;
  if (!ownsQso(ownScope(who), id)) return problem(404, "no such contact");
  return deleteQso(db(), id) ? json({ ok: true }) : problem(404, "no such contact");
}
