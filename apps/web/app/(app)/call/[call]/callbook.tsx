"use client";
import { useEffect, useState } from "react";

import { Card } from "@/components/ui";
import { api } from "@/lib/client/api";

interface Info {
  name: string | null;
  qth: string | null;
  country: string | null;
  grid: string | null;
  email: string | null;
  lotw: boolean | null;
  eqsl: boolean | null;
  qslManager: string | null;
  source: string;
}

export function Callbook({ call }: { call: string }) {
  const [info, setInfo] = useState<Info | null | undefined>(undefined);
  useEffect(() => {
    api<{ info: Info | null }>(`/api/lookup/${encodeURIComponent(call)}`)
      .then((r) => setInfo(r.info))
      .catch(() => setInfo(null));
  }, [call]);
  const row = (k: string, v: React.ReactNode) =>
    v ? (
      <div className="flex justify-between gap-3 py-0.5 text-sm">
        <span className="text-muted">{k}</span>
        <span className="text-right">{v}</span>
      </div>
    ) : null;
  return (
    <Card title="Callbook">
      {info === undefined ? (
        <p className="text-sm text-muted">Looking up…</p>
      ) : info === null ? (
        <p className="text-sm text-muted">No callbook record.</p>
      ) : (
        <>
          {row("Name", info.name)}
          {row("QTH", info.qth)}
          {row("Country", info.country)}
          {row("Grid", info.grid)}
          {row("LoTW", info.lotw === null ? null : info.lotw ? "uses LoTW" : "no")}
          {row("eQSL", info.eqsl === null ? null : info.eqsl ? "uses eQSL" : "no")}
          {row("QSL", info.qslManager)}
          <div className="mt-2 text-xs text-subtle">from {info.source === "qrz" ? "QRZ" : "HamDB"}</div>
        </>
      )}
    </Card>
  );
}
