"use client";
/**
 * The slot clock across the top of the decodes, as WSJT-X's progress bar: it fills left to
 * right over each period, says how far in it is and whether the slot is even or odd, and
 * turns transmit red while the radio is keyed. It runs on the engine's clock (each
 * snapshot carries the engine's time), so a browser whose clock is off still shows the
 * slots the station is really working in.
 */
import { useEffect, useRef } from "react";

import { cn } from "@/components/ui";

export function CycleBar({ periodSec, engineNow, transmitting, className }: { periodSec: number; engineNow: number | undefined; transmitting: boolean; className?: string }) {
  const fill = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const offset = useRef(0);

  // Engine time minus browser time, taken when a snapshot arrives (it is rendered at once).
  useEffect(() => {
    if (typeof engineNow === "number") offset.current = engineNow - Date.now();
  }, [engineNow]);

  useEffect(() => {
    let raf = 0;
    const P = periodSec * 1000;
    const tick = () => {
      const t = Date.now() + offset.current;
      const into = ((t % P) + P) % P;
      const slot = Math.floor(t / P);
      if (fill.current) fill.current.style.width = `${(into / P) * 100}%`;
      if (label.current) label.current.textContent = `${periodSec < 10 ? (Math.floor(into / 100) / 10).toFixed(1) : Math.floor(into / 1000)} / ${periodSec} s · ${slot % 2 === 0 ? "even" : "odd"}`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [periodSec]);

  return (
    <div className={cn("relative h-4 overflow-hidden border-b border-line bg-panel-2", className)} role="timer" aria-label="Position in the current period">
      <div ref={fill} className={cn("absolute inset-y-0 left-0", transmitting ? "bg-bad/80" : "bg-accent/55")} />
      <span ref={label} className="absolute inset-0 flex items-center justify-end pr-2 font-mono text-[10px] text-subtle tabular" />
      {transmitting && <span className="absolute inset-y-0 left-2 flex items-center text-[10px] font-semibold text-white">TX</span>}
    </div>
  );
}
