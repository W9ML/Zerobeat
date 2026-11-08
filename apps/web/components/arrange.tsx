"use client";
/**
 * A column of cards the operator puts in their own order by dragging a card by its title
 * bar, and opens in its own window from the ⧉ that shows on hover. The order is
 * remembered per column in this browser; a card that is not showing keeps its place.
 */
import { useEffect, useState, type ReactNode } from "react";

import { mergeOrder, placeNear } from "@/lib/arrange";
import { bringBack, openPopout } from "@/lib/client/popout";

import { cn } from "./ui";

export interface CardSlot {
  id: string;
  label: string;
  /** The card, or null when it has nothing to show right now. */
  node: ReactNode | null;
  /** When it shows, for the pop-out window while it is hidden. */
  hint?: string;
  /** On a narrow screen it goes above the waterfall. */
  lead?: boolean;
}

const key = (column: string) => `ds.order.${column}`;

export function useCardOrder(column: string, slots: CardSlot[]): { ordered: CardSlot[]; order: string[]; setOrder: (o: string[] | null) => void } {
  const [saved, setSaved] = useState<string[] | null>(null);
  useEffect(() => {
    try {
      const v: unknown = JSON.parse(localStorage.getItem(key(column)) ?? "null");
      setSaved(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);
    } catch {
      setSaved(null);
    }
  }, [column]);
  const order = mergeOrder(
    slots.map((s) => s.id),
    saved,
  );
  const setOrder = (o: string[] | null) => {
    setSaved(o);
    try {
      if (o) localStorage.setItem(key(column), JSON.stringify(o));
      else localStorage.removeItem(key(column));
    } catch {
      /* not remembered */
    }
  };
  const byId = new Map(slots.map((s) => [s.id, s]));
  return { ordered: order.map((id) => byId.get(id)!), order, setOrder };
}

/** Where a card was, while it is open in its own window. */
export function PoppedStub({ id, label }: { id: string; label: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-line px-4 py-2 text-xs text-muted">
      <span>
        <span className="text-fg">{label}</span> is in its own window
      </span>
      <button type="button" className="text-accent-strong hover:underline" onClick={() => bringBack(id)}>
        Bring back
      </button>
    </div>
  );
}

/**
 * Where a drag may start: the title bar (a fold toggle counts) or a [data-drag] area,
 * not a link, field or other button, so those still work and text still selects.
 */
function grabbable(t: HTMLElement): boolean {
  if (!t.closest("header, [data-drag]")) return false;
  if (t.closest("a, input, select, textarea, [data-nodrag]")) return false;
  const b = t.closest("button");
  return !b || b.hasAttribute("aria-expanded");
}

export function ArrangedCards({ slots, order, setOrder, popped }: { slots: CardSlot[]; order: string[]; setOrder: (o: string[] | null) => void; popped: Set<string> }) {
  const [armed, setArmed] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [mark, setMark] = useState<{ id: string; after: boolean } | null>(null);
  const end = () => {
    setArmed(null);
    setDrag(null);
    setMark(null);
  };
  return (
    <>
      {slots.map((c) => {
        if (c.node === null) return null;
        if (popped.has(c.id)) return <PoppedStub key={c.id} id={c.id} label={c.label} />;
        return (
          <div
            key={c.id}
            className="group relative [&_header]:cursor-grab [&_[data-drag]]:cursor-grab"
            draggable={armed === c.id}
            onPointerDown={(e) => setArmed(grabbable(e.target as HTMLElement) ? c.id : null)}
            onPointerUp={() => !drag && setArmed(null)}
            onDragStart={(e) => {
              if (armed !== c.id) return e.preventDefault();
              setDrag(c.id);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", c.label);
            }}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              const after = e.clientY > r.top + r.height / 2;
              if (mark?.id !== c.id || mark.after !== after) setMark({ id: c.id, after });
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (drag && mark && drag !== mark.id) setOrder(placeNear(order, drag, mark.id, mark.after));
              end();
            }}
            onDragEnd={end}
          >
            {mark?.id === c.id && drag !== c.id && <div className={cn("pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded bg-accent", mark.after ? "-bottom-2.5" : "-top-2.5")} />}
            <div className={cn(drag === c.id && "opacity-40")}>{c.node}</div>
            <button
              type="button"
              data-nodrag
              onClick={() => openPopout(c.id)}
              title={`Open ${c.label} in its own window`}
              aria-label={`Open ${c.label} in its own window`}
              className="absolute -top-2.5 right-3 z-10 rounded-full border border-line-strong bg-panel px-1.5 text-[11px] leading-5 text-muted opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
            >
              ⧉
            </button>
          </div>
        );
      })}
    </>
  );
}
