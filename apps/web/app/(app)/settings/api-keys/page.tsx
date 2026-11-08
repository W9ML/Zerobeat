import { desc } from "drizzle-orm";
import { requireUser } from "@/lib/server/auth";

import { apiKeys } from "@zerobeat/core/db/schema";

import { db } from "@/lib/server/ctx";

import { KeysView } from "./view";

export const dynamic = "force-dynamic";

export default async function KeysPage() {
  await requireUser("ADMIN");
  const rows = db().select().from(apiKeys).orderBy(desc(apiKeys.createdAt)).all();
  return <KeysView rows={rows.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, role: k.role, active: k.active, expiresAt: k.expiresAt, lastUsedAt: k.lastUsedAt, createdAt: k.createdAt }))} />;
}
