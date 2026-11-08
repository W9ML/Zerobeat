import Link from "next/link";

import { computeAwards } from "@zerobeat/core/log/awards";
import { heardNeverWorked } from "@zerobeat/core/log/heard-entities";

import { Card, cn, PageHeader } from "@/components/ui";
import { utcDate } from "@/lib/format";
import { requireUser } from "@/lib/server/auth";
import { pageScope } from "@/lib/server/scope";
import { db } from "@/lib/server/ctx";

export const metadata = { title: "Awards" };

const BANDS = ["160M", "80M", "40M", "30M", "20M", "17M", "15M", "12M", "10M", "6M"];

export default async function AwardsPage({ searchParams }: { searchParams: Promise<{ award?: string; mode?: string }> }) {
  const scope = await pageScope(await requireUser());
  const sp = await searchParams;
  const awards = computeAwards(db(), { stationId: scope.stationId, mode: sp.mode || undefined });
  const sel = awards.find((a) => a.id === sp.award) ?? awards[0]!;
  const heard = sel.id === "dxcc" ? heardNeverWorked(db(), scope.stationId) : [];
  const heardKeys = new Set(heard.map((h) => String(h.dxcc)));
  const q = (id: string) => `/awards?award=${id}${sp.mode ? `&mode=${sp.mode}` : ""}`;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Awards"
        subtitle="Confirmed means a paper card or LoTW. eQSL and QRZ confirmations show on each contact but are not counted."
        actions={
          <div className="flex overflow-hidden rounded-md border border-line-strong text-sm">
            {["", "CW", "PHONE", "DIGITAL", "FT8", "FT4"].map((m) => (
              <Link key={m} href={`/awards?award=${sel.id}${m ? `&mode=${m}` : ""}`} className={cn("px-3 py-1.5", (sp.mode ?? "") === m ? "bg-panel-3 text-fg" : "bg-panel-2 text-muted hover:text-fg")}>
                {m === "" ? "All modes" : m === "PHONE" ? "Phone" : m === "DIGITAL" ? "Digital" : m}
              </Link>
            ))}
          </div>
        }
      />
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {awards.map((a) => (
          <Link key={a.id} href={q(a.id)} className={cn("rounded-lg border bg-panel px-4 py-3 transition-colors", a.id === sel.id ? "border-accent" : "border-line hover:border-line-strong")}>
            <div className="text-xs text-muted">{a.name}</div>
            <div className="mt-1 font-mono text-xl font-semibold tabular">
              {a.confirms === false ? (
                a.worked
              ) : (
                <>
                  {a.confirmed}
                  <span className="text-sm text-muted">/{a.worked}</span>
                </>
              )}
              {a.total && <span className="text-sm text-subtle"> of {a.total}</span>}
            </div>
            {a.total && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel-3">
                <div className="h-full bg-ok" style={{ width: `${(a.confirmed / a.total) * 100}%` }} />
              </div>
            )}
          </Link>
        ))}
      </div>
      <Card title={sel.confirms === false ? `${sel.name}: ${sel.worked} worked` : `${sel.name}: ${sel.confirmed} confirmed, ${sel.worked} worked`} pad={false}>
        {sel.outside?.length ? (
          <div className="border-b border-line px-3 py-2 text-xs text-muted">
            Not counted: {sel.outside.map((e) => e.label).join(", ")} ({sel.outside.length === 1 ? "a deleted entity" : "deleted entities"}, or an entity this station's country file no longer lists).
          </div>
        ) : null}
        <div className="max-h-[65vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-panel-2 text-xs text-muted">
              <tr>
                <th className="px-3 py-2 text-left font-medium">{sel.id === "dxcc" ? "Entity" : sel.id === "pota" ? "Park" : "Name"}</th>
                {BANDS.map((b) => (
                  <th key={b} className="px-1 py-2 text-center font-mono font-medium">
                    {b.toLowerCase()}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sel.entries.map((e) => (
                <tr key={e.key} className="border-t border-line hover:bg-panel-2">
                  <td className={cn("px-3 py-1", e.status === "confirmed" ? "text-fg" : "text-muted")}>{e.label}</td>
                  {BANDS.map((b) => (
                    <td key={b} className="px-1 py-1 text-center">
                      {e.bands[b] === "confirmed" ? <span className="inline-block size-2.5 rounded-sm bg-ok" title="confirmed" /> : e.bands[b] === "worked" ? <span className="inline-block size-2.5 rounded-sm border border-warn" title="worked" /> : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {sel.id === "dxcc" && heard.length > 0 && (
        <Card title={`Heard here, never worked (${heard.length})`} className="mt-4" pad={false}>
          <p className="border-b border-line px-4 py-2 text-xs text-muted">What this antenna has decoded and the log still needs, with the band and UTC hour it is heard best. Your own receiver, not a propagation model.</p>
          <table className="w-full text-sm">
            <tbody>
              {heard.slice(0, 25).map((h) => (
                <tr key={h.dxcc} className="border-b border-line last:border-0">
                  <td className="px-4 py-1.5 text-fg">{h.name}</td>
                  <td className="px-2 py-1.5 font-mono text-xs text-muted">
                    {h.best.band.toLowerCase()} {String(h.best.hourOfDay).padStart(2, "0")}Z
                  </td>
                  <td className="px-2 py-1.5 text-xs text-muted">
                    heard on {h.best.days} day{h.best.days === 1 ? "" : "s"}
                    {h.best.bestSnr !== null ? `, best ${h.best.bestSnr} dB` : ""}
                  </td>
                  <td className="px-4 py-1.5 text-right text-xs text-subtle">
                    last {utcDate(h.lastAt)}
                    {h.lastCall ? ` · ${h.lastCall}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {heard.length > 25 && <p className="px-4 py-2 text-xs text-subtle">and {heard.length - 25} more heard less often.</p>}
        </Card>
      )}
      {sel.missing.length > 0 && (
        <details className="mt-4 rounded-lg border border-line bg-panel">
          <summary className="cursor-pointer px-4 py-2.5 text-[13px] font-semibold text-fg">
            {sel.id === "dxcc" ? `Never heard here, not worked (${sel.missing.filter((m) => !heardKeys.has(m.key)).length})` : `Not worked yet (${sel.missing.length})`}
          </summary>
          <div className="flex flex-wrap gap-1.5 px-4 pb-4 text-xs">
            {sel.missing
              .filter((m) => sel.id !== "dxcc" || !heardKeys.has(m.key))
              .map((m) => (
                <span key={m.key} className="rounded-sm bg-panel-2 px-1.5 py-0.5 text-muted">
                  {m.label}
                </span>
              ))}
          </div>
        </details>
      )}
    </div>
  );
}
