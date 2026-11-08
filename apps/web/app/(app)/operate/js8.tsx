"use client";
/**
 * JS8 on the Operate page, laid out like JS8Call: band activity (each offset's latest
 * message), the conversation with whoever is selected, a composer with JS8Call's
 * directed commands, and on the side the stations heard, the inbox and logging.
 * Settings are under Settings → Operating → JS8.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge, Button, Card, cn, Input } from "@/components/ui";
import { gridDistanceKm } from "@zerobeat/core/ham/grid";
import { useLive, type EngineSnapshot, type Js8Message } from "@/lib/client/live";
import { utcTime } from "@/lib/format";

import { CycleBar } from "./cycle-bar";
import { fmtDistance } from "@/lib/distance";

type Run = (path: string, body?: unknown) => Promise<boolean>;
type Props = { snap: EngineSnapshot; run: Run; busy: boolean; canOperate: boolean; selected: string | null; setSelected: (c: string | null) => void };

export const JS8_PERIOD_SEC = { normal: 15, fast: 10, turbo: 6, slow: 30 } as const;
/** JS8Call's directed commands, as its "Directed" menu offers them. */
const COMMANDS: { cmd: string; help: string }[] = [
  { cmd: "SNR?", help: "How well do you hear me?" },
  { cmd: "GRID?", help: "What is your grid?" },
  { cmd: "INFO?", help: "Your station info" },
  { cmd: "STATUS?", help: "Your status" },
  { cmd: "HEARING?", help: "Who are you hearing?" },
  { cmd: "QUERY MSGS", help: "Do you have messages for me?" },
  { cmd: "AGN?", help: "Send that again" },
  { cmd: "ACK", help: "Acknowledge" },
];

function useJs8Messages(): Js8Message[] {
  const { js8Messages: live } = useLive();
  const [initial, setInitial] = useState<Js8Message[]>([]);
  useEffect(() => {
    void fetch("/api/engine/js8", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { messages: Js8Message[] } | null) => j && setInitial(j.messages))
      .catch(() => {});
  }, []);
  return useMemo(() => {
    const byId = new Map<string, Js8Message>();
    for (const m of [...initial, ...live]) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => a.startMs - b.startMs);
  }, [initial, live]);
}

export function Js8Panel({ snap, run, busy, canOperate, selected, setSelected }: Props) {
  const messages = useJs8Messages();
  const j = snap.js8;
  const me = snap.station?.callsign?.toUpperCase() ?? "";
  const [text, setText] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const convoRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Band activity: the latest message at each offset, newest first.
  const band = useMemo(() => {
    const at = new Map<number, Js8Message>();
    for (const m of messages) {
      if (m.dir !== "rx") continue;
      const k = Math.round(m.freqHz / 25);
      const old = at.get(k);
      if (!old || old.updatedMs <= m.updatedMs) at.set(k, m);
    }
    return [...at.values()].filter((m) => now - m.updatedMs < 30 * 60_000).sort((a, b) => b.updatedMs - a.updatedMs).slice(0, 60);
  }, [messages, now]);
  // The conversation: what is to or from us, or with the selected station.
  const convo = useMemo(() => messages.filter((m) => m.dir === "tx" || m.toUs || (selected && (m.from === selected || m.to === selected))).slice(-150), [messages, selected]);
  useEffect(() => {
    const el = convoRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [convo.length, convo.at(-1)?.text]);

  const period = JS8_PERIOD_SEC[j.submode] ?? 15;
  const left = Math.ceil(period - ((now / 1000) % period));
  async function send(t: string) {
    if (!canOperate || !t.trim()) return;
    if (await run("/js8/send", { text: t })) setText("");
  }
  const to = selected ?? "@ALLCALL";

  return (
    <div className="space-y-4">
      <Card
        pad={false}
        title={
          <span className="flex items-center gap-2">
            JS8 <span className="font-normal capitalize text-muted">{j.submode}</span>
            <span className="text-xs font-normal text-muted">
              {snap.radio.link !== "connected" ? "radio disconnected" : j.sending ? `sending frame ${j.sending.sent + 1} of ${j.sending.frames}` : `listening · next period in ${left} s`}
              {j.autoReply ? " · AUTO" : ""}
            </span>
          </span>
        }
        actions={
          <Link href="/settings/operating" className="text-xs text-muted hover:text-fg">
            JS8 settings
          </Link>
        }
      >
        <CycleBar periodSec={period} engineNow={snap.now} transmitting={snap.radio.transmitting} />
        {j.lastDecode && (
          <div className="border-b border-line px-3 py-1.5 text-[11px] text-subtle">
            {utcTime(j.lastDecode.at, true)}Z period: {j.lastDecode.error ? j.lastDecode.error : `${j.lastDecode.count} frame${j.lastDecode.count === 1 ? "" : "s"} in ${(j.lastDecode.ms / 1000).toFixed(1)} s`}
          </div>
        )}
        <div className="max-h-72 overflow-y-auto font-mono text-[12px]">
          {band.length === 0 ? (
            <div className="px-4 py-8 text-center font-sans text-sm text-muted">Nothing heard yet. JS8 frames decode at the end of each {period}-second period.</div>
          ) : (
            band.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  if (m.from) setSelected(m.from);
                  if (canOperate) void run("/tx-offset", { hz: m.freqHz });
                }}
                className={cn("grid w-full grid-cols-[62px_46px_36px_1fr] gap-2 px-3 py-[3px] text-left hover:bg-panel-2", m.from && m.from === selected && "bg-accent-soft")}
              >
                <span className="text-subtle">{utcTime(m.updatedMs, true)}</span>
                <span className="text-right tabular text-muted">{m.freqHz}</span>
                <span className={cn("text-right tabular", m.snr >= -10 ? "text-fg" : "text-muted")}>{m.snr}</span>
                <span className={cn("truncate", m.toUs ? "text-me" : "text-fg")}>
                  {m.text}
                  {!m.complete && <span className="ml-1 text-subtle">…</span>}
                </span>
              </button>
            ))
          )}
        </div>
      </Card>

      <Card
        pad={false}
        title={
          <span className="flex items-center gap-2">
            {selected ? `With ${selected}` : "Directed to you"}
            {selected && (
              <button type="button" onClick={() => setSelected(null)} className="text-xs font-normal text-muted hover:text-fg">
                clear
              </button>
            )}
          </span>
        }
      >
        <div ref={convoRef} className="h-56 overflow-y-auto px-3 py-2 font-mono text-[13px] leading-6">
          {convo.length === 0 && <div className="py-8 text-center font-sans text-sm text-muted">Messages to {me || "you"}, @ALLCALL and your groups appear here. Click a station above to follow it.</div>}
          {convo.map((m) => (
            <div key={m.id} className="grid grid-cols-[62px_1fr_auto] gap-x-2">
              <span className="text-subtle">{utcTime(m.startMs, true)}</span>
              <span className={cn("break-words", m.dir === "tx" ? "text-accent-strong" : m.toUs ? "text-me" : "text-fg")}>
                {m.text}
                {!m.complete && <span className="ml-1 animate-pulse text-subtle">▌</span>}
              </span>
              <span className="text-[11px] text-subtle">{m.dir === "rx" ? `${m.snr} dB` : ""}</span>
            </div>
          ))}
          {j.sending && (
            <div className="grid grid-cols-[62px_1fr_auto] gap-x-2 opacity-80">
              <span className="text-subtle">TX</span>
              <span className="text-accent-strong">{j.sending.text}</span>
              <span className="text-[11px] text-subtle">
                {j.sending.sent}/{j.sending.frames}
              </span>
            </div>
          )}
          {j.queued.map((q, i) => (
            <div key={i} className="grid grid-cols-[62px_1fr] gap-x-2 opacity-60">
              <span className="text-subtle">queued</span>
              <span className="text-accent-strong">{q}</span>
            </div>
          ))}
        </div>
        {canOperate && (
          <div className="space-y-2 border-t border-line px-3 py-3">
            <div className="flex flex-wrap gap-1">
              <Button size="sm" disabled={busy} onClick={() => void send(`@ALLCALL CQ CQ CQ ${snap.station?.grid?.slice(0, 4) ?? ""}`)} title="CQ to @ALLCALL with your grid">
                CQ
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void run("/js8/hb")} title="A heartbeat in the 500–1000 Hz heartbeat sub-band">
                HB
              </Button>
              {COMMANDS.map((c) => (
                <Button key={c.cmd} size="sm" variant="ghost" disabled={busy} title={`${to} ${c.cmd}: ${c.help}`} onClick={() => setText(`${to} ${c.cmd}`)}>
                  {c.cmd}
                </Button>
              ))}
              {selected && (
                <Button size="sm" variant="ghost" disabled={busy} title={`Leave a message for ${selected}; MSG TO: CALL leaves one for ${selected} to relay`} onClick={() => setText(`${selected} MSG `)}>
                  MSG
                </Button>
              )}
            </div>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send(text);
              }}
            >
              <Input value={text} onChange={(e) => setText(e.target.value.toUpperCase())} placeholder={selected ? `${selected} …` : "@ALLCALL … or CALLSIGN …"} className="flex-1 font-mono" maxLength={400} />
              <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
                Send
              </Button>
              <Button type="button" variant="danger" disabled={busy || (!j.sending && j.queued.length === 0)} onClick={() => void run("/js8/halt")}>
                Halt
              </Button>
            </form>
            <div className="text-[11px] text-subtle">Text goes out one frame per period. A directed message starts with the call it is for; your own call is added for you.</div>
          </div>
        )}
      </Card>
    </div>
  );
}

function snrText(snr: number): string {
  return `${snr >= 0 ? "+" : "-"}${String(Math.abs(snr)).padStart(2, "0")}`;
}

export function Js8SideCard({ snap, run, busy, canOperate, selected, setSelected }: Props) {
  const j = snap.js8;
  const myGrid = snap.station?.grid ?? "";
  const heard = selected ? j.heard.find((h) => h.call === selected) : undefined;
  const [form, setForm] = useState({ sent: "", rcvd: "", notes: "" });
  const heardSnr = heard?.snr;
  useEffect(() => setForm({ sent: heardSnr !== undefined ? snrText(heardSnr) : "", rcvd: "", notes: "" }), [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {selected && canOperate && (
        <Card title={`Log ${selected}`}>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run("/js8/log", { callsign: selected, rstSent: form.sent, rstRcvd: form.rcvd, grid: heard?.grid ?? null, notes: form.notes });
            }}
          >
            <div className="grid grid-cols-2 gap-2">
              <Input value={form.sent} onChange={(e) => setForm({ ...form, sent: e.target.value })} placeholder="Sent" />
              <Input value={form.rcvd} onChange={(e) => setForm({ ...form, rcvd: e.target.value })} placeholder="Rcvd" />
            </div>
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Notes" />
            <div className="flex items-center gap-3">
              <Button type="submit" variant="primary" size="sm" disabled={busy}>
                Log contact
              </Button>
              {heard?.grid && <span className="font-mono text-xs text-muted">{heard.grid}</span>}
            </div>
          </form>
        </Card>
      )}
      <Card title="Heard" pad={false}>
        {j.heard.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted">No stations yet.</div>
        ) : (
          <div className="max-h-64 overflow-y-auto text-[12px]">
            {j.heard.map((h) => {
              const km = h.grid && myGrid ? gridDistanceKm(myGrid, h.grid) : null;
              return (
                <button key={h.call} type="button" onClick={() => setSelected(h.call)} className={cn("grid w-full grid-cols-[1fr_44px_36px_64px] gap-2 px-3 py-1 text-left font-mono hover:bg-panel-2", h.call === selected && "bg-accent-soft")}>
                  <span className="truncate text-fg">{h.call}</span>
                  <span className="text-muted">{h.grid?.slice(0, 4) ?? ""}</span>
                  <span className="text-right tabular text-muted">{h.snr}</span>
                  <span className="text-right text-subtle">{km !== null ? fmtDistance(km, snap.distanceUnit ?? "mi") : utcTime(h.at)}</span>
                </button>
              );
            })}
          </div>
        )}
      </Card>
      <Card title="Inbox" pad={false}>
        {j.inbox.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted">No stored messages. Messages left for you, or for stations you relay to, are kept here.</div>
        ) : (
          <div className="divide-y divide-line text-[12px]">
            {j.inbox.map((m) => (
              <div key={m.id} className="px-3 py-2">
                <div className="flex items-center gap-2 text-subtle">
                  <span className="font-mono text-fg">{m.from}</span>→<span className="font-mono">{m.to}</span>
                  <span>{utcTime(m.at)}Z</span>
                  {m.to !== snap.station?.callsign?.toUpperCase() && <Badge tone={m.delivered ? "ok" : "warn"}>{m.delivered ? "delivered" : "holding"}</Badge>}
                  {canOperate && (
                    <button type="button" className="ml-auto text-muted hover:text-bad" onClick={() => void run("/js8/inbox/delete", { id: m.id })}>
                      delete
                    </button>
                  )}
                </div>
                <div className="mt-1 font-mono text-fg">{m.text}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
