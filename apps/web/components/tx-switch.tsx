"use client";
/**
 * The transmit master switch, wherever the operator is. Arming asks first; disarming is
 * immediate and also stops any automatic run and the current contact.
 */
import { useState } from "react";

import { control, type EngineSnapshot } from "@/lib/client/live";

import { confirmDialog } from "./overlays";
import { cn, Dot } from "./ui";

export function TxSwitch({ snap, size = "md", disabled }: { snap: EngineSnapshot | null; size?: "sm" | "md"; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const keyed = !!snap?.radio.transmitting;
  const armed = !!snap?.tx.allowed;

  async function toggle() {
    if (!snap) return;
    if (
      !armed &&
      !(await confirmDialog({
        title: "Arm the transmitter?",
        body: (
          <>
            RF power is <span className="font-mono text-fg">{snap.radio.rfPowerPct}%</span>. Nothing keys until you call a station or start an automatic mode; WSPR beacons and JS8 automatic replies count as automatic.
          </>
        ),
        confirmLabel: "Arm transmit",
      }))
    )
      return;
    setBusy(true);
    setErr(null);
    const r = await control("/tx-allow", { allowed: !armed });
    setBusy(false);
    if (!r.ok) setErr(r.error ?? "failed");
  }

  const label = keyed ? "TX" : armed ? "TX armed" : "TX off";
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={armed}
        disabled={busy || disabled || !snap || snap.ft0}
        onClick={toggle}
        title={snap?.ft0 ? "Release FT-0 first" : armed ? "Click to turn transmit off" : "Click to arm the transmitter"}
        className={cn(
          "inline-flex items-center gap-2 rounded-md border font-semibold transition-colors disabled:opacity-50",
          size === "sm" ? "h-7 px-2.5 text-xs" : "h-8.5 px-3.5 text-sm",
          keyed ? "border-bad bg-bad text-white" : armed ? "border-accent bg-accent-soft text-accent-strong hover:bg-accent/30" : "border-line-strong bg-panel-2 text-muted hover:text-fg",
        )}
      >
        <span className={cn("relative inline-flex h-4 w-7 items-center rounded-full transition-colors", armed ? "bg-accent" : "bg-panel-3")}>
          <span className={cn("inline-block size-3 rounded-full bg-white transition-transform", armed ? "translate-x-3.5" : "translate-x-0.5")} />
        </span>
        {keyed && <Dot tone="bad" pulse />}
        {busy ? "…" : label}
      </button>
      {err && <span className="text-xs text-bad">{err}</span>}
    </span>
  );
}
