"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { control, useLive } from "@/lib/client/live";
import { mhz } from "@/lib/format";
import { confirmDialog, toast } from "./overlays";
import { LiveAlerts } from "./live-alerts";
import { Wordmark } from "./logo";
import { TxSwitch } from "./tx-switch";
import { Badge, Button, cn, Dot } from "./ui";

const NAV: { href: string; label: string; icon: string; admin?: boolean }[] = [
  { href: "/operate", label: "Operate", icon: "M4 12h3l3-8 4 16 3-8h3" },
  { href: "/", label: "Dashboard", icon: "M4 13h6V4H4zm10 7h6v-9h-6zM4 20h6v-5H4zm10-11h6V4h-6z" },
  { href: "/log", label: "Logbook", icon: "M5 4h11l3 3v13H5zM9 9h6M9 13h6M9 17h4" },
  { href: "/awards", label: "Awards", icon: "M12 15a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm-3 0-1 6 4-2 4 2-1-6" },
  { href: "/map", label: "Map", icon: "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14m6-12v14" },
  { href: "/bands", label: "Band memory", icon: "M4 20V10m5 10V4m5 16v-7m5 7V8" },
  { href: "/bookings", label: "Radio time", icon: "M4 6h16v14H4zM4 10h16M8 3v4m8-4v4m-8 7h3v3H8z" },
  { href: "/runs", label: "Runs", icon: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" },
  { href: "/qsl", label: "QSL", icon: "M3 7l9 6 9-6M4 5h16v14H4z" },
  { href: "/services", label: "Services", icon: "M7 17a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.5A4 4 0 1 1 17 17zm5-5v6m-3-3 3 3 3-3" },
  { href: "/import", label: "Import / export", icon: "M12 3v12m-4-4 4 4 4-4M4 17v3h16v-3" },
  { href: "/settings", label: "Settings", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z" },
];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

function UtcClock() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (now === null) return <span className="font-mono text-sm text-muted">--:--:--Z</span>;
  return <span className="font-mono text-sm tabular text-fg">{new Date(now).toISOString().slice(11, 19)}Z</span>;
}

export function StatusStrip() {
  const { snap, status } = useLive();
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const link = snap?.radio.link;
  const connected = status === "open" && link === "connected";

  // An emergency stop does not ask, and does not wait for the live feed: it goes straight
  // to the engine over HTTP, so it works on a fresh page load or a flaky link.
  async function ft0() {
    const engage = !snap?.ft0;
    setBusy(true);
    const r = await control("/ft0", { engage });
    setBusy(false);
    if (!r.ok) toast({ title: "FT-0 failed", body: r.error, tone: "bad" });
    router.refresh();
  }

  return (
    <div className="flex h-12 items-center gap-2 border-b border-line bg-panel px-3 sm:gap-3 sm:px-4">
      <div className="flex min-w-0 shrink items-center gap-2">
        {status !== "open" ? (
          <Badge tone="bad">
            <Dot tone="bad" /> {status === "engine-down" ? "Engine offline" : "Reconnecting"}
          </Badge>
        ) : connected ? (
          <Badge tone="ok" title={snap?.radio.detail} className="min-w-0 max-w-[40vw] sm:max-w-none">
            <Dot tone="ok" /> <span className="truncate">{snap?.radio.model} {snap?.radio.nickname}</span>
          </Badge>
        ) : (
          <Badge tone="warn" title={snap?.radio.detail} className="min-w-0 max-w-[40vw] sm:max-w-none">
            <Dot tone="warn" pulse /> <span className="truncate">{snap?.ft0 ? "Radio released (FT-0)" : `Radio ${link ?? "…"}`}</span>
          </Badge>
        )}
        {snap && snap.dialHz > 0 && (
          <span className="hidden font-mono text-sm tabular text-fg sm:inline">
            {mhz(snap.dialHz)} <span className="text-muted">{snap.band ?? ""} {snap.mode}</span>
          </span>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
        <TxSwitch snap={snap} size="sm" disabled={!snap} />
        {snap?.auto.mode && snap.auto.mode !== "off" && (
          <span className="hidden sm:inline">
            <Badge tone="info">Auto {snap.auto.mode}</Badge>
          </span>
        )}
        <span className="hidden sm:contents">
          <UtcClock />
        </span>
        <Button variant={snap?.ft0 ? "secondary" : "danger"} size="sm" disabled={busy} onClick={ft0} title={snap?.ft0 ? "Reconnect the radio (transmit stays off)" : "Stop everything now: unkey, stop automatic operating, transmit off, release the radio"}>
          {snap?.ft0 ? "Release FT-0" : "FT-0"}
        </Button>
      </div>
    </div>
  );
}

/** For an admin: whose logbook and settings to look at (theirs by default; others read-only). */
function ViewSwitch({ me, people, viewing }: { me: string; people: { id: string; name: string; callsign: string }[]; viewing: { userId: string } | null }) {
  const router = useRouter();
  const choose = async (userId: string) => {
    await fetch("/api/view", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: userId === me ? null : userId }) });
    router.refresh();
  };
  if (people.length < 2) return null;
  return (
    <label className="mt-2 block">
      <span className="text-subtle">Logbook</span>
      <select
        aria-label="Whose logbook to view"
        value={viewing?.userId ?? me}
        onChange={(e) => void choose(e.target.value)}
        className="mt-0.5 block w-full rounded-md border border-line-strong bg-panel-2 px-1.5 py-1 text-xs text-fg"
      >
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.id === me ? `Mine (${p.callsign})` : `${p.callsign} · ${p.name}`}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Shell({
  user,
  people = [],
  viewing = null,
  children,
}: {
  user: { id: string; name: string; callsign: string | null; role: string };
  people?: { id: string; name: string; callsign: string }[];
  viewing?: { userId: string; callsign: string | null } | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  const active = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(href + "/"));

  return (
    <div className="flex min-h-dvh">
      <aside
        className={cn(
          // Pinned to the window on a desktop, so your account and the Logbook picker stay in view.
          "fixed inset-y-0 left-0 z-30 flex w-56 shrink-0 flex-col border-r border-line bg-panel transition-transform lg:sticky lg:top-0 lg:h-dvh lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <Wordmark size={26} />
        </div>
        <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                active(n.href) ? "bg-panel-3 text-fg" : "text-muted hover:bg-panel-2 hover:text-fg",
              )}
            >
              <Icon d={n.icon} />
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="shrink-0 border-t border-line p-3 text-xs">
          <Link href="/account" className="block truncate font-medium text-fg hover:text-accent-strong" title="Your account and notifications">
            {user.callsign ?? user.name}
          </Link>
          <div className="flex items-center justify-between text-muted">
            <span className="capitalize">{user.role.toLowerCase()}</span>
            <form action="/api/auth/logout" method="post">
              <button className="text-muted hover:text-fg">Sign out</button>
            </form>
          </div>
          {user.role === "ADMIN" && <ViewSwitch me={user.id} people={people} viewing={viewing} />}
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-20 bg-black/50 lg:hidden" onClick={() => setOpen(false)} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-10 flex items-center">
          <button className="flex h-12 items-center border-b border-r border-line bg-panel px-3 text-muted lg:hidden" onClick={() => setOpen(true)} aria-label="Menu">
            <Icon d="M4 6h16M4 12h16M4 18h16" />
          </button>
          <div className="min-w-0 flex-1">
            <StatusStrip />
          </div>
        </div>
        <main className="min-w-0 flex-1 p-4 lg:p-6">
          {viewing && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-info/50 bg-info/10 px-4 py-2 text-sm">
              <span>
                Viewing <span className="font-mono font-semibold">{viewing.callsign ?? "another user"}</span>'s logbook and settings, read-only.
              </span>
              <button
                className="text-accent-strong hover:underline"
                onClick={() =>
                  void fetch("/api/view", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: null }) }).then(() => router.refresh())
                }
              >
                Back to mine
              </button>
            </div>
          )}
          {children}
        </main>
        <LiveAlerts canOperate={user.role !== "VIEWER"} />
      </div>
    </div>
  );
}
