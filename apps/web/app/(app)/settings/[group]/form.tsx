"use client";
/**
 * One settings group. Long groups (Logbook services) are split into collapsible sections,
 * one per service, with the service's on/off switch in the section header. Changes are
 * collected locally and saved together from a bar that stays on screen while anything is
 * unsaved; Ctrl+S (Cmd+S) saves too.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { toast } from "@/components/overlays";
import { Badge, Button, Card, cn, Field, Input, Select, Textarea } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";

import { WrlLogbookPicker } from "./wrl-logbook";

export interface FieldDef {
  key: string;
  label: string;
  help: string | null;
  kind: "string" | "secret" | "number" | "boolean" | "select" | "text";
  options: { value: string; label: string }[] | null;
  placeholder: string | null;
  unit: string | null;
  value: unknown;
  set: boolean;
  hint: string | null;
  unreadable: boolean;
  when: { key: string; is: string }[] | null;
  widget: "wrl-logbook" | null;
  section: string | null;
  /** The shack's (everyone's), not the user's own: marked for the admins who see it. */
  shared: boolean;
}

export interface SectionDef {
  id: string;
  label: string;
  description: string;
  toggle: string | null;
}

function Toggle({ checked, onChange, id, label }: { checked: boolean; onChange: (v: boolean) => void; id: string; label?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${checked ? "border-accent bg-accent" : "border-line-strong bg-panel-3"}`}
    >
      <span className={`inline-block size-3.5 rounded-full bg-white transition-transform ${checked ? "translate-x-4.5" : "translate-x-0.5"}`} />
    </button>
  );
}

/** "shack": a setting that applies to everyone, beside one that is the user's own. */
function SharedMark() {
  return (
    <span className="rounded border border-line-strong px-1 text-[10px] font-medium uppercase tracking-wide text-subtle" title="The shack's setting: it applies to everyone">
      shack
    </span>
  );
}

export function SettingsForm({
  title,
  description,
  fields,
  sections = [],
  readOnly = false,
}: {
  title: string;
  description: string;
  fields: FieldDef[];
  sections?: SectionDef[];
  /** An admin looking at another user's settings. */
  readOnly?: boolean;
}) {
  const router = useRouter();
  const initial = useMemo(() => Object.fromEntries(fields.map((f) => [f.key, f.kind === "secret" ? "" : f.value])), [fields]);
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  const [clear, setClear] = useState<Set<string>>(new Set());
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  // After a save the server sends fresh values; start from them.
  useEffect(() => {
    setValues(initial);
    setClear(new Set());
  }, [initial]);

  const changed = useCallback((f: FieldDef) => (f.kind === "secret" ? values[f.key] !== "" || clear.has(f.key) : values[f.key] !== initial[f.key]), [values, clear, initial]);
  const dirtyFields = fields.filter(changed);
  const dirty = dirtyFields.length > 0;
  const visible = (f: FieldDef) => !f.when || f.when.every((c) => String(values[c.key]) === c.is);
  const set = (k: string, v: unknown) => setValues((s) => ({ ...s, [k]: v }));

  const save = useCallback(async () => {
    const patch: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.kind === "secret") {
        if (clear.has(f.key)) patch[f.key] = "";
        else if (values[f.key] !== "") patch[f.key] = values[f.key];
      } else if (values[f.key] !== initial[f.key]) patch[f.key] = values[f.key];
    }
    if (!Object.keys(patch).length) return;
    setBusy(true);
    setIssues({});
    try {
      await api("/api/settings", { method: "PATCH", body: patch });
      toast({ title: "Settings saved", tone: "ok", timeout: 2500 });
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.issues) {
        setIssues(e.issues);
        // Open the sections that hold the problems, so they can be seen.
        const bad = new Set(Object.keys(e.issues).map((k) => fields.find((f) => f.key === k)?.section).filter(Boolean) as string[]);
        setOpen((o) => new Set([...o, ...bad]));
      }
      toast({ title: "Not saved", body: (e as Error).message, tone: "bad" });
    } finally {
      setBusy(false);
    }
  }, [fields, values, clear, initial, router]);

  const discard = () => {
    setValues(initial);
    setClear(new Set());
    setIssues({});
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty && !busy) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, busy, save]);

  // Warn before leaving the page with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

  // A link to one setting (#setting-<key>, from the settings search): open its section,
  // bring it into view, focus it, and highlight it for a moment.
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    const show = () => {
      const m = /^#setting-(.+)$/.exec(window.location.hash);
      if (!m) return;
      const key = decodeURIComponent(m[1]!);
      const f = fields.find((x) => x.key === key);
      if (!f) return;
      if (f.section) setOpen((o) => new Set([...o, f.section!]));
      setTimeout(() => {
        const el = document.getElementById(`setting-${key}`) ?? (f.section ? document.getElementById(`section-${f.section}`) : null);
        if (!el) return;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.querySelector<HTMLElement>("input, select, textarea, button")?.focus({ preventScroll: true });
        setFlash(key);
        setTimeout(() => setFlash((k) => (k === key ? null : k)), 2500);
      }, 60);
    };
    show();
    window.addEventListener("hashchange", show);
    return () => window.removeEventListener("hashchange", show);
  }, [fields]);

  const renderField = (f: FieldDef) => (
    <div key={f.key} id={`setting-${f.key}`} className={cn("scroll-mt-24 rounded-md transition-shadow duration-500", flash === f.key && "ring-2 ring-accent ring-offset-4 ring-offset-panel")}>
      {renderInner(f)}
    </div>
  );

  const renderInner = (f: FieldDef) => {
    const err = issues[f.key];
    if (f.widget === "wrl-logbook") {
      return (
        <Field key={f.key} label={f.label} help={f.help} error={err}>
          <WrlLogbookPicker value={String(values[f.key] ?? "")} onChange={(v) => set(f.key, v)} keyDraft={String(values["wrl.apiKey"] ?? "")} keyStored={!!fields.find((x) => x.key === "wrl.apiKey")?.set && !clear.has("wrl.apiKey")} />
        </Field>
      );
    }
    if (f.kind === "boolean") {
      return (
        <div key={f.key} className="flex items-start justify-between gap-4">
          <label htmlFor={f.key} className="min-w-0">
            <span className="flex items-center gap-2 text-sm text-fg">
              {f.label}
              {f.shared && <SharedMark />}
            </span>
            {f.help && <span className="block text-xs text-subtle">{f.help}</span>}
            {err && <span className="block text-xs text-bad">{err}</span>}
          </label>
          <Toggle id={f.key} checked={Boolean(values[f.key])} onChange={(v) => set(f.key, v)} />
        </div>
      );
    }
    return (
      <Field
        key={f.key}
        label={
          <span className="flex items-center gap-2">
            {f.label}
            {f.shared && <SharedMark />}
            {f.kind === "secret" && f.set && !clear.has(f.key) && <Badge tone={f.unreadable ? "bad" : "ok"}>{f.unreadable ? "stored, unreadable" : `stored ${f.hint ?? ""}`}</Badge>}
          </span>
        }
        help={f.help}
        error={err}
      >
        <div className="flex items-center gap-2">
          {f.kind === "select" ? (
            <Select value={String(values[f.key])} onChange={(e) => set(f.key, e.target.value)}>
              {f.options!.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ) : f.kind === "text" ? (
            <Textarea value={String(values[f.key] ?? "")} placeholder={f.placeholder ?? undefined} onChange={(e) => set(f.key, e.target.value)} rows={5} />
          ) : f.kind === "number" ? (
            <Input type="number" step="any" value={String(values[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value === "" ? "" : Number(e.target.value))} className="max-w-40" />
          ) : f.kind === "secret" ? (
            <Input
              type="password"
              autoComplete="new-password"
              value={String(values[f.key] ?? "")}
              placeholder={f.set ? "Leave blank to keep the stored value" : (f.placeholder ?? "")}
              onChange={(e) => set(f.key, e.target.value)}
            />
          ) : (
            <Input value={String(values[f.key] ?? "")} placeholder={f.placeholder ?? undefined} onChange={(e) => set(f.key, e.target.value)} />
          )}
          {f.unit && <span className="whitespace-nowrap text-xs text-muted">{f.unit}</span>}
          {f.kind === "secret" && f.set && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setClear((c) => {
                  const n = new Set(c);
                  if (n.has(f.key)) n.delete(f.key);
                  else n.add(f.key);
                  return n;
                })
              }
            >
              {clear.has(f.key) ? "Keep" : "Clear"}
            </Button>
          )}
        </div>
      </Field>
    );
  };

  const loose = fields.filter((f) => !f.section && visible(f));
  const dirtySections = new Set(dirtyFields.map((f) => f.section).filter(Boolean) as string[]);
  const sectionNames = sections.filter((s) => dirtySections.has(s.id)).map((s) => s.label);

  return (
    <fieldset disabled={readOnly} className="min-w-0 space-y-3">
      <Card title={title}>
        <p className={cn("-mt-1 text-sm text-muted", loose.length > 0 && "mb-4")}>{description}</p>
        {loose.length > 0 && <div className="space-y-5">{loose.map(renderField)}</div>}
      </Card>

      {sections.map((s) => {
        const own = fields.filter((f) => f.section === s.id);
        if (!own.length) return null;
        const toggle = s.toggle ? own.find((f) => f.key === s.toggle) : undefined;
        const body = own.filter((f) => f !== toggle && visible(f));
        const isOpen = open.has(s.id);
        const on = toggle ? Boolean(values[toggle.key]) : own.some((f) => f.kind === "string" && String(values[f.key] ?? "").trim() !== "");
        const hasIssue = own.some((f) => issues[f.key]);
        return (
          <div key={s.id} id={`section-${s.id}`} className={cn("scroll-mt-24 rounded-lg border bg-panel", hasIssue ? "border-bad/60" : "border-line")}>
            <div
              role="button"
              tabIndex={0}
              aria-expanded={isOpen}
              onClick={() => setOpen((o) => (o.has(s.id) ? new Set([...o].filter((x) => x !== s.id)) : new Set([...o, s.id])))}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpen((o) => (o.has(s.id) ? new Set([...o].filter((x) => x !== s.id)) : new Set([...o, s.id])));
                }
              }}
              className="flex cursor-pointer select-none items-center gap-3 px-4 py-3"
            >
              <svg viewBox="0 0 24 24" className={cn("size-4 shrink-0 text-subtle transition-transform", isOpen && "rotate-90")} fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M9 6l6 6-6 6" />
              </svg>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-fg">{s.label}</span>
                  {dirtySections.has(s.id) && <span className="size-1.5 rounded-full bg-accent" title="Unsaved changes" />}
                </div>
                <div className="truncate text-xs text-subtle">{s.description}</div>
              </div>
              {toggle ? (
                <Toggle id={toggle.key} label={toggle.label} checked={on} onChange={(v) => set(toggle.key, v)} />
              ) : (
                <Badge tone={on ? "ok" : "neutral"}>{on ? "on" : "off"}</Badge>
              )}
            </div>
            {isOpen && <div className="space-y-5 border-t border-line px-4 py-4">{body.map(renderField)}</div>}
          </div>
        );
      })}

      {dirty && !readOnly && (
        <div className="sticky bottom-3 z-20 flex items-center justify-between gap-3 rounded-lg border border-accent/50 bg-panel-2/95 px-4 py-2.5 shadow-lg backdrop-blur">
          <span className="min-w-0 truncate text-sm text-fg">
            Unsaved changes{sectionNames.length ? ` in ${sectionNames.join(", ")}` : ""}
          </span>
          <span className="flex shrink-0 gap-2">
            <Button size="sm" variant="ghost" onClick={discard} disabled={busy}>
              Discard
            </Button>
            <Button size="sm" variant="primary" onClick={() => void save()} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </span>
        </div>
      )}
    </fieldset>
  );
}
