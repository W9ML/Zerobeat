"use client";
/** Operate-page panels: stations you need on the air, who is hearing you, and DX spots. */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { bandForHz as bandOfHz } from "@zerobeat/core/ham/bands";

import { toast } from "@/components/overlays";
import { Badge, Button, Card, cn } from "@/components/ui";
import { FoldCard } from "@/components/fold";
import { api } from "@/lib/client/api";
import { control, useLive, type EngineSnapshot, type NeededAlert, type Spot } from "@/lib/client/live";
import { ago, utcTime } from "@/lib/format";
import { useDistanceUnit } from "@/lib/client/units";
import { fmtDistance } from "@/lib/distance";

interface NeverWorked {
  dxcc: number;
  name: string;
  best: { band: string; hourOfDay: number; days: number; bestSnr: number | null };
}

/** Entities heard here and never worked whose best hour is now or within three hours. */
function useComingUp(): NeverWorked[] {
  const [list, setList] = useState<NeverWorked[]>([]);
  useEffect(() => {
    let live = true;
    const load = () =>
      api<{ entities: NeverWorked[] }>("/api/heard/never-worked?limit=100")
        .then((r) => live && setList(r.entities))
        .catch(() => {});
    void load();
    const t = setInterval(load, 15 * 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  const h = new Date().getUTCHours();
  return list
    .map((e) => ({ e, ahead: (e.best.hourOfDay - h + 24) % 24 }))
    .filter((x) => x.ahead <= 3 && x.e.best.days >= 2)
    .sort((a, b) => a.ahead - b.ahead || b.e.best.days - a.e.best.days)
    .slice(0, 3)
    .map((x) => x.e);
}

export function WantedCard({ needed, canOperate }: { needed: NeededAlert[]; canOperate: boolean }) {
  const fresh = needed.filter((n) => Date.now() - n.at < 15 * 60_000);
  const soon = useComingUp();
  if (!fresh.length && !soon.length) return null;
  return (
    <Card title="Wanted on the air">
      <div className="space-y-2">
        {!fresh.length && <p className="text-xs text-muted">Nobody the log needs is calling right now.</p>}
        {fresh.map((n) => (
          <div key={`${n.callsign}-${n.band}`} className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Link href={`/call/${encodeURIComponent(n.callsign)}`} className="font-mono font-medium hover:text-accent-strong">
                  {n.callsign}
                </Link>
                <span className="text-xs text-muted">
                  {n.band.toLowerCase()} · {n.snr} dB · {ago(n.at)}
                </span>
              </div>
              <div className="truncate text-xs text-ok">{n.reasons.join(" · ")}</div>
            </div>
            {canOperate && (
              <Button
                size="sm"
                variant="primary"
                onClick={async () => {
                  const r = n.spotHz
                    ? await control("/spots/tune", { freqHz: n.spotHz, mode: n.mode })
                    : await control("/call", { callsign: n.callsign, offsetHz: n.offsetHz, windowIndex: n.windowIndex, snr: n.snr, grid: n.grid, text: n.text });
                  if (!r.ok) toast({ title: n.spotHz ? `Could not tune to ${n.callsign}` : `Could not call ${n.callsign}`, body: r.error, tone: "bad" });
                }}
                title={n.spotHz ? `Spotted on ${(n.spotHz / 1e6).toFixed(4)} MHz${n.mode !== "spot" ? ` ${n.mode}` : ""}` : undefined}
              >
                {n.spotHz ? "Tune" : "Call"}
              </Button>
            )}
          </div>
        ))}
      </div>
      {soon.length > 0 && (
        <div className="mt-3 border-t border-line pt-2 text-xs">
          <div className="mb-1 text-subtle">Heard here, never worked, usually about now:</div>
          {soon.map((e) => (
            <div key={e.dxcc} className="flex justify-between gap-2">
              <span className="text-fg">{e.name}</span>
              <span className="font-mono text-muted">
                {e.best.band.toLowerCase()} {String(e.best.hourOfDay).padStart(2, "0")}Z · {e.best.days} days
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

interface Heard {
  count: number;
  farthest: { receiver: string; distance_km: number | null; continent: string | null } | null;
  continents: string[];
  reports: { receiver: string; grid: string | null; band: string; snr: number | null; distance_km: number | null; continent: string | null; at: number }[];
}

export function HeardByCard({ lastTxAt, canOperate }: { lastTxAt: number | null; canOperate: boolean }) {
  const unit = useDistanceUnit();
  const [data, setData] = useState<Heard | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api<Heard>("/api/engine/heard?minutes=60"));
    } catch {
      setData(null);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const recentTx = lastTxAt && Date.now() - lastTxAt < 60 * 60_000;
  const summary = !data || data.count === 0 ? (recentTx ? "no reports yet" : "after you transmit") : `${data.count} station${data.count === 1 ? "" : "s"}${data.farthest?.distance_km != null ? ` · farthest ${data.farthest.receiver} ${fmtDistance(data.farthest.distance_km, unit)}` : ""}`;
  return (
    <FoldCard
      id="heard"
      title="Heard by"
      summary={summary}
      actions={
        canOperate && recentTx ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const r = await api<{ detail: string }>("/api/engine/heard/refresh", { body: {} }).catch((e) => ({ detail: (e as Error).message }));
              setNote(r.detail);
              void load();
            }}
          >
            Check now
          </Button>
        ) : null
      }
    >
      {!data || data.count === 0 ? (
        <p className="text-sm text-muted">
          {recentTx ? "No PSKReporter reports of your signal in the last hour yet. Reports arrive a few minutes after you transmit." : "Shows who received your signal, from PSKReporter, after you transmit."}
        </p>
      ) : (
        <div className="space-y-2">
          <div className="text-sm">
            <span className="font-mono text-lg text-fg">{data.count}</span> <span className="text-muted">stations heard you in the last hour</span>
          </div>
          {data.farthest?.distance_km != null && (
            <div className="text-xs text-muted">
              Farthest: <span className="font-mono text-fg">{data.farthest.receiver}</span> at {fmtDistance(data.farthest.distance_km, unit)}
            </div>
          )}
          <div className="flex flex-wrap gap-1">
            {data.continents.map((c) => (
              <Badge key={c} tone="info">
                {c}
              </Badge>
            ))}
          </div>
          <div className="max-h-40 overflow-y-auto font-mono text-[12px]">
            {data.reports.slice(0, 30).map((r) => (
              <div key={`${r.receiver}-${r.band}`} className="flex justify-between gap-2 py-0.5">
                <span className="text-fg">{r.receiver}</span>
                <span className="text-muted">
                  {r.snr ?? "—"} dB · {r.distance_km != null ? fmtDistance(r.distance_km, unit) : r.grid ?? ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {note && <p className="mt-2 text-xs text-subtle">{note}</p>}
    </FoldCard>
  );
}

/** DX cluster and RBN spots: the radio's band by default, newest first; click to go there. */
export function SpotsCard({ snap, canOperate }: { snap: EngineSnapshot; canOperate: boolean }) {
  const { spots: live } = useLive();
  const [initial, setInitial] = useState<Spot[]>([]);
  const [status, setStatus] = useState<{ id: string; state: string; detail: string }[]>([]);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let gone = false;
    const load = () =>
      fetch("/api/engine/spots", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { spots: Spot[]; status: { id: string; state: string; detail: string }[] } | null) => {
          if (gone || !j) return;
          setInitial(j.spots);
          setStatus(j.status);
        })
        .catch(() => {});
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, []);
  const me = snap.station?.callsign ?? "";
  const spots = useMemo(() => {
    const byKey = new Map<string, Spot>();
    for (const s of [...initial, ...live]) byKey.set(`${s.call}|${s.freqHz}|${s.spotter}|${s.at}`, s);
    const bandOf = (hz: number) => bandOfHz(hz)?.name ?? null;
    return [...byKey.values()]
      .filter((s) => all || bandOf(s.freqHz) === snap.band)
      .sort((a, b) => b.at - a.at)
      .slice(0, 40);
  }, [initial, live, all, snap.band]);
  if (!status.length && !spots.length) return null;
  const down = status.filter((s) => s.state !== "connected");
  return (
    <FoldCard
      id="spots"
      title="Spots"
      summary={spots.length ? `${spots.length} ${all ? "on all bands" : `on ${(snap.band ?? "this band").toLowerCase()}`}` : "none on this band"}
      defaultOpen={spots.length > 0}
      tone={down.length ? "warn" : undefined}
      actions={
        <div className="flex overflow-hidden rounded-md border border-line-strong text-xs">
          {([false, true] as const).map((k) => (
            <button key={String(k)} onClick={() => setAll(k)} className={cn("px-2.5 py-1", all === k ? "bg-panel-3 text-fg" : "bg-panel-2 text-muted hover:text-fg")}>
              {k ? "All bands" : (snap.band ?? "Band").toLowerCase()}
            </button>
          ))}
        </div>
      }
      pad={false}
    >
      {down.length > 0 && <div className="border-b border-line px-3 py-1.5 text-[11px] text-warn">{down.map((s) => `${s.id}: ${s.state} ${s.detail}`).join(" · ")}</div>}
      <div className="max-h-72 overflow-y-auto font-mono text-[12px]">
        {spots.length === 0 && <div className="px-3 py-4 text-center font-sans text-xs text-muted">No spots on this band yet.</div>}
        {spots.map((s) => {
          const mine = s.call === me;
          return (
            <div
              key={`${s.call}-${s.freqHz}-${s.spotter}-${s.at}`}
              onClick={() => canOperate && !mine && void control("/spots/tune", { freqHz: s.freqHz, mode: s.mode }).then((r) => !r.ok && toast({ title: "Could not tune", body: r.error, tone: "bad" }))}
              className={cn("grid grid-cols-[40px_64px_1fr_40px_30px] items-center gap-2 px-3 py-[3px]", canOperate && !mine && "cursor-pointer hover:bg-panel-3", mine && "bg-me-soft")}
              title={`${s.comment} · spotted by ${s.spotter} (${s.source === "rbn" ? "RBN" : "cluster"})`}
            >
              <span className="text-subtle">{utcTime(s.at)}</span>
              <span className="text-right tabular text-muted">{(s.freqHz / 1000).toFixed(1)}</span>
              <span className={cn("truncate", mine ? "font-semibold text-me" : "text-fg")}>
                {s.call}
                {mine && <span className="ml-1 font-sans text-[10px]">heard by {s.spotter}</span>}
              </span>
              <span className="truncate text-subtle">{s.mode ?? ""}</span>
              <span className="text-right tabular text-subtle">{s.snr ?? ""}</span>
            </div>
          );
        })}
      </div>
    </FoldCard>
  );
}
