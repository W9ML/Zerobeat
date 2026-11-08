"use client";
import Link from "next/link";

import { Badge, Card, Dot } from "@/components/ui";
import { useLive } from "@/lib/client/live";
import { mhz } from "@/lib/format";

export function LivePanel() {
  const { snap, status, decodes } = useLive();
  const last = snap?.lastWindow;
  return (
    <Card title="Station" actions={<Link href="/operate" className="text-xs text-accent-strong hover:underline">Operate</Link>}>
      {!snap ? (
        <p className="text-sm text-muted">{status === "engine-down" ? "The engine is not running." : "Connecting…"}</p>
      ) : (
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <Dot tone={snap.radio.link === "connected" ? "ok" : "warn"} pulse={snap.radio.link !== "connected"} />
            {snap.radio.link === "connected" ? `${snap.radio.model} ${snap.radio.nickname ?? ""}` : snap.radio.detail || snap.radio.link}
          </div>
          <div className="font-mono text-lg">
            {mhz(snap.dialHz)} <span className="text-sm text-muted">{snap.band} {snap.mode}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {snap.auto.mode !== "off" ? <Badge tone="info">Auto {snap.auto.mode}</Badge> : <Badge>Manual</Badge>}
            {snap.tx.allowed ? <Badge tone="accent">TX armed</Badge> : <Badge>TX off</Badge>}
            {snap.qso && !["done", "abandoned"].includes(snap.qso.phase) && <Badge tone="me">Working {snap.qso.them}</Badge>}
          </div>
          {last && <div className="text-xs text-muted">{last.skipped ? last.skipped : `${last.decodes} decodes last window · ${decodes.length} in view`}</div>}
        </div>
      )}
    </Card>
  );
}
