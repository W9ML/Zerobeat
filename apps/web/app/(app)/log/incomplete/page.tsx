import { and, desc, eq, isNull } from "drizzle-orm";

import { incompleteExchanges } from "@zerobeat/core/db/schema";

import { Card, Empty, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/server/auth";
import { db } from "@/lib/server/ctx";
import { displayMode, utcDateTime } from "@/lib/format";

import { Actions } from "./actions";
import { pageScope } from "@/lib/server/scope";

export const metadata = { title: "Incomplete exchanges" };

export default async function IncompletePage() {
  const user = await requireUser();
  const scope = await pageScope(user);
  const rows = db().select().from(incompleteExchanges).where(and(eq(incompleteExchanges.stationId, scope.stationId), isNull(incompleteExchanges.resolvedAt))).orderBy(desc(incompleteExchanges.startTime)).limit(200).all();
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Incomplete exchanges" subtitle="Digital exchanges where reports crossed but the sign-off never arrived. Not in the log until you say so." />
      {rows.length === 0 ? (
        <Empty>Nothing waiting.</Empty>
      ) : (
        <div className="space-y-3">
          {rows.map((x) => (
            <Card key={x.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-mono text-base font-medium">{x.callsign}</div>
                  <div className="text-xs text-muted">
                    {utcDateTime(x.startTime)} · {x.band.toLowerCase()} {displayMode(x.mode, null)} · sent {x.rstSent ?? "—"} · rcvd {x.rstRcvd ?? "—"}
                  </div>
                  <div className="mt-1 text-xs text-warn">{x.reason}</div>
                </div>
                {user.role !== "VIEWER" && !scope.readOnly && <Actions id={x.id} />}
              </div>
              {x.transcript && <pre className="mt-3 overflow-x-auto rounded-md bg-bg p-2 font-mono text-[11px] leading-5 text-muted">{x.transcript}</pre>}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
