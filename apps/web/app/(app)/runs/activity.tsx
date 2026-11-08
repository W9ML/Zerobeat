"use client";
/**
 * The station's activity since the engine started: contacts, brakes, runs, uploads,
 * control changes. Settings and mode changes ("listening", "contest off") are kept too,
 * shown when asked for. Operate shows only the latest line.
 */
import { useState } from "react";

import { Card, cn } from "@/components/ui";
import { useLive } from "@/lib/client/live";
import { utcTime } from "@/lib/format";

export function ActivityHistory() {
  const { activity } = useLive();
  const [all, setAll] = useState(false);
  const lines = all ? activity : activity.filter((l) => l.level !== "state");
  return (
    <Card
      title="Station activity"
      actions={
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="accent-[var(--color-accent)]" />
          Include mode and setting changes
        </label>
      }
      pad={false}
    >
      <div className="max-h-[480px] overflow-y-auto px-3 py-2 font-mono text-[12px] leading-5">
        {lines.length === 0 && <div className="text-subtle">Nothing since the engine started.</div>}
        {[...lines].reverse().map((l, i) => (
          <div key={i} className={cn(l.level === "warn" && "text-warn", l.level === "tx" && "text-accent-strong", l.level === "log" && "text-ok", (l.level === "info" || l.level === "state") && "text-muted")}>
            <span className="text-subtle">{utcTime(l.at, true)} </span>
            {l.text}
          </div>
        ))}
      </div>
    </Card>
  );
}
