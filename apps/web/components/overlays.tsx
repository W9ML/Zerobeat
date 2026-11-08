"use client";
/**
 * In-app dialogs and toasts, in the app's own look. Call from anywhere in client code:
 *
 *   if (await confirmDialog({ title: "Delete this contact?", tone: "danger" })) …
 *   const pw = await promptDialog({ title: "New password", type: "password" });
 *   toast({ title: "Saved" });
 *
 * One <Overlays /> in the root layout renders whatever is open. Esc cancels, Enter
 * confirms, focus stays inside the dialog, and the page behind does not scroll.
 */
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { buttonClass, cn } from "./ui";

type Tone = "primary" | "danger";

interface DialogBase {
  id: number;
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: Tone;
}
interface ConfirmReq extends DialogBase {
  kind: "confirm";
  resolve: (v: boolean) => void;
}
interface PromptReq extends DialogBase {
  kind: "prompt";
  label?: string;
  type?: "text" | "password";
  placeholder?: string;
  initial?: string;
  validate?: (v: string) => string | null;
  resolve: (v: string | null) => void;
}
type DialogReq = ConfirmReq | PromptReq;

export interface ToastReq {
  id: number;
  title: string;
  body?: ReactNode;
  tone?: "info" | "ok" | "warn" | "bad" | "accent";
  action?: { label: string; href?: string; onClick?: () => void };
  /** ms; 0 keeps it until dismissed */
  timeout?: number;
}

let dialogs: DialogReq[] = [];
let toasts: ToastReq[] = [];
let seq = 1;
const listeners = new Set<() => void>();
let snapshot = { dialogs, toasts };
const emit = () => {
  snapshot = { dialogs, toasts };
  for (const l of listeners) l();
};

export function confirmDialog(opts: Omit<DialogBase, "id">): Promise<boolean> {
  return new Promise((resolve) => {
    dialogs = [...dialogs, { ...opts, id: seq++, kind: "confirm", resolve }];
    emit();
  });
}

export function promptDialog(opts: Omit<PromptReq, "id" | "kind" | "resolve">): Promise<string | null> {
  return new Promise((resolve) => {
    dialogs = [...dialogs, { ...opts, id: seq++, kind: "prompt", resolve }];
    emit();
  });
}

export function toast(t: Omit<ToastReq, "id">): number {
  const id = seq++;
  toasts = [...toasts.slice(-4), { ...t, id }];
  emit();
  const ms = t.timeout ?? 6000;
  if (ms > 0) setTimeout(() => dismissToast(id), ms);
  return id;
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function close(id: number) {
  dialogs = dialogs.filter((d) => d.id !== id);
  emit();
}

function useOverlays() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
    () => snapshot,
  );
}

function Dialog({ d }: { d: DialogReq }) {
  const panel = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(d.kind === "prompt" ? (d.initial ?? "") : "");
  const [error, setError] = useState<string | null>(null);

  const cancel = () => {
    close(d.id);
    if (d.kind === "confirm") d.resolve(false);
    else d.resolve(null);
  };
  const ok = () => {
    if (d.kind === "prompt") {
      const problem = d.validate?.(value) ?? null;
      if (problem) {
        setError(problem);
        return;
      }
      close(d.id);
      d.resolve(value);
    } else {
      close(d.id);
      d.resolve(true);
    }
  };

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = panel.current!;
    const first = el.querySelector<HTMLElement>(d.kind === "prompt" ? "input" : d.tone === "danger" ? "[data-cancel]" : "[data-ok]");
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Tab") {
        const f = [...el.querySelectorAll<HTMLElement>("button, input")].filter((x) => !x.hasAttribute("disabled"));
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          f[f.length - 1]!.focus();
        } else if (!e.shiftKey && i === f.length - 1) {
          e.preventDefault();
          f[0]!.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={cancel} />
      <div
        ref={panel}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`dlg-${d.id}`}
        className="relative w-full max-w-md overflow-hidden rounded-lg border border-line-strong bg-panel shadow-2xl shadow-black/60"
      >
        <div className={cn("h-0.5", d.tone === "danger" ? "bg-bad" : "bg-accent")} />
        <form
          className="p-5"
          onSubmit={(e) => {
            e.preventDefault();
            ok();
          }}
        >
          <h2 id={`dlg-${d.id}`} className="text-base font-semibold text-fg">
            {d.title}
          </h2>
          {d.body && <div className="mt-2 text-sm leading-relaxed text-muted">{d.body}</div>}
          {d.kind === "prompt" && (
            <label className="mt-4 block space-y-1">
              {d.label && <span className="block text-xs font-medium text-muted">{d.label}</span>}
              <input
                type={d.type ?? "text"}
                value={value}
                placeholder={d.placeholder}
                autoComplete={d.type === "password" ? "new-password" : "off"}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
                className="h-9 w-full rounded-md border border-line-strong bg-panel-2 px-2.5 text-sm text-fg focus:border-accent focus:outline-none"
              />
              {error && <span className="block text-xs text-bad">{error}</span>}
            </label>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" data-cancel onClick={cancel} className={buttonClass("ghost")}>
              {d.cancelLabel ?? "Cancel"}
            </button>
            <button type="submit" data-ok className={buttonClass(d.tone === "danger" ? "danger" : "primary")}>
              {d.confirmLabel ?? "OK"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const TOAST_BAR: Record<NonNullable<ToastReq["tone"]>, string> = {
  info: "bg-info",
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  accent: "bg-accent",
};

export function Overlays() {
  const { dialogs: ds, toasts: ts } = useOverlays();
  useEffect(() => {
    document.body.style.overflow = ds.length ? "hidden" : "";
  }, [ds.length]);
  return (
    <>
      {ds.slice(0, 1).map((d) => (
        <Dialog key={d.id} d={d} />
      ))}
      <div className="pointer-events-none fixed right-4 bottom-4 z-40 flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
        {ts.length > 2 && (
          <div className="pointer-events-auto flex items-center justify-between rounded-lg border border-line-strong bg-panel px-3 py-1.5 text-xs text-muted shadow-xl shadow-black/50">
            <span>{ts.length - 2} older</span>
            <button onClick={() => ts.forEach((t) => dismissToast(t.id))} className="font-medium text-accent-strong hover:underline">
              Dismiss all
            </button>
          </div>
        )}
        {/* The newest two: a pile of five covered the decode list on a phone. */}
        {ts.slice(-2).map((t) => (
          <div key={t.id} className="pointer-events-auto flex overflow-hidden rounded-lg border border-line-strong bg-panel shadow-xl shadow-black/50">
            <div className={cn("w-1 shrink-0", TOAST_BAR[t.tone ?? "info"])} />
            <div className="min-w-0 flex-1 px-3 py-2.5">
              <div className="text-sm font-medium text-fg">{t.title}</div>
              {t.body && <div className="mt-0.5 text-xs text-muted">{t.body}</div>}
              {t.action &&
                (t.action.href ? (
                  <Link href={t.action.href} onClick={() => dismissToast(t.id)} className="mt-1.5 inline-block text-xs font-medium text-accent-strong hover:underline">
                    {t.action.label}
                  </Link>
                ) : (
                  <button
                    onClick={() => {
                      t.action!.onClick?.();
                      dismissToast(t.id);
                    }}
                    className="mt-1.5 text-xs font-medium text-accent-strong hover:underline"
                  >
                    {t.action.label}
                  </button>
                ))}
            </div>
            <button onClick={() => dismissToast(t.id)} className="px-3 text-subtle hover:text-fg" aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
