import { asc, eq } from "drizzle-orm";

import { stations, users } from "@zerobeat/core/db/schema";

import { Shell } from "@/components/shell";
import { requireUser } from "@/lib/server/auth";
import { db } from "@/lib/server/ctx";
import { pageScope } from "@/lib/server/scope";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  // An admin can look at another user's logbook and settings, read-only.
  const scope = await pageScope(user);
  const people =
    user.role === "ADMIN"
      ? db()
          .select({ id: users.id, name: users.name, callsign: stations.callsign })
          .from(users)
          .innerJoin(stations, eq(stations.userId, users.id))
          .orderBy(asc(stations.callsign))
          .all()
      : [];
  const viewing = scope.readOnly ? { userId: scope.userId, callsign: scope.callsign } : null;
  return (
    <Shell user={{ id: user.id, name: user.name, callsign: user.callsign, role: user.role }} people={people} viewing={viewing}>
      {children}
    </Shell>
  );
}
