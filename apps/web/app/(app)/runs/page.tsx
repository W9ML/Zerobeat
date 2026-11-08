import Link from "next/link";
import { desc, eq } from "drizzle-orm";

import { runs } from "@zerobeat/core/db/schema";

import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/server/auth";
import { db } from "@/lib/server/ctx";
import { duration, utcDateTime, utcTime } from "@/lib/format";

import { ActivityHistory } from "./activity";
import { pageScope } from "@/lib/server/scope";

export const metadata = { title: "Runs" };

interface NewOne {
  kind: string;
  label: string;
  callsign: string;
}

const KIND_TONE: Record<string, "ok" | "info" | "accent"> = { dxcc: "ok", continent: "ok", zone: "accent", park: "accent", band: "info", grid: "info" };

export default async function RunsPage() {
  const scope = await pageScope(await requireUser());
  const rows = db().select().from(runs).where(eq(runs.stationId, scope.stationId)).orderBy(desc(runs.startedAt)).limit(100).all();
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Runs" subtitle="Every stretch of automatic operating: what it did, what was new, and why it stopped." />
      {rows.length === 0 ? (
        <Empty>No automatic runs yet. Turn on CQ, Hunt or POTA on the Operate page.</Empty>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const modes = JSON.parse(r.modes) as string[];
            const bands = JSON.parse(r.bands) as string[];
            const newOnes = JSON.parse(r.newOnes) as NewOne[];
            const faults = JSON.parse(r.faults) as { at: number; reason: string }[];
            const big = newOnes.filter((n) => n.kind !== "grid" && n.kind !== "band");
            const live = r.endedAt === null;
            return (
              <Card key={r.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm text-fg">
                        {utcDateTime(r.startedAt)} – {r.endedAt ? utcTime(r.endedAt) + "Z" : "now"}
                      </span>
                      {live && <Badge tone="ok">running</Badge>}
                    </div>
                    <div className="mt-1 text-xs text-muted">
                      {modes.join(" → ")} · {bands.map((b) => b.toLowerCase()).join(", ") || "—"} · {duration((r.endedAt ?? Date.now()) - r.startedAt)} · started by {r.startedBy}
                    </div>
                  </div>
                  <div className="flex gap-4 text-right">
                    <div>
                      <div className="font-mono text-xl text-fg">{r.qsos}</div>
                      <div className="text-[11px] text-muted">contacts</div>
                    </div>
                    <div>
                      <div className="font-mono text-xl text-fg">{big.length}</div>
                      <div className="text-[11px] text-muted">new</div>
                    </div>
                    <div>
                      <div className="font-mono text-xl text-fg">{Math.round(r.txSeconds / 60)}</div>
                      <div className="text-[11px] text-muted">min keyed</div>
                    </div>
                  </div>
                </div>
                {newOnes.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {newOnes.slice(0, 30).map((n, i) => (
                      <Link key={i} href={`/call/${encodeURIComponent(n.callsign)}`}>
                        <Badge tone={KIND_TONE[n.kind] ?? "neutral"}>
                          {n.label.replace(/^new /, "")} · {n.callsign}
                        </Badge>
                      </Link>
                    ))}
                  </div>
                )}
                {(r.stopReason || faults.length > 0) && (
                  <div className="mt-3 space-y-0.5 text-xs">
                    {r.stopReason && <div className="text-muted">Stopped: {r.stopReason}</div>}
                    {faults.map((f, i) => (
                      <div key={i} className="text-bad">
                        {utcTime(f.at)}Z {f.reason}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
      <div id="activity" className="mt-6">
        <ActivityHistory />
      </div>
    </div>
  );
}
