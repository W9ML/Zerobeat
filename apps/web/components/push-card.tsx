"use client";
/** Phone and desktop notifications for this browser: subscribe, choose what to hear about, test. */
import { useCallback, useEffect, useState } from "react";

import { toast } from "@/components/overlays";
import { Badge, Button, Card, cn } from "@/components/ui";
import { api, type ApiError } from "@/lib/client/api";

const CATS = [
  { id: "needed", label: "Needed stations", help: "A station you need is on the air (how picky is set by New-one alerts above)." },
  { id: "faults", label: "Faults", help: "Transmit stopped for a problem, or the radio has been gone for 10 minutes." },
  { id: "digest", label: "Daily summary", help: "Contacts, new ones and faults since the last summary." },
];

interface Sub {
  endpoint: string;
  categories: string[];
  label: string | null;
  lastOkAt: number | null;
  failures: number;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToB64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "device";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${br} on ${os}`;
}

type Support = "checking" | "ok" | "insecure" | "unsupported" | "ios-install";

export function PushCard({ isAdmin }: { isAdmin: boolean }) {
  const [support, setSupport] = useState<Support>("checking");
  const [key, setKey] = useState<string | null>(null);
  const [subs, setSubs] = useState<Sub[]>([]);
  const [mine, setMine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api<{ publicKey: string | null; subscriptions: Sub[] }>("/api/push");
    setKey(r.publicKey);
    setSubs(r.subscriptions);
  }, []);

  useEffect(() => {
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    const standalone = window.matchMedia("(display-mode: standalone)").matches;
    if (!window.isSecureContext) setSupport("insecure");
    else if (!("serviceWorker" in navigator) || !("PushManager" in window)) setSupport(ios && !standalone ? "ios-install" : "unsupported");
    else setSupport("ok");
    void load().catch(() => {});
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.getRegistration("/").then(async (reg) => {
        const s = await reg?.pushManager.getSubscription();
        setMine(s?.endpoint ?? null);
      });
    }
  }, [load]);

  const current = subs.find((s) => s.endpoint === mine) ?? null;
  const others = subs.filter((s) => s.endpoint !== mine);

  async function enable() {
    if (!key) {
      toast({ title: "The engine is not running", body: "Notifications are sent by the engine, so it has to be up to subscribe.", tone: "bad" });
      return;
    }
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        toast({ title: "Notifications are blocked", body: "Allow notifications for this site in the browser's site settings, then try again.", tone: "warn" });
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (sub?.options.applicationServerKey && bytesToB64url(sub.options.applicationServerKey) !== key) {
        await sub.unsubscribe();
        sub = null;
      }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) });
      const j = sub.toJSON();
      await api("/api/push", { body: { endpoint: j.endpoint, keys: j.keys, label: deviceLabel(), categories: CATS.map((c) => c.id) } });
      setMine(sub.endpoint);
      await load();
      toast({ title: "Notifications on", body: "Send a test to make sure they arrive.", tone: "ok" });
    } catch (e) {
      toast({ title: "Could not turn on notifications", body: (e as Error).message, tone: "bad" });
    } finally {
      setBusy(false);
    }
  }

  async function disable(endpoint: string) {
    setBusy(true);
    try {
      if (endpoint === mine) {
        const reg = await navigator.serviceWorker.getRegistration("/");
        await (await reg?.pushManager.getSubscription())?.unsubscribe();
        setMine(null);
      }
      await api("/api/push", { method: "DELETE", body: { endpoint } });
      await load();
    } catch (e) {
      toast({ title: "Could not remove the device", body: (e as Error).message, tone: "bad" });
    } finally {
      setBusy(false);
    }
  }

  async function setCategory(sub: Sub, cat: string, on: boolean) {
    const categories = on ? [...new Set([...sub.categories, cat])] : sub.categories.filter((c) => c !== cat);
    setSubs((all) => all.map((s) => (s.endpoint === sub.endpoint ? { ...s, categories } : s)));
    try {
      await api("/api/push", { method: "PATCH", body: { endpoint: sub.endpoint, categories } });
    } catch (e) {
      toast({ title: "Not saved", body: (e as ApiError).message, tone: "bad" });
      void load();
    }
  }

  async function test() {
    try {
      const r = await api<{ ok: boolean; detail: string }>("/api/engine/push/test", { body: {} });
      if (r.ok) toast({ title: "Test notification sent", body: r.detail, tone: "ok", timeout: 5000 });
      else toast({ title: "Nothing was delivered", body: "No device accepted the test. Turn this device off and on again.", tone: "warn" });
    } catch (e) {
      toast({ title: "Test failed", body: (e as Error).message, tone: "bad" });
    }
  }

  async function digest() {
    try {
      const r = await api<{ detail: string }>("/api/engine/digest/test", { body: {} });
      toast({ title: "Summary sent", body: r.detail, tone: "ok" });
    } catch (e) {
      toast({ title: "Summary failed", body: (e as Error).message, tone: "bad" });
    }
  }

  return (
    <Card title="Notifications on this device" actions={current ? <Badge tone="ok">on</Badge> : support === "ok" ? <Badge>off</Badge> : null}>
      {support === "insecure" ? (
        <p className="text-sm text-muted">Browsers only allow notifications over HTTPS. Open Zerobeat at its https address.</p>
      ) : support === "ios-install" ? (
        <p className="text-sm text-muted">On iPhone and iPad, add Zerobeat to the Home Screen first (Share, then Add to Home Screen), open it from there, and come back to this page.</p>
      ) : support === "unsupported" ? (
        <p className="text-sm text-muted">This browser cannot receive push notifications.</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted">Get a notification on your phone or desktop when a station you need shows up, when transmit stops for a fault, and a summary each day. Works with Zerobeat closed.</p>
          {!current ? (
            <Button variant="primary" disabled={busy || support !== "ok"} onClick={enable}>
              Turn on for this device
            </Button>
          ) : (
            <div className="space-y-3">
              {CATS.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-start gap-3">
                  <input type="checkbox" className="mt-1 accent-[var(--color-accent)]" checked={current.categories.includes(c.id)} onChange={(e) => void setCategory(current, c.id, e.target.checked)} />
                  <span>
                    <span className="text-sm text-fg">{c.label}</span>
                    <span className="block text-xs text-muted">{c.help}</span>
                  </span>
                </label>
              ))}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" onClick={test}>
                  Send a test
                </Button>
                {isAdmin && (
                  <Button size="sm" onClick={digest}>
                    Send the summary now
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void disable(current.endpoint)}>
                  Turn off
                </Button>
              </div>
            </div>
          )}
          {others.length > 0 && (
            <div className="border-t border-line pt-3">
              <div className="mb-1.5 text-xs text-subtle">Your other devices</div>
              {others.map((s) => (
                <div key={s.endpoint} className="flex items-center justify-between py-1 text-sm">
                  <span className={cn(s.failures > 2 && "text-warn")}>
                    {s.label ?? "Device"}
                    {s.failures > 2 && " (not reachable)"}
                  </span>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void disable(s.endpoint)}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
