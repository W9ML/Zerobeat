"use client";
/**
 * A card that folds to one line: its title, a summary of what it would show, and its
 * actions. Open when its job is live (\`forceOpen\`: automatic running, the radio near a
 * limit), otherwise as the operator last left it, otherwise \`defaultOpen\`. The choice
 * is remembered per card in this browser.
 */
import { useEffect, useState, type ReactNode } from "react";

import { cn } from "./ui";

const key = (id: string) => `ds.fold.${id}`;

export function FoldCard({
  id,
  title,
  summary,
  actions,
  forceOpen = false,
  defaultOpen = false,
  pad = true,
  tone,
  children,
}: {
  id: string;
  title: ReactNode;
  summary?: ReactNode;
  actions?: ReactNode;
  forceOpen?: boolean;
  defaultOpen?: boolean;
  pad?: boolean;
  tone?: "warn" | "bad";
  children: ReactNode;
}) {
  // Read after mount: the server render cannot know this browser's choice.
  const [choice, setChoice] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      const v = localStorage.getItem(key(id));
      if (v === "1" || v === "0") setChoice(v === "1");
    } catch {
      /* storage off: the default stands */
    }
  }, [id]);
  const open = forceOpen || (choice ?? defaultOpen);
  const toggle = () => {
    const next = !open;
    setChoice(next);
    try {
      localStorage.setItem(key(id), next ? "1" : "0");
    } catch {
      /* not remembered */
    }
  };
  return (
    <section className={cn("rounded-lg border bg-panel", tone === "bad" ? "border-bad" : tone === "warn" ? "border-warn" : "border-line")}>
      <header className={cn("flex items-center gap-2 px-4", open ? "border-b border-line py-2.5" : "py-2")}>
        <button
          type="button"
          onClick={toggle}
          disabled={forceOpen}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
          title={forceOpen ? undefined : open ? "Fold to one line" : "Open"}
        >
          <span className={cn("text-[10px] text-subtle transition-transform", open && "rotate-90", forceOpen && "invisible")} aria-hidden>
            ▶
          </span>
          <h2 className="shrink-0 text-[13px] font-semibold tracking-wide text-fg">{title}</h2>
          {summary !== undefined && summary !== null && summary !== false && (
            <span className={cn("min-w-0 truncate text-xs", tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-muted")}>{summary}</span>
          )}
        </button>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      {open && <div className={pad ? "p-4" : undefined}>{children}</div>}
    </section>
  );
}
