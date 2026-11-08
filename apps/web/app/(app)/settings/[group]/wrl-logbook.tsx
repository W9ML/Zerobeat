"use client";
/**
 * Pick a World Radio League logbook by name. The list loads from WRL as soon as there is a
 * key: the stored one, or one just typed (checked before it is saved).
 */
import { useEffect, useRef, useState } from "react";

import { Button, Select } from "@/components/ui";
import { api } from "@/lib/client/api";

interface Book {
  id: string;
  name: string;
  locked: boolean;
  callsign: string | null;
}

export function WrlLogbookPicker({ value, onChange, keyDraft, keyStored }: { value: string; onChange: (v: string) => void; keyDraft: string; keyStored: boolean }) {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);

  const draft = keyDraft.trim();
  const usable = draft.length >= 16 || (!draft && keyStored);

  useEffect(() => {
    if (!usable) {
      setBooks(null);
      setState("idle");
      return;
    }
    const mine = ++seq.current;
    setState("loading");
    // Wait for typing to stop before asking WRL.
    const t = setTimeout(
      async () => {
        try {
          const r = await api<{ logbooks: Book[]; defaultId: string | null }>("/api/wrl/logbooks", { body: draft ? { key: draft } : {} });
          if (mine !== seq.current) return;
          setBooks(r.logbooks);
          setDefaultId(r.defaultId);
          setState("idle");
          setError(null);
        } catch (e) {
          if (mine !== seq.current) return;
          setBooks(null);
          setState("error");
          setError((e as Error).message);
        }
      },
      draft ? 700 : 0,
    );
    return () => clearTimeout(t);
  }, [draft, usable, nonce]);

  if (!usable) {
    return <p className="text-sm text-muted">Enter the API key above and your logbooks appear here.</p>;
  }
  if (state === "loading" && !books) return <p className="text-sm text-muted">Loading your logbooks from World Radio League…</p>;
  if (state === "error") {
    return (
      <div className="flex items-center gap-3">
        <p className="text-sm text-bad">{error}</p>
        <Button size="sm" variant="ghost" onClick={() => setNonce((n) => n + 1)}>
          Try again
        </Button>
      </div>
    );
  }
  if (!books) return null;
  if (!books.length) return <p className="text-sm text-warn">This account has no logbooks yet. Create one on World Radio League, then come back.</p>;

  const def = books.find((b) => b.id === defaultId);
  const unknown = value && !books.some((b) => b.id === value);
  const label = (b: Book) => `${b.name}${b.callsign ? ` (${b.callsign})` : ""}${b.locked ? " — locked" : ""}`;
  return (
    <div className="space-y-1.5">
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{def ? `Your default logbook: ${label(def)}` : books.length === 1 ? `Your only logbook: ${label(books[0]!)}` : "Your default logbook (none chosen on WRL yet)"}</option>
        {books.map((b) => (
          <option key={b.id} value={b.id} disabled={b.locked}>
            {label(b)}
          </option>
        ))}
        {unknown && <option value={value}>A logbook this key cannot see ({value.slice(0, 8)}…)</option>}
      </Select>
      {!value && !def && books.length > 1 && <p className="text-xs text-warn">You have several logbooks and no default on WRL, so pick one here or uploads will be refused.</p>}
    </div>
  );
}
