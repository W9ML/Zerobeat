"use client";
/**
 * One Operate card in a window of its own (app/pop/[card]), live from the same engine
 * feed, so it can sit on another screen. "map" is the path map of the station being
 * worked, as large as the window.
 */
import { useState } from "react";

import { Card, Notice } from "@/components/ui";
import { useLive } from "@/lib/client/live";
import { usePopoutBeacon } from "@/lib/client/popout";
import { DistanceUnitContext } from "@/lib/client/units";

import { StationCard } from "./station-card";
import { sideSlots, useAction } from "./view";

export function PopOutView({ card, canOperate }: { card: string; canOperate: boolean }) {
  const { snap, decodes, activity, needed, keyLines, status } = useLive();
  const act = useAction();
  const [js8Sel, setJs8Sel] = useState<string | null>(null);
  usePopoutBeacon(card);

  const slot = snap && card !== "map" ? sideSlots({ snap, act, canOperate, decodes, needed, activity, keyLines, js8Sel, setJs8Sel }).find((s) => s.id === card) : undefined;
  const label = card === "map" ? "Map" : (slot?.label ?? card);

  if (!snap) {
    return (
      <div className="p-4">
        <Notice tone={status === "engine-down" ? "bad" : "info"}>{status === "engine-down" ? "The engine is not running." : "Connecting to the engine…"}</Notice>
      </div>
    );
  }
  let body;
  if (card === "map") {
    const keys = !!snap.keyboard.mode;
    const call = keys ? snap.keyboard.ctx.hisCall : snap.qso?.them;
    body = call && /\d/.test(call) ? <StationCard call={call} grid={keys ? null : (snap.qso?.grid ?? null)} band={snap.band} mode={snap.keyboard.mode ?? snap.mode} mapOnly /> : <Empty text="The map shows the station you are working, and follows each new contact." />;
  } else if (!slot) {
    body = <Empty text={`${label} is not a card in ${snap.mode}.`} />;
  } else {
    body = slot.node ?? <Empty text={`${slot.label} shows ${slot.hint ?? "when there is something to show"}.`} />;
  }
  return (
    <DistanceUnitContext.Provider value={snap.distanceUnit ?? "mi"}>
      <div className="space-y-3 p-3">
        {act.err && (
          <Notice tone="bad">
            {act.err}{" "}
            <button className="ml-2 underline" onClick={act.clear}>
              dismiss
            </button>
          </Notice>
        )}
        {body}
      </div>
    </DistanceUnitContext.Provider>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <Card>
      <p className="text-sm text-muted">{text}</p>
    </Card>
  );
}
