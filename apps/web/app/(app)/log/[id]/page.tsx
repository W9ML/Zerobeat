import Link from "next/link";
import { notFound } from "next/navigation";

import { getQso } from "@zerobeat/core/log/qsos";
import { getDxcc } from "@zerobeat/core/dxcc/cty";
import { gridDistanceKm } from "@zerobeat/core/ham/grid";

import { QsoForm } from "@/components/qso-form";
import { Badge, Card, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/server/auth";
import { db, settingsStore } from "@/lib/server/ctx";
import { displayMode, mhz, utcDateTime } from "@/lib/format";

import { DeleteButton } from "./delete";
import { fmtDistance } from "@/lib/distance";
import { pageScope, ownsQso } from "@/lib/server/scope";

const SERVICE: Record<string, string> = { qrz: "QRZ Logbook", lotw: "LoTW", eqsl: "eQSL", clublog: "Club Log", wrl: "World Radio League", n3fjp: "N3FJP" };

export default async function QsoPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ edit?: string }> }) {
  const user = await requireUser();
  const scope = await pageScope(user);
  const id = (await params).id;
  const r = ownsQso(scope, id) ? getQso(db(), id) : null;
  if (!r) notFound();
  const { qso: q, sigRefs, uploads, station } = r;
  const mine = !scope.readOnly && user.role !== "VIEWER";
  const edit = (await searchParams).edit === "1" && mine;
  const entity = getDxcc().entity(q.dxcc);
  const km = q.grid && (q.myGrid ?? station?.grid) ? gridDistanceKm(q.myGrid ?? station!.grid, q.grid) : null;

  if (edit) {
    return (
      <div className="mx-auto max-w-6xl">
        <PageHeader title={`Edit ${q.callsign}`} />
        <QsoForm
          id={q.id}
          initial={{
            callsign: q.callsign,
            date: new Date(q.startTime).toISOString().slice(0, 10),
            time: new Date(q.startTime).toISOString().slice(11, 19),
            freqMHz: (q.freqHz / 1e6).toFixed(6),
            band: q.band,
            mode: q.submode ?? q.mode,
            rstSent: q.rstSent ?? "",
            rstRcvd: q.rstRcvd ?? "",
            txPowerW: q.txPowerW ? String(q.txPowerW) : "",
            grid: q.grid ?? "",
            name: q.name ?? "",
            qth: q.qth ?? "",
            state: q.state ?? "",
            county: q.county ?? "",
            email: q.email ?? "",
            parks: sigRefs.filter((s) => s.sig === "POTA").map((s) => s.ref).join(", "),
            mySigInfo: q.mySigInfo ?? "",
            notes: q.notes ?? "",
            qslSent: q.qslSent,
            qslRcvd: q.qslRcvd,
          }}
        />
      </div>
    );
  }

  const row = (k: string, v: React.ReactNode) =>
    v !== null && v !== undefined && v !== "" ? (
      <div className="flex justify-between gap-4 border-b border-line py-1.5 text-sm last:border-0">
        <span className="text-muted">{k}</span>
        <span className="text-right">{v}</span>
      </div>
    ) : null;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={<Link href={`/call/${encodeURIComponent(q.callsign)}`} className="font-mono hover:text-accent-strong">{q.callsign}</Link>}
        subtitle={`${utcDateTime(q.startTime)} · ${q.band.toLowerCase()} ${displayMode(q.mode, q.submode)}${entity ? ` · ${entity.name}` : ""}`}
        actions={
          mine ? (
            <>
              <Link href={`/log/${q.id}?edit=1`} className="text-sm text-accent-strong hover:underline">
                Edit
              </Link>
              <DeleteButton id={q.id} />
            </>
          ) : null
        }
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Contact">
          {row("Frequency", <span className="font-mono">{mhz(q.freqHz)} MHz</span>)}
          {row("Reports", `${q.rstSent ?? "—"} sent / ${q.rstRcvd ?? "—"} received`)}
          {row("Power", q.txPowerW ? `${q.txPowerW} W` : null)}
          {row("Grid", q.grid ? `${q.grid}${km ? ` · ${fmtDistance(km, settingsStore().snapshot(scope.userId)["app.distanceUnit"])}` : ""}` : null)}
          {row("Name", q.name)}
          {row("QTH", q.qth)}
          {row("State / county", [q.state, q.county].filter(Boolean).join(" / "))}
          {row("Zones", q.cqZone ? `CQ ${q.cqZone}${q.ituZone ? ` · ITU ${q.ituZone}` : ""}` : null)}
          {row("Continent", q.continent)}
          {row("Parks", sigRefs.length ? sigRefs.map((s) => s.ref).join(", ") : null)}
          {row("My park", q.mySigInfo)}
          {row("Station", station ? `${station.callsign} · ${q.myGrid ?? station.grid}` : null)}
          {row("Radio", q.radio)}
          {row("Notes", q.notes)}
        </Card>
        <div className="space-y-4">
          <Card title="Confirmations">
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={q.lotwRcvd ? "ok" : "neutral"}>LoTW {q.lotwRcvd ? "✓" : "—"}</Badge>
              <Badge tone={q.qslRcvd === "CONFIRMED" ? "ok" : "neutral"}>Card {q.qslRcvd === "CONFIRMED" ? "✓" : q.qslRcvd.toLowerCase()}</Badge>
              <Badge tone={q.eqslRcvd ? "info" : "neutral"}>eQSL {q.eqslRcvd ? "✓" : "—"}</Badge>
              <Badge tone={q.qrzRcvd ? "info" : "neutral"}>QRZ {q.qrzRcvd ? "✓" : "—"}</Badge>
            </div>
          </Card>
          <Card title="Uploads">
            {uploads.length === 0 ? (
              <p className="text-sm text-muted">Not queued for any service.</p>
            ) : (
              uploads.map((u) => row(SERVICE[u.service] ?? u.service, <span title={u.lastError ?? undefined}>{u.status === "sent" ? <Badge tone="ok">sent</Badge> : u.status === "failed" ? <Badge tone="bad">{u.lastError?.slice(0, 60) ?? "failed"}</Badge> : <Badge>{u.status}{u.attempts ? ` · ${u.attempts} tries` : ""}</Badge>}</span>))
            )}
          </Card>
          {q.transcript && (
            <Card title="Exchange">
              <pre className="overflow-x-auto font-mono text-xs leading-5 text-muted">{q.transcript}</pre>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
