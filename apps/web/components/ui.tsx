/** Small, consistent building blocks. Server-safe: no hooks here. */
import Link from "next/link";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

export function cn(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(" ");
}

type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "info" | "me";
const TONE: Record<Tone, string> = {
  neutral: "bg-panel-3 text-muted border-line-strong",
  accent: "bg-accent-soft text-accent-strong border-accent/40",
  ok: "bg-ok-soft text-ok border-ok/30",
  warn: "bg-warn-soft text-warn border-warn/30",
  bad: "bg-bad-soft text-bad border-bad/30",
  info: "bg-info-soft text-info border-info/30",
  me: "bg-me-soft text-me border-me/30",
};

export function Badge({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 rounded-sm border px-1.5 py-px text-[11px] font-medium leading-4 whitespace-nowrap", TONE[tone], className)}>
      {children}
    </span>
  );
}

export function Dot({ tone = "neutral", pulse }: { tone?: Tone; pulse?: boolean }) {
  const c = { neutral: "bg-subtle", accent: "bg-accent", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", info: "bg-info", me: "bg-me" }[tone];
  return <span className={cn("inline-block size-2 rounded-full", c, pulse && "pulse")} />;
}

type BtnVariant = "primary" | "secondary" | "ghost" | "danger";
const BTN: Record<BtnVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent-strong border-transparent",
  secondary: "bg-panel-2 text-fg hover:bg-panel-3 border-line-strong",
  ghost: "bg-transparent text-muted hover:text-fg hover:bg-panel-2 border-transparent",
  danger: "bg-bad text-white hover:brightness-110 border-transparent",
};

export function buttonClass(variant: BtnVariant = "secondary", size: "sm" | "md" = "md") {
  return cn(
    "inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:opacity-45 disabled:pointer-events-none cursor-pointer select-none",
    size === "sm" ? "h-7 px-2.5 text-xs" : "h-8.5 px-3.5 text-sm",
    BTN[variant],
  );
}

export function Button({ variant = "secondary", size = "md", className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "md" }) {
  return <button type="button" {...rest} className={cn(buttonClass(variant, size), className)} />;
}

export function LinkButton({ href, variant = "secondary", size = "md", children, className }: { href: string; variant?: BtnVariant; size?: "sm" | "md"; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={cn(buttonClass(variant, size), className)}>
      {children}
    </Link>
  );
}

const field = "w-full rounded-md border border-line-strong bg-panel-2 px-2.5 text-sm text-fg placeholder:text-subtle focus:border-accent focus:outline-none disabled:opacity-50";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cn(field, "h-8.5", className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cn(field, "h-8.5 pr-7", className)}>
      {children}
    </select>
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cn(field, "py-2 min-h-24", className)} />;
}

export function Field({ label, help, error, children, className }: { label: ReactNode; help?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={cn("block space-y-1", className)}>
      <span className="block text-xs font-medium text-muted">{label}</span>
      {children}
      {error ? <span className="block text-xs text-bad">{error}</span> : help ? <span className="block text-xs text-subtle">{help}</span> : null}
    </label>
  );
}

export function Card({ title, actions, children, className, pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cn("rounded-lg border border-line bg-panel", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line px-4 py-2.5">
          <h2 className="text-[13px] font-semibold tracking-wide text-fg">{title}</h2>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={pad ? "p-4" : undefined}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "ok" | "accent" }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={cn("mt-1 font-mono text-2xl font-semibold tabular", tone === "ok" && "text-ok", tone === "accent" && "text-accent-strong")}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-subtle">{sub}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-line-strong px-4 py-10 text-center text-sm text-muted">{children}</div>;
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full border-collapse text-sm [&_td]:border-b [&_td]:border-line [&_td]:px-3 [&_td]:py-1.5 [&_th]:border-b [&_th]:border-line-strong [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted [&_tr:hover_td]:bg-panel-2">
        {children}
      </table>
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "bad" | "ok"; children: ReactNode }) {
  const t = { info: "border-info/30 bg-info-soft", warn: "border-warn/30 bg-warn-soft", bad: "border-bad/30 bg-bad-soft", ok: "border-ok/30 bg-ok-soft" }[tone];
  return <div className={cn("rounded-md border px-3 py-2 text-sm", t)}>{children}</div>;
}
