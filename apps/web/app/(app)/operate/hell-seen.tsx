"use client";
/**
 * Above the Hell tape: what the engine hears at the marker (hell-detect.ts), with a button
 * to switch to that Hell mode, or to put the marker on the signal's centre, when they differ
 * from what is set. A CW station on the marker prints as fat sloping bars, so it is named.
 */
import { useEffect, useState } from "react";

import { useHellSeen, type HellSpeed } from "@/lib/client/live";

type Run = (path: string, body?: unknown) => Promise<boolean>;

/** An answer this old is not shown: the signal has gone. */
const SHOW_MS = 90_000;

export function HellSeenBar({
  rxHz,
  speed,
  reverse,
  labelOf,
  canOperate,
  run,
}: {
  rxHz: number;
  speed: HellSpeed;
  reverse: boolean;
  labelOf: (s: HellSpeed) => string;
  canOperate: boolean;
  run: Run;
}) {
  const seen = useHellSeen();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!seen) return null;
  const age = now - seen.at;
  if (age > SHOW_MS) return null;

  const what =
    seen.kind === "hell"
      ? `${labelOf(seen.speed!)}${seen.reverse ? ", reversed" : ""}`
      : seen.kind === "cw"
        ? "CW, not Hell (it prints as sloping bars)"
        : "a signal that isn't Hell, or too weak to tell";
  const when = age < 4_000 ? "now" : `${Math.round(age / 1000)} s ago`;
  const otherMode = seen.kind === "hell" && (seen.speed !== speed || !!seen.reverse !== reverse);
  const offBy = Math.abs(seen.centreHz - rxHz);
  const btn = "rounded-md border border-line-strong bg-panel-2 px-2 py-0.5 text-[11px] text-fg hover:border-accent";

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5 text-xs" data-hell-seen={seen.kind === "hell" ? seen.speed : seen.kind}>
      <span className="text-muted">
        At the marker: <span className={seen.kind === "hell" ? "font-medium text-fg" : "text-fg"}>{what}</span>
        <span className="text-subtle">
          {" "}
          · {seen.centreHz} Hz · {when}
        </span>
      </span>
      {canOperate && otherMode && (
        <button
          type="button"
          className={btn}
          onClick={() =>
            void run("/keyboard/context", {
              hellSpeed: seen.speed,
              hellReverse: !!seen.reverse,
            })
          }
        >
          Switch to {labelOf(seen.speed!)}
          {seen.reverse ? ", reversed" : ""}
        </button>
      )}
      {canOperate && seen.kind === "hell" && offBy >= 10 && (
        <button type="button" className={btn} onClick={() => void run("/tx-offset", { hz: seen.centreHz })}>
          Move the marker to {seen.centreHz} Hz
        </button>
      )}
    </div>
  );
}
