import { asc } from "drizzle-orm";

import { users } from "@zerobeat/core/db/schema";

import { requireUser } from "@/lib/server/auth";
import { db } from "@/lib/server/ctx";

import { UsersView } from "./view";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const me = await requireUser("ADMIN");
  const rows = db().select().from(users).orderBy(asc(users.createdAt)).all();
  return <UsersView me={me.id} rows={rows.map((u) => ({ id: u.id, email: u.email, name: u.name, callsign: u.callsign, licenseClass: u.licenseClass, role: u.role, active: u.active, lastLoginAt: u.lastLoginAt }))} />;
}
