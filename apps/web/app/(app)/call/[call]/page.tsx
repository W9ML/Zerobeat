/** Everything about one station: contacts, confirmations, how we hear them, and whether they hear us. */
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, sql } from "drizzle-orm";

import { heardReports, qsos } from "@zerobeat/core/db/schema";
import { getDxcc } from "@zerobeat/core/dxcc/cty";
import { looksLikeCallsign, normaliseCallsign } from "@zerobeat/core/ham/callsign";
import { gridDistanceKm } from "@zerobeat/core/ham/grid";
import { hasCredit } from "@zerobeat/core/log/awards";

import { Badge, Card, Empty, PageHeader, Stat, Table } from "@/components/ui";
import { requireUser } from "@/lib/server/auth";
import { db, settingsStore } from "@/lib/server/ctx";
import { displayMode, utcDate, utcDateTime, utcTime } from "@/lib/format";

import { Callbook } from "./callbook";
import { fmtDistance } from "@/lib/distance";
import { pageScope } from "@/lib/server/scope";

const BANDS = ["160M", "80M", "60M", "40M", "30M", "20M", "17M", "15M", "12M", "10M", "6M"];

export async function generateMetadata({ params }: { params: Promise<{ call: string }> }) {
  return { title: normaliseCallsign(decodeURIComponent((await params).call)) };
}

export default async function CallPage({ params }: { params: Promise<{ call: string }> }) {
  const scope = await pageScope(await requireUser());
  const call = normaliseCallsign(decodeURIComponent((await params).call));
  if (!looksLikeCallsign(call)) notFound();
  const d = db();
  const contacts = d.select().from(qsos).where(and(eq(qsos.stationId, scope.stationId), eq(qsos.callsign, call))).orderBy(desc(qsos.startTime)).all();
  const heard = d.all<{ band: string; n: number; best: number; first: number; last: number }>(
    sql`SELECT band, COUNT(*) AS n, MAX(snr) AS best, MIN(at) AS first, MAX(at) AS last FROM decodes WHERE callsign = ${call} GROUP BY band ORDER BY last DESC`,
  );
  const heardMe = d.select().from(heardReports).where(eq(heardReports.receiver, call)).orderBy(desc(heardReports.at)).limit(20).all();
  const dx = getDxcc().resolve(call);
  const st = scope.grid ? { grid: scope.grid } : null;
  const grid = contacts.find((q) => q.grid)?.grid ?? null;
  const km = grid && st ? gridDistanceKm(st.grid, grid) : null;
  const confirmed = contacts.filter((q) => hasCredit({ qslRcvd: q.qslRcvd, lotwRcvd: q.lotwRcvd, eqslRcvd: q.eqslRcvd, qrzRcvd: q.qrzRcvd }));
  const matrix = new Map<string, "confirmed" | "worked">();
  for (const q of contacts) {
    const k = `${q.band}|${q.submode ?? q.mode}`;
    if (hasCredit({ qslRcvd: q.qslRcvd, lotwRcvd: q.lotwRcvd, eqslRcvd: q.eqslRcvd, qrzRcvd: q.qrzRcvd })) matrix.set(k, "confirmed");
    else if (!matrix.has(k)) matrix.set(k, "worked");
  }
  const modes = [...new Set(contacts.map((q) => q.submode ?? q.mode))];
  const totalHeard = heard.reduce((a, b) => a + b.n, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title={<span className="font-mono">{call}</span>}
        subtitle={[dx?.name, dx ? `${dx.continent} · CQ ${dx.cqZone} · ITU ${dx.ituZone}` : null, grid, km ? fmtDistance(km, settingsStore().snapshot(scope.userId)["app.distanceUnit"]) : null].filter(Boolean).join(" · ")}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Contacts" value={contacts.length} sub={contacts[0] ? `last ${utcDate(contacts[0].startTime)}` : "never worked"} />
        <Stat label="Confirmed" value={confirmed.length} sub="card or LoTW" tone={confirmed.length ? "ok" : undefined} />
        <Stat label="Times decoded" value={totalHeard} sub={heard[0] ? `last ${utcDateTime(heard[0].last)}` : "not heard recently"} />
        <Stat label="Heard you" value={heardMe.length} sub={heardMe[0] ? `last ${utcDateTime(heardMe[0].at)}` : "no PSKReporter reports"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          {modes.length > 0 && (
            <Card title="Band and mode slots">
              <table className="text-xs">
                <thead>
                  <tr>
                    <th />
                    {BANDS.map((b) => (
                      <th key={b} className="px-1.5 font-mono font-normal text-subtle">
                        {b.toLowerCase()}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {modes.map((m) => (
                    <tr key={m}>
                      <td className="pr-3 text-muted">{m}</td>
                      {BANDS.map((b) => {
                        const v = matrix.get(`${b}|${m}`);
                        return (
                          <td key={b} className="px-1.5 py-1 text-center">
                            {v === "confirmed" ? <span className="inline-block size-3 rounded-sm bg-ok" title="confirmed" /> : v === "worked" ? <span className="inline-block size-3 rounded-sm border border-warn" title="worked, not confirmed" /> : <span className="inline-block size-3 rounded-sm bg-panel-2" />}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          <Card title="Contacts" pad={false}>
            {contacts.length === 0 ? (
              <div className="p-4">
                <Empty>Not in the log.</Empty>
              </div>
            ) : (
              <Table>
                <tbody>
                  {contacts.map((q) => (
                    <tr key={q.id}>
                      <td className="font-mono text-xs text-muted">
                        <Link href={`/log/${q.id}`} className="hover:text-accent-strong">
                          {utcDate(q.startTime)} {utcTime(q.startTime)}
                        </Link>
                      </td>
                      <td className="font-mono text-xs">{q.band.toLowerCase()}</td>
                      <td className="text-xs">{displayMode(q.mode, q.submode)}</td>
                      <td className="font-mono text-xs text-muted">
                        {q.rstSent}/{q.rstRcvd}
                      </td>
                      <td className="text-right">
                        <span className="inline-flex gap-1">
                          {q.lotwRcvd && <Badge tone="ok">LoTW</Badge>}
                          {q.qslRcvd === "CONFIRMED" && <Badge tone="ok">Card</Badge>}
                          {q.eqslRcvd && <Badge tone="info">eQSL</Badge>}
                          {q.qrzRcvd && <Badge tone="info">QRZ</Badge>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
        <div className="space-y-4">
          <Callbook call={call} />
          <Card title="How you hear them">
            {heard.length === 0 ? (
              <p className="text-sm text-muted">Not in the decodes kept on this station.</p>
            ) : (
              heard.map((h) => (
                <div key={h.band} className="flex justify-between py-0.5 text-sm">
                  <span className="font-mono">{h.band.toLowerCase()}</span>
                  <span className="text-xs text-muted">
                    {h.n}× · best {h.best} dB · {utcDate(h.last)}
                  </span>
                </div>
              ))
            )}
          </Card>
          <Card title="How they hear you">
            {heardMe.length === 0 ? (
              <p className="text-sm text-muted">No PSKReporter reports from {call}.</p>
            ) : (
              heardMe.map((h) => (
                <div key={h.id} className="flex justify-between py-0.5 text-sm">
                  <span className="font-mono text-xs">{utcDateTime(h.at)}</span>
                  <span className="text-xs text-muted">
                    {h.band.toLowerCase()} · {h.snr ?? "—"} dB
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
