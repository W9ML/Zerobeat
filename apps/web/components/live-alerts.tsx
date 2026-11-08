"use client";
/**
 * Turns live engine events into toasts on every page: a needed station calling CQ (with a
 * Call button for operators), and station faults.
 */
import { useEffect } from "react";

import { control, onLiveEvent, useLive } from "@/lib/client/live";

import { toast } from "./overlays";

export function LiveAlerts({ canOperate }: { canOperate: boolean }) {
  useLive(); // make sure the feed is connected on every page
  useEffect(
    () =>
      onLiveEvent((e) => {
        if (e.t === "fault") {
          toast({ title: "Station fault", body: e.reason, tone: "bad", timeout: 0, action: { label: "Open Operate", href: "/operate" } });
          return;
        }
        const a = e.alert;
        // A cluster or RBN spot has no decode to answer: its button tunes to the spot.
        const spotted = a.windowIndex < 0;
        toast({
          title: a.headline,
          body: (
            <>
              <span className="font-mono text-fg">{a.callsign}</span>{" "}
              {spotted ? `spotted on ${a.band.toLowerCase()}${a.mode !== "spot" ? ` ${a.mode}` : ""}${a.spotHz ? ` at ${(a.spotHz / 1e6).toFixed(3)} MHz` : ""}` : `calling CQ on ${a.band.toLowerCase()} ${a.mode}, ${a.snr} dB`}
              {a.reasons.length > 1 && <span className="block text-subtle">{a.reasons.slice(1).join(" · ")}</span>}
            </>
          ),
          tone: "ok",
          timeout: 45_000,
          action: canOperate
            ? spotted
              ? {
                  label: "Tune",
                  onClick: async () => {
                    const r = await control("/spots/tune", { freqHz: a.spotHz, mode: a.mode === "spot" ? null : a.mode });
                    if (!r.ok) toast({ title: `Could not tune to ${a.callsign}`, body: r.error, tone: "bad" });
                  },
                }
              : {
                label: `Call ${a.callsign}`,
                onClick: async () => {
                  const r = await control("/call", { callsign: a.callsign, offsetHz: a.offsetHz, windowIndex: a.windowIndex, snr: a.snr, grid: a.grid, text: a.text });
                  if (!r.ok) toast({ title: `Could not call ${a.callsign}`, body: r.error, tone: "bad" });
                },
              }
            : { label: "Open Operate", href: "/operate" },
        });
      }),
    [canOperate],
  );
  return null;
}
