"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge, Button, Card, Empty, Notice } from "@/components/ui";
import { api } from "@/lib/client/api";
import { utcDateTime } from "@/lib/format";

interface Row {
  id: string;
  status: string;
  to: string;
  subject: string;
  body: string;
  error: string | null;
  sentAt: number | null;
  createdAt: number;
  call: string;
  band: string;
  mode: string;
  at: number;
}

const TONE: Record<string, "neutral" | "info" | "ok" | "bad"> = { queued: "neutral", approved: "info", sent: "ok", failed: "bad" };

export function QslQueue({ rows, canOperate }: { rows: Row[]; canOperate: boolean }) {
  const router = useRouter();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const waiting = rows.filter((r) => r.status === "queued" || r.status === "failed");

  async function act(body: unknown, label: string) {
    setMsg(null);
    try {
      const r = await api<{ changed?: number; detail?: string }>("/api/qsl", { body });
      setMsg(r.detail ?? `${label}: ${r.changed ?? 0}`);
      setSel(new Set());
      router.refresh();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <Card
      title="Queue"
      pad={false}
      actions={
        canOperate && (
          <>
            <Button size="sm" disabled={!sel.size} onClick={() => act({ action: "cancel", ids: [...sel] }, "Canceled")}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={!sel.size} onClick={() => act({ action: "approve", ids: [...sel] }, "Approved")}>
              Approve {sel.size || ""}
            </Button>
            <Button size="sm" onClick={() => act({ action: "send-now" }, "Sent")}>
              Send approved now
            </Button>
          </>
        )
      }
    >
      {msg && (
        <div className="p-3">
          <Notice>{msg}</Notice>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="p-4">
          <Empty>Nothing queued.</Empty>
        </div>
      ) : (
        <div className="divide-y divide-line">
          {waiting.length > 0 && canOperate && (
            <label className="flex items-center gap-2 px-4 py-2 text-xs text-muted">
              <input type="checkbox" checked={sel.size === waiting.length} onChange={(e) => setSel(e.target.checked ? new Set(waiting.map((r) => r.id)) : new Set())} /> select all waiting ({waiting.length})
            </label>
          )}
          {rows.map((r) => (
            <div key={r.id} className="px-4 py-2">
              <div className="flex items-center gap-3 text-sm">
                {canOperate && (r.status === "queued" || r.status === "failed") ? (
                  <input
                    type="checkbox"
                    checked={sel.has(r.id)}
                    onChange={(e) =>
                      setSel((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(r.id);
                        else n.delete(r.id);
                        return n;
                      })
                    }
                  />
                ) : (
                  <span className="w-[13px]" />
                )}
                <span className="w-24 font-mono font-medium">{r.call}</span>
                <span className="text-xs text-muted">
                  {utcDateTime(r.at)} {r.band.toLowerCase()} {r.mode}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted">{r.to}</span>
                <Badge tone={TONE[r.status] ?? "neutral"}>{r.status === "cancelled" ? "canceled" : r.status}</Badge>
                <button className="text-xs text-accent-strong hover:underline" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  {open === r.id ? "hide" : "view"}
                </button>
              </div>
              {r.error && <div className="mt-1 pl-7 text-xs text-bad">{r.error}</div>}
              {open === r.id && (
                <div className="mt-2 rounded-md border border-line bg-bg p-3 text-sm">
                  <div className="mb-2 font-medium">{r.subject}</div>
                  <pre className="whitespace-pre-wrap font-sans text-muted">{r.body}</pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function CardDesigner({ admin }: { admin: boolean }) {
  // 0 until the first change: a clock value differed between the server render and the
  // browser (a hydration mismatch). The card route sends no-store, so 0 is fresh.
  const [v, setV] = useState(0);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  async function upload(file: File) {
    const fd = new FormData();
    fd.set("file", file);
    try {
      const r = await api<{ width: number; height: number }>("/api/qsl/card", { body: fd });
      setMsg({ tone: "ok", text: `Artwork saved (${r.width}×${r.height}).` });
      setV(Date.now());
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    }
  }
  return (
    <div className="grid gap-4 md:grid-cols-[1fr_260px]">
      <img src={`/api/qsl/card?v=${v}`} alt="QSL card preview with your latest contact" className="w-full rounded-md border border-line" />
      <div className="space-y-3 text-sm text-muted">
        <p>The preview uses your most recent contact. Table position and colors are under QSL settings.</p>
        {admin && (
          <label className="block">
            <span className="mb-1 block text-xs">Upload artwork (PNG or JPEG, landscape)</span>
            <input type="file" accept="image/png,image/jpeg" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-panel-3 file:px-3 file:py-1.5 file:text-fg" />
          </label>
        )}
        <Button size="sm" variant="ghost" onClick={() => setV(Date.now())}>
          Refresh preview
        </Button>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      </div>
    </div>
  );
}
