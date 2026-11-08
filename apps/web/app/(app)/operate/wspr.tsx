"use client";
/**
 * WSPR on the Operate page: who the station heard in each two-minute period, how far
 * away, and when the next beacon goes out. Settings (share of periods, reported power,
 * WSPRnet) are under Settings → Logbook services → WSPR and WSPRnet.
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Badge, Card, cn } from "@/components/ui";
import { gridDistanceKm } from "@zerobeat/core/ham/grid";
import { useLive, type EngineSnapshot, type WsprSpot } from "@/lib/client/live";
import { utcTime } from "@/lib/format";

import { CycleBar } from "./cycle-bar";
import { inUnit } from "@/lib/distance";

export function WsprPanel({ snap }: { snap: EngineSnapshot }) {
  const { wsprSpots: live } = useLive();
  const [initial, setInitial] = useState<WsprSpot[]>([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    void fetch("/api/engine/wspr", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { spots: WsprSpot[] } | null) => j && setInitial(j.spots))
      .catch(() => {});
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const spots = useMemo(() => {
    const seen = new Set<string>();
    return [...initial, ...live]
      .filter((s) => {
        const k = `${s.at}|${s.message}|${s.freqHz}`;
        return seen.has(k) ? false : (seen.add(k), true);
      })
      .sort((a, b) => b.at - a.at || b.snrDb - a.snrDb)
      .slice(0, 200);
  }, [initial, live]);
  const w = snap.wspr;
  const myGrid = snap.station?.grid ?? "";
  const periodEnd = Math.ceil(now / 120_000) * 120_000;
  const status = w.transmittingPeriod
    ? `beaconing now, until ${utcTime(w.transmittingPeriod + 111_600, true)}Z`
    : w.nextTx
      ? `next beacon at ${utcTime(w.nextTx + 1000, true)}Z, in ${Math.max(0, Math.ceil((w.nextTx - now) / 1000))} s`
      : `listening; this period ends in ${Math.ceil((periodEnd - now) / 1000)} s`;
  return (
    <Card
      pad={false}
      title={
        <span className="flex items-center gap-2">
          WSPR
          <span className="text-xs font-normal text-muted">
            {snap.radio.link !== "connected" ? "radio disconnected" : status}
            {snap.tx.blocked && w.nextTx ? ` (not while ${snap.tx.blocked})` : ""}
          </span>
        </span>
      }
      actions={
        <Link href="/settings/services" className="text-xs text-muted hover:text-fg">
          Beacon and WSPRnet settings
        </Link>
      }
    >
      <CycleBar periodSec={120} engineNow={snap.now} transmitting={snap.radio.transmitting} />
      {w.lastDecode && (
        <div className="border-b border-line px-3 py-1.5 text-[11px] text-subtle">
          {utcTime(w.lastDecode.at)}Z period: {w.lastDecode.error ? w.lastDecode.error : `${w.lastDecode.count} decoded in ${(w.lastDecode.ms / 1000).toFixed(1)} s`}
        </div>
      )}
      {spots.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted">No WSPR stations heard yet. Decodes appear 114 s into each even-minute period.</div>
      ) : (
        <div className="max-h-[62vh] overflow-y-auto font-mono text-[12px]">
          <div className="sticky top-0 grid grid-cols-[44px_34px_34px_76px_30px_1fr_52px_34px_60px_auto] gap-2 border-b border-line bg-panel-2 px-3 py-1 font-sans text-[11px] text-subtle">
            <span>UTC</span>
            <span className="text-right">dB</span>
            <span className="text-right">DT</span>
            <span className="text-right">MHz</span>
            <span className="text-right">Dr</span>
            <span>Call</span>
            <span>Grid</span>
            <span className="text-right">dBm</span>
            <span className="text-right">{snap.distanceUnit ?? "mi"}</span>
            <span />
          </div>
          {spots.map((s) => {
            const km = s.grid && myGrid ? gridDistanceKm(myGrid, s.grid) : null;
            return (
              <div key={`${s.at}-${s.message}-${s.freqHz}`} className={cn("grid grid-cols-[44px_34px_34px_76px_30px_1fr_52px_34px_60px_auto] items-center gap-2 px-3 py-[3px]")}>
                <span className="text-subtle">{utcTime(s.at)}</span>
                <span className={cn("text-right tabular", s.snrDb >= -20 ? "text-fg" : "text-muted")}>{s.snrDb}</span>
                <span className="text-right tabular text-subtle">{s.dtSec.toFixed(1)}</span>
                <span className="text-right tabular text-muted">{(s.freqHz / 1e6).toFixed(6)}</span>
                <span className="text-right tabular text-subtle">{s.driftHz}</span>
                <span className="truncate text-fg">{s.callsign ?? s.message}</span>
                <span className="text-muted">{s.grid ?? ""}</span>
                <span className="text-right tabular text-muted">{s.dbm}</span>
                <span className="text-right tabular text-muted">{km !== null ? inUnit(km, snap.distanceUnit ?? "mi").toLocaleString("en-US") : ""}</span>
                <span className="font-sans">{s.uploaded === true ? <Badge tone="ok">sent</Badge> : s.uploaded === false ? <Badge tone="warn">not sent</Badge> : null}</span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
