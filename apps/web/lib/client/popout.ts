"use client";
/**
 * Cards opened in their own window. Each pop-out window says it is alive on a
 * BroadcastChannel every couple of seconds; the Operate page leaves a one-line stub where
 * the card was while it hears from it, and "Bring back" asks the window to close.
 */
import { useEffect, useState } from "react";

type Msg = { type: "alive" | "gone" | "close"; id: string } | { type: "who" };

const CHANNEL = "ds-popout";
const STALE_MS = 5000;

function channel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
}

export function openPopout(id: string): void {
  window.open(`/pop/${encodeURIComponent(id)}`, `ds-pop-${id}`, "popup,width=480,height=720");
}

export function bringBack(id: string): void {
  const c = channel();
  c?.postMessage({ type: "close", id } satisfies Msg);
  c?.close();
}

/** The cards open in their own windows right now. */
export function usePopped(): Set<string> {
  const [seen, setSeen] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    const c = channel();
    if (!c) return;
    c.onmessage = (e: MessageEvent<Msg>) => {
      const m = e.data;
      if (m.type === "alive") setSeen((s) => new Map(s).set(m.id, Date.now()));
      else if (m.type === "gone")
        setSeen((s) => {
          const n = new Map(s);
          n.delete(m.id);
          return n;
        });
    };
    c.postMessage({ type: "who" } satisfies Msg);
    const t = setInterval(
      () =>
        setSeen((s) => {
          const now = Date.now();
          const n = new Map([...s].filter(([, at]) => now - at < STALE_MS));
          return n.size === s.size ? s : n;
        }),
      2000,
    );
    return () => {
      clearInterval(t);
      c.close();
    };
  }, []);
  return new Set(seen.keys());
}

/** In a pop-out window: say so, and close when the Operate page brings the card back. */
export function usePopoutBeacon(id: string): void {
  useEffect(() => {
    const c = channel();
    if (!c) return;
    const alive = () => c.postMessage({ type: "alive", id } satisfies Msg);
    c.onmessage = (e: MessageEvent<Msg>) => {
      if (e.data.type === "who") alive();
      else if (e.data.type === "close" && e.data.id === id) window.close();
    };
    alive();
    const t = setInterval(alive, 2000);
    const gone = () => c.postMessage({ type: "gone", id } satisfies Msg);
    window.addEventListener("pagehide", gone);
    return () => {
      clearInterval(t);
      window.removeEventListener("pagehide", gone);
      gone();
      c.close();
    };
  }, [id]);
}
