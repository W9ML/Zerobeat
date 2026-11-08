"use client";
/**
 * Radio time: book the radio, see everyone's bookings on a week of day bars, cancel your
 * own. Times are entered and shown in this browser's time zone, with UTC alongside.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge, Button, Card, cn, Empty, Field, Input, Notice } from "@/components/ui";
import { useLive } from "@/lib/client/live";

interface Booking {
  id: string;
  userId: string;
  name: string;
  callsign: string | null;
  startsAt: number;
  endsAt: number;
  note: string;
}

const DAY = 86_400_000;
const DAYS = 7;

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const localTime = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const utc = (t: number) => new Date(t).toISOString().slice(11, 16);
const dayLabel = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const who = (b: Booking) => b.callsign ?? b.name;

/** Midnight (local) of the day `t` is in. */
function dayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A local date and time ("2026-11-07", "14:30") as ms. */
function at(date: string, time: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(y!, mo! - 1, d!, h!, mi!).getTime();
}

export function BookingsView({ canBook }: { canBook: boolean }) {
  const { snap } = useLive();
  const [list, setList] = useState<Booking[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [admin, setAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    const from = dayStart(Date.now());
    const r = await fetch(`/api/bookings?from=${from}&to=${from + 31 * DAY}`, { cache: "no-store" }).catch(() => null);
    if (!r?.ok) {
      setError("Couldn't load the bookings.");
      return;
    }
    const j = (await r.json()) as { bookings: Booking[]; me: string | null; admin: boolean };
    setList(j.bookings);
    setMe(j.me);
    setAdmin(j.admin);
  }, []);

  useEffect(() => {
    void load();
    // Others book too: look again now and then.
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  // The form: today, from the next quarter hour, for an hour.
  const q = Math.ceil(now / 900_000) * 900_000;
  const [date, setDate] = useState(() => localDate(q));
  const [from, setFrom] = useState(() => localTime(q));
  const [to, setTo] = useState(() => localTime(q + 3_600_000));
  const [note, setNote] = useState("");
  const startsAt = date && from ? at(date, from) : NaN;
  // An end at or before the start is the next day ("22:00 to 01:00").
  const endsAt = date && to ? at(date, to) + (at(date, to) <= startsAt ? DAY : 0) : NaN;

  async function book() {
    setBusy(true);
    setError(null);
    const r = await fetch("/api/bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ startsAt, endsAt, note }) }).catch(() => null);
    setBusy(false);
    if (!r) return setError("Couldn't reach Zerobeat.");
    if (!r.ok) return setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't book that.");
    setNote("");
    void load();
  }

  async function cancel(b: Booking) {
    const on = b.startsAt <= Date.now();
    if (!window.confirm(on ? `End ${b.userId === me ? "your" : `${who(b)}'s`} booking now?` : `Cancel ${b.userId === me ? "your" : `${who(b)}'s`} booking, ${dayLabel(b.startsAt)} ${localTime(b.startsAt)}–${localTime(b.endsAt)}?`)) return;
    setBusy(true);
    setError(null);
    const r = await fetch(`/api/bookings?id=${encodeURIComponent(b.id)}`, { method: "DELETE" }).catch(() => null);
    setBusy(false);
    if (!r?.ok) setError(((await r?.json().catch(() => ({}))) as { error?: string } | undefined)?.error ?? "Couldn't cancel that.");
    void load();
  }

  const upcoming = useMemo(() => (list ?? []).filter((b) => b.endsAt > now), [list, now]);
  const holding = snap?.radio.booking;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="space-y-4">
      {error && <Notice tone="bad">{error}</Notice>}

      {canBook && (
        <Card title="Book the radio">
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_2fr_auto] sm:items-end">
            <Field label="Day">
              <Input type="date" value={date} min={localDate(Date.now())} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="From">
              <Input type="time" step={300} value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To">
              <Input type="time" step={300} value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Field label="Note (optional)">
              <Input value={note} maxLength={120} placeholder="40 m Hell net, contest, …" onChange={(e) => setNote(e.target.value)} />
            </Field>
            <Button variant="primary" disabled={busy || !Number.isFinite(startsAt) || !Number.isFinite(endsAt)} onClick={() => void book()}>
              Book
            </Button>
          </div>
          {Number.isFinite(startsAt) && Number.isFinite(endsAt) && (
            <p className="mt-2 text-xs text-muted">
              {dayLabel(startsAt)} {localTime(startsAt)}–{localTime(endsAt)}
              {localDate(endsAt) !== localDate(startsAt) ? " (next day)" : ""} your time ({tz}), {utc(startsAt)}–{utc(endsAt)}Z. 15 minutes to 8 hours, up to 30 days ahead.
            </p>
          )}
        </Card>
      )}

      <Card title="The next 7 days" actions={<span className="text-xs text-muted">your time ({tz})</span>}>
        {list === null ? <p className="text-sm text-muted">Loading…</p> : <Week list={list} me={me} now={now} />}
      </Card>

      <Card title="Coming up">
        {list === null ? null : upcoming.length === 0 ? (
          <Empty>Nobody has booked the radio. It goes to whoever wants it.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {upcoming.map((b) => {
              const on = b.startsAt <= now;
              const mine = b.userId === me;
              return (
                <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm" data-booking={b.id}>
                  <span className="w-28 text-muted">{dayLabel(b.startsAt)}</span>
                  <span className="font-mono text-fg">
                    {localTime(b.startsAt)}–{localTime(b.endsAt)}
                  </span>
                  <span className="font-mono text-xs text-subtle">
                    {utc(b.startsAt)}–{utc(b.endsAt)}Z
                  </span>
                  <span className={cn("font-medium", mine ? "text-accent-strong" : "text-fg")}>{mine ? "You" : who(b)}</span>
                  {b.note && <span className="text-muted">{b.note}</span>}
                  {on &&
                    (holding?.current?.id === b.id && holding.holding ? (
                      <Badge tone="ok">on now: the radio is theirs</Badge>
                    ) : (
                      <Badge tone="neutral" title="Their booking holds the radio only while they have Zerobeat open">
                        on now, not signed in: radio open
                      </Badge>
                    ))}
                  {(mine || admin) && (
                    <Button size="sm" className="ml-auto" disabled={busy} onClick={() => void cancel(b)}>
                      {on ? "End now" : "Cancel"}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** Seven day bars, midnight to midnight, the bookings on them; yours in the accent colour. */
function Week({ list, me, now }: { list: Booking[]; me: string | null; now: number }) {
  const first = dayStart(now);
  const days = Array.from({ length: DAYS }, (_, i) => {
    const d = new Date(first);
    d.setDate(d.getDate() + i);
    return d.getTime();
  });
  return (
    <div className="space-y-1.5">
      <div className="ml-24 flex text-[10px] text-subtle">
        {[0, 6, 12, 18].map((h) => (
          <span key={h} className="w-1/4">
            {pad(h)}:00
          </span>
        ))}
      </div>
      {days.map((d0) => {
        // The next local midnight (a day is not always 24 hours: daylight saving).
        const n = new Date(d0);
        n.setDate(n.getDate() + 1);
        const d1 = n.getTime();
        const len = d1 - d0;
        const on = list.filter((b) => b.startsAt < d1 && b.endsAt > d0);
        return (
          <div key={d0} className="flex items-center gap-2">
            <span className="w-22 shrink-0 text-xs text-muted">{dayLabel(d0)}</span>
            <div className="relative h-7 flex-1 overflow-hidden rounded border border-line bg-panel-2">
              {[6, 12, 18].map((h) => (
                <span key={h} className="absolute inset-y-0 w-px bg-line" style={{ left: `${(h / 24) * 100}%` }} />
              ))}
              {on.map((b) => {
                const a = Math.max(b.startsAt, d0);
                const e = Math.min(b.endsAt, d1);
                const mine = b.userId === me;
                return (
                  <span
                    key={b.id}
                    className={cn("absolute inset-y-0.5 overflow-hidden rounded-sm px-1 text-[10px] leading-6 whitespace-nowrap", mine ? "bg-accent text-white" : "bg-panel-3 text-fg ring-1 ring-line-strong")}
                    style={{ left: `${((a - d0) / len) * 100}%`, width: `${Math.max(0.6, ((e - a) / len) * 100)}%` }}
                    title={`${mine ? "You" : who(b)} ${localTime(b.startsAt)}–${localTime(b.endsAt)} (${utc(b.startsAt)}–${utc(b.endsAt)}Z)${b.note ? `: ${b.note}` : ""}`}
                  >
                    {mine ? "You" : who(b)}
                  </span>
                );
              })}
              {now >= d0 && now < d1 && <span className="absolute inset-y-0 w-0.5 bg-bad" style={{ left: `${((now - d0) / len) * 100}%` }} title="Now" />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
