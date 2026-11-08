/** This user's push subscriptions: one per browser/device. */
import { and, eq } from "drizzle-orm";

import { pushSubscriptions } from "@zerobeat/core/db/schema";
import { newId } from "@zerobeat/core/util/id";

import { authorize, json, problem, readJson } from "@/lib/server/auth";
import { db } from "@/lib/server/ctx";
import { engine, EngineDown } from "@/lib/server/engine";
import { isPushService } from "@/lib/push-endpoint";

const CATEGORIES = ["needed", "faults", "digest"] as const;

function cleanCategories(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return CATEGORIES.filter((c) => v.includes(c));
}

function me(req: Request) {
  const who = authorize(req, "VIEWER");
  if (who instanceof Response) return who;
  if (who.kind !== "user") return problem(403, "push subscriptions belong to a signed-in user");
  return who;
}

export async function GET(req: Request) {
  const who = me(req);
  if (who instanceof Response) return who;
  let publicKey: string | null = null;
  try {
    publicKey = (await engine<{ publicKey: string }>("GET", "/push/key")).data.publicKey ?? null;
  } catch (e) {
    if (!(e instanceof EngineDown)) throw e;
  }
  const subs = db()
    .select({ endpoint: pushSubscriptions.endpoint, categories: pushSubscriptions.categories, label: pushSubscriptions.label, createdAt: pushSubscriptions.createdAt, lastOkAt: pushSubscriptions.lastOkAt, failures: pushSubscriptions.failures })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, who.id))
    .all()
    .map((s) => ({ ...s, categories: JSON.parse(s.categories) as string[] }));
  return json({ publicKey, subscriptions: subs });
}

export async function POST(req: Request) {
  const who = me(req);
  if (who instanceof Response) return who;
  const b = await readJson<{ endpoint?: string; keys?: { p256dh?: string; auth?: string }; categories?: unknown; label?: string }>(req);
  const endpoint = b?.endpoint;
  if (!endpoint || endpoint.length > 2048 || !isPushService(endpoint)) return problem(400, "not a push subscription from a browser's push service");
  const { p256dh, auth } = b.keys ?? {};
  if (!p256dh || !auth || p256dh.length > 200 || auth.length > 100) return problem(400, "subscription keys missing");
  const categories = JSON.stringify(cleanCategories(b.categories) ?? [...CATEGORIES]);
  const label = (b.label ?? "").slice(0, 80) || null;
  const d = db();
  d.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run();
  d.insert(pushSubscriptions).values({ id: newId(), userId: who.id, endpoint, p256dh, auth, categories, label }).run();
  return json({ ok: true });
}

export async function PATCH(req: Request) {
  const who = me(req);
  if (who instanceof Response) return who;
  const b = await readJson<{ endpoint?: string; categories?: unknown }>(req);
  const categories = cleanCategories(b?.categories);
  if (!b?.endpoint || !categories) return problem(400, "send endpoint and categories");
  const r = db()
    .update(pushSubscriptions)
    .set({ categories: JSON.stringify(categories) })
    .where(and(eq(pushSubscriptions.endpoint, b.endpoint), eq(pushSubscriptions.userId, who.id)))
    .run();
  if (r.changes === 0) return problem(404, "this device is not subscribed");
  return json({ ok: true });
}

export async function DELETE(req: Request) {
  const who = me(req);
  if (who instanceof Response) return who;
  const b = await readJson<{ endpoint?: string }>(req);
  if (!b?.endpoint) return problem(400, "send endpoint");
  db()
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.endpoint, b.endpoint), eq(pushSubscriptions.userId, who.id)))
    .run();
  return json({ ok: true });
}
