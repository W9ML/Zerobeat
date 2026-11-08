"use client";
/**
 * Search across every setting: its name, help, section, choices and key. Picking one goes
 * to its page with #setting-<key>; the form opens the section that holds it, scrolls to
 * it, focuses it and highlights it for a moment. "/" focuses the box from anywhere on a
 * settings page.
 */
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/components/ui";

export interface SearchItem {
  key: string;
  label: string;
  help: string;
  where: string;
  href: string;
  /** Extra words that should find it (choices, the key itself). */
  words: string;
  /** When it is only shown for another setting's value. */
  note: string | null;
}

function score(item: SearchItem, terms: string[]): number {
  const label = item.label.toLowerCase();
  const all = `${label} ${item.where.toLowerCase()} ${item.help.toLowerCase()} ${item.words.toLowerCase()}`;
  let s = 0;
  for (const t of terms) {
    if (!all.includes(t)) return 0;
    if (label.startsWith(t)) s += 8;
    else if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(label)) s += 6;
    else if (label.includes(t)) s += 4;
    else if (item.where.toLowerCase().includes(t)) s += 2;
    else s += 1;
  }
  return s;
}

function Mark({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-accent/25 text-fg">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function SettingsSearch({ items }: { items: SearchItem[] }) {
  const router = useRouter();
  const path = usePathname();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const terms = useMemo(() => q.toLowerCase().split(/\s+/).filter(Boolean), [q]);
  const results = useMemo(() => {
    if (!terms.length) return [];
    return items
      .map((i) => ({ i, s: score(i, terms) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.i.label.localeCompare(b.i.label))
      .slice(0, 12)
      .map((x) => x.i);
  }, [items, terms]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function go(item: SearchItem) {
    setOpen(false);
    setQ("");
    input.current?.blur();
    const [page, hash] = item.href.split("#");
    if (page === path && hash) {
      // Same page: setting the hash fires hashchange, which the form listens for.
      if (window.location.hash === `#${hash}`) window.dispatchEvent(new HashChangeEvent("hashchange"));
      else window.location.hash = hash;
    } else router.push(item.href);
  }

  return (
    <div className="relative">
      <input
        ref={input}
        type="search"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((s) => Math.min(results.length - 1, s + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((s) => Math.max(0, s - 1));
          } else if (e.key === "Enter" && results[sel]) {
            e.preventDefault();
            go(results[sel]!);
          } else if (e.key === "Escape") {
            setQ("");
            input.current?.blur();
          }
        }}
        placeholder="Search settings   /"
        aria-label="Search settings"
        aria-expanded={open && results.length > 0}
        aria-controls="settings-search-results"
        role="combobox"
        className="h-9 w-full rounded-md border border-line-strong bg-panel-2 px-3 text-sm text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
      />
      {open && terms.length > 0 && (
        <div id="settings-search-results" role="listbox" className="absolute left-0 top-10 z-30 max-h-[70vh] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-line-strong bg-panel shadow-xl">
          {results.length === 0 ? (
            <div className="px-3 py-3 text-sm text-muted">No setting matches &ldquo;{q}&rdquo;.</div>
          ) : (
            results.map((r, n) => (
              <button
                key={r.href}
                type="button"
                role="option"
                aria-selected={n === sel}
                onMouseEnter={() => setSel(n)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(r)}
                className={cn("block w-full border-b border-line px-3 py-2 text-left last:border-b-0", n === sel ? "bg-panel-3" : "hover:bg-panel-2")}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-fg">
                    <Mark text={r.label} terms={terms} />
                  </span>
                  <span className="shrink-0 text-[11px] text-subtle">{r.where}</span>
                </div>
                {r.help && (
                  <div className="mt-0.5 line-clamp-2 text-xs text-muted">
                    <Mark text={r.help} terms={terms} />
                  </div>
                )}
                {r.note && <div className="mt-0.5 text-[11px] text-subtle">{r.note}</div>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
