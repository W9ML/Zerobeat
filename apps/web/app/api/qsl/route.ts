/** QSL queue actions and manual queueing. */
import { z } from "zod";

import { approveQsls, cancelQsls, enqueueQsl, optOut } from "@zerobeat/core/qsl/queue";

import { authorize, json, problem, readJson } from "@/lib/server/auth";
import { db, settingsStore } from "@/lib/server/ctx";
import { engine } from "@/lib/server/engine";
import { ownScope, ownsQso } from "@/lib/server/scope";
import { qslEmails, qsos } from "@zerobeat/core/db/schema";
import { and, eq, inArray } from "drizzle-orm";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), ids: z.array(z.string()).max(500) }),
  z.object({ action: z.literal("cancel"), ids: z.array(z.string()).max(500) }),
  z.object({ action: z.literal("send-now") }),
  z.object({ action: z.literal("queue"), qsoId: z.string(), email: z.string().email() }),
  z.object({ action: z.literal("opt-out"), target: z.string().min(3).max(120) }),
]);

export async function POST(req: Request) {
  const who = authorize(req, "OPERATOR");
  if (who instanceof Response) return who;
  const p = Body.safeParse(await readJson(req));
  if (!p.success) return problem(400, p.error.issues[0]?.message ?? "bad request");
  const b = p.data;
  const userId = who.kind === "user" ? who.id : null;
  const own = ownScope(who);
  // Only emails for your own contacts.
  const mine = (ids: string[]) =>
    ids.length
      ? db()
          .select({ id: qslEmails.id })
          .from(qslEmails)
          .innerJoin(qsos, eq(qsos.id, qslEmails.qsoId))
          .where(and(inArray(qslEmails.id, ids), eq(qsos.stationId, own.stationId)))
          .all()
          .map((r) => r.id)
      : [];
  switch (b.action) {
    case "approve":
      return json({ ok: true, changed: approveQsls(db(), mine(b.ids), userId) });
    case "cancel":
      return json({ ok: true, changed: cancelQsls(db(), mine(b.ids)) });
    case "send-now": {
      const r = await engine("POST", "/jobs/run", { name: "qsl" }, 120_000).catch((e) => ({ status: 503, data: { error: (e as Error).message } }));
      return json(r.data, r.status);
    }
    case "queue": {
      if (!ownsQso(own, b.qsoId)) return problem(404, "no such contact");
      const r = enqueueQsl(db(), settingsStore().snapshot(own.userId), b.qsoId, b.email, { force: true });
      return r.ok ? json(r) : problem(409, r.reason);
    }
    case "opt-out":
      optOut(db(), b.target, "manual", `by ${who.email}`);
      return json({ ok: true });
  }
}
