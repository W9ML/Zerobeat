import Link from "next/link";
import { desc, eq } from "drizzle-orm";

import { runs } from "@zerobeat/core/db/schema";
import { getDxcc } from "@zerobeat/core/dxcc/cty";
import { byBandMode, newOnes, perDay, summary, uploadSummary } from "@zerobeat/core/log/stats";
import { searchQsos } from "@zerobeat/core/log/qsos";
import { US_STATES } from "@zerobeat/core/ham/us-states";

import { Badge, Card, Empty, PageHeader, Stat, Table } from "@/components/ui";
import { requireUser } from "@/lib/server/auth";
import { pageScope } from "@/lib/server/scope";
import { db } from "@/lib/server/ctx";
import { ago, displayMode, duration, num, utcDate, utcTime } from "@/lib/format";

import { AwayStrip } from "@/components/away-strip";

import { LivePanel } from "./live-panel";

export const metadata = { title: "Dashboard" };

const SERVICE: Record<string, string> = { qrz: "QRZ", lotw: "LoTW", eqsl: "eQSL", clublog: "Club Log", wrl: "WRL", n3fjp: "N3FJP" };

export default async function Dashboard() {
  const scope = await pageScope(await requireUser());
  const sid = scope.stationId;
  const d = db();
  const s = summary(d, sid);
  const days = perDay(d, sid, 30);
  const max = Math.max(1, ...days.map((x) => x.count));
  const recent = searchQsos(d, { stationId: sid, pageSize: 12 }).rows;
  const bands = byBandMode(d, sid, Date.now() - 30 * 86_400_000).slice(0, 8);
  const fresh = newOnes(d, sid);
  const uploads = uploadSummary(d, sid);
  const pendingBy = new Map<string, number>();
  const failedBy = new Map<string, number>();
  for (const u of uploads) {
    if (u.status === "pending") pendingBy.set(u.service, u.count);
    if (u.status === "failed") failedBy.set(u.service, u.count);
  }
  const dx = getDxcc();
  const lastRun = d.select().from(runs).where(eq(runs.stationId, sid)).orderBy(desc(runs.startedAt)).limit(1).get();

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader title="Dashboard" subtitle={s.firstQso ? `Logging since ${utcDate(s.firstQso)}` : "No contacts yet"} />
      <AwayStrip />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Stat label="Today (UTC)" value={num(s.today)} sub={`yesterday ${num(s.yesterday)}`} tone="accent" />
        <Stat label="Last 7 days" value={num(s.last7)} />
        <Stat label="Last 30 days" value={num(s.last30)} />
        <Stat label="Total contacts" value={num(s.total)} />
        <Stat label="DXCC worked" value={num(s.dxcc)} sub={`${num(s.dxccConfirmed)} confirmed`} />
        <Stat label="Confirmed" value={num(s.confirmedCredit)} sub="card or LoTW" tone="ok" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <Card title="Contacts per day, last 30 days">
          <div className="flex h-36 items-end gap-[3px]">
            {days.map((x) => (
              <div key={x.day} className="group relative flex-1">
                <div className="w-full rounded-t-sm bg-accent/70 transition-colors group-hover:bg-accent" style={{ height: `${Math.max(x.count ? 4 : 0, (x.count / max) * 136)}px` }} />
                <div className="pointer-events-none absolute bottom-full left-1/2 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-panel-3 px-1.5 py-0.5 text-[11px] group-hover:block">
                  {x.day.slice(5)}: {x.count}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between font-mono text-[10px] text-subtle">
            <span>{days[0]?.day.slice(5)}</span>
            <span>today</span>
          </div>
        </Card>
        <LivePanel />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Recent contacts" pad={false} className="lg:col-span-2">
          {recent.length === 0 ? (
            <div className="p-4">
              <Empty>Nothing logged yet.</Empty>
            </div>
          ) : (
            <Table>
              <tbody>
                {recent.map((q) => (
                  <tr key={q.id}>
                    <td className="w-24 font-mono text-xs text-muted">
                      {utcDate(q.startTime).slice(5)} {utcTime(q.startTime)}
                    </td>
                    <td>
                      <Link href={`/log/${q.id}`} className="font-mono font-medium hover:text-accent-strong">
                        {q.callsign}
                      </Link>
                    </td>
                    <td className="text-xs text-muted">{dx.entity(q.dxcc)?.name ?? ""}</td>
                    <td className="font-mono text-xs">{q.band.toLowerCase()}</td>
                    <td className="text-xs">{displayMode(q.mode, q.submode)}</td>
                    <td className="font-mono text-xs text-muted">
                      {q.rstSent}/{q.rstRcvd}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <div className="space-y-4">
          {lastRun && <LastRun run={lastRun} />}
          <Card title="New today">
            {fresh.length === 0 ? (
              <p className="text-sm text-muted">No new DXCC entities or states yet today.</p>
            ) : (
              <div className="space-y-1.5">
                {fresh.map((f) => (
                  <div key={`${f.kind}-${f.key}`} className="flex items-center justify-between text-sm">
                    <span>
                      <Badge tone="ok">{f.kind === "dxcc" ? "DXCC" : "State"}</Badge>{" "}
                      {f.kind === "dxcc" ? (dx.entity(Number(f.key))?.name ?? f.key) : (US_STATES[f.key] ?? f.key)}
                    </span>
                    <Link href={`/call/${encodeURIComponent(f.callsign)}`} className="font-mono text-xs text-muted hover:text-accent-strong">{f.callsign}</Link>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card title="Bands, last 30 days">
            {bands.length === 0 ? (
              <p className="text-sm text-muted">No contacts in the last 30 days.</p>
            ) : (
              bands.map((b) => (
                <div key={`${b.band}${b.mode}`} className="flex justify-between py-0.5 text-sm">
                  <span className="font-mono">
                    {b.band.toLowerCase()} <span className="text-muted">{b.mode}</span>
                  </span>
                  <span className="font-mono text-muted">{b.count}</span>
                </div>
              ))
            )}
          </Card>
          <Card title="Upload queue" actions={<Link href="/services" className="text-xs text-accent-strong hover:underline">Services</Link>}>
            {pendingBy.size === 0 && failedBy.size === 0 ? (
              <p className="text-sm text-muted">Nothing waiting.</p>
            ) : (
              [...new Set([...pendingBy.keys(), ...failedBy.keys()])].map((svc) => (
                <div key={svc} className="flex justify-between py-0.5 text-sm">
                  <span>{SERVICE[svc] ?? svc}</span>
                  <span className="flex gap-1">
                    {pendingBy.get(svc) ? <Badge>{pendingBy.get(svc)} waiting</Badge> : null}
                    {failedBy.get(svc) ? <Badge tone="bad">{failedBy.get(svc)} failed</Badge> : null}
                  </span>
                </div>
              ))
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function LastRun({ run }: { run: typeof runs.$inferSelect }) {
  const newOnes = (JSON.parse(run.newOnes) as { kind: string; label: string; callsign: string }[]).filter((n) => n.kind !== "grid" && n.kind !== "band");
  const faults = JSON.parse(run.faults) as unknown[];
  const live = run.endedAt === null;
  return (
    <Card title={live ? "Running now" : "Last run"} actions={<Link href="/runs" className="text-xs text-accent-strong hover:underline">All runs</Link>}>
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-muted">{(JSON.parse(run.modes) as string[]).join(" → ")}</span>
        <span className="text-xs text-subtle">{live ? `for ${duration(Date.now() - run.startedAt)}` : ago(run.endedAt!)}</span>
      </div>
      <div className="mt-2 flex gap-5">
        <div>
          <span className="font-mono text-xl text-fg">{run.qsos}</span> <span className="text-xs text-muted">contacts</span>
        </div>
        <div>
          <span className="font-mono text-xl text-fg">{newOnes.length}</span> <span className="text-xs text-muted">new</span>
        </div>
      </div>
      {newOnes.length > 0 && <div className="mt-2 truncate text-xs text-ok">{newOnes.slice(0, 4).map((n) => `${n.label.replace(/^new /, "")} ${n.callsign}`).join(" · ")}</div>}
      {!live && run.stopReason && <div className={`mt-2 text-xs ${faults.length ? "text-bad" : "text-muted"}`}>Stopped: {run.stopReason}</div>}
    </Card>
  );
}
