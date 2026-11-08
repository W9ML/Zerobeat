"use client";
/**
 * Manual entry and editing. Looks the callsign up (QRZ or HamDB, plus DXCC and the log)
 * as you type, fills empty fields only, and warns about a same-band same-mode dupe.
 * A browser-generated clientId makes a retried submit idempotent.
 */
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge, Button, Card, Field, Input, Notice, Select, Textarea } from "@/components/ui";
import { BANDS as ALL_BANDS, bandForHz } from "@zerobeat/core/ham/bands";

import { api } from "@/lib/client/api";
import { utcDate, utcDateTime } from "@/lib/format";

export interface QsoFormValues {
  callsign: string;
  date: string;
  time: string;
  freqMHz: string;
  band: string;
  mode: string;
  rstSent: string;
  rstRcvd: string;
  txPowerW: string;
  grid: string;
  name: string;
  qth: string;
  state: string;
  county: string;
  email: string;
  parks: string;
  mySigInfo: string;
  notes: string;
  qslSent: string;
  qslRcvd: string;
}

const MODES = ["SSB", "CW", "FT8", "FT4", "FT2", "RTTY", "FM", "AM", "PSK31", "HELL", "JS8", "Q65"];
// Every ADIF band, so a frequency typed on 4 m or 23 cm has a band to land on.
const BANDS = ALL_BANDS.map((b) => b.name);

interface Lookup {
  dxcc: { name: string; continent: string; cqZone: number } | null;
  info: { name: string | null; qth: string | null; state: string | null; county: string | null; grid: string | null; email: string | null; source: string } | null;
  worked: { total: number; thisBand: number; thisBandMode: number; today: number; last: { startTime: number; band: string; mode: string; submode: string | null } | null };
}

function now(): { date: string; time: string } {
  const d = new Date();
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
}

/**
 * The idempotency key for one manual entry. crypto.randomUUID exists only in a secure
 * context (HTTPS or localhost); on a plain-HTTP LAN install it is undefined, and the old
 * code threw here after the first save, so every later save reused the first key and the
 * server quietly returned the first contact instead of logging a new one.
 */
function newClientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function QsoForm({ initial, id, stationGrid }: { initial?: Partial<QsoFormValues>; id?: string; stationGrid?: string }) {
  const router = useRouter();
  const blank = useMemo<QsoFormValues>(
    () => ({
      callsign: "",
      ...now(),
      freqMHz: "",
      band: "20M",
      mode: "SSB",
      rstSent: "59",
      rstRcvd: "59",
      txPowerW: "",
      grid: "",
      name: "",
      qth: "",
      state: "",
      county: "",
      email: "",
      parks: "",
      mySigInfo: "",
      notes: "",
      qslSent: "NONE",
      qslRcvd: "NONE",
      ...initial,
    }),
    [initial],
  );
  const [v, setV] = useState<QsoFormValues>(blank);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clientId = useRef(newClientId());
  const touched = useRef(new Set<keyof QsoFormValues>());

  const set = (k: keyof QsoFormValues, val: string) => {
    touched.current.add(k);
    setV((s) => {
      const next = { ...s, [k]: val };
      // Typing a frequency picks the band, so the two can't disagree.
      if (k === "freqMHz") {
        const mhz = Number(val.replace(",", "."));
        const b = Number.isFinite(mhz) && mhz > 0 ? bandForHz(Math.round(mhz * 1e6))?.name : undefined;
        if (b) next.band = b;
      }
      return next;
    });
  };

  useEffect(() => {
    const call = v.callsign.trim().toUpperCase();
    if (call.length < 3 || !/\d/.test(call)) {
      setLookup(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const l = await api<Lookup>(`/api/lookup/${encodeURIComponent(call)}?band=${v.band}&mode=${v.mode}`);
        setLookup(l);
        if (!id && l.info) {
          setV((s) => ({
            ...s,
            name: touched.current.has("name") || s.name ? s.name : (l.info!.name ?? ""),
            qth: touched.current.has("qth") || s.qth ? s.qth : (l.info!.qth ?? ""),
            grid: touched.current.has("grid") || s.grid ? s.grid : (l.info!.grid ?? ""),
            state: touched.current.has("state") || s.state ? s.state : (l.info!.state ?? ""),
            county: touched.current.has("county") || s.county ? s.county : (l.info!.county ?? ""),
            email: touched.current.has("email") || s.email ? s.email : (l.info!.email ?? ""),
          }));
        }
      } catch {
        setLookup(null);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [v.callsign, v.band, v.mode, id]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const start = Date.parse(`${v.date}T${v.time.length === 5 ? v.time + ":00" : v.time}Z`);
    const body = {
      clientId: id ? undefined : clientId.current,
      callsign: v.callsign,
      startTime: start,
      freqMHz: v.freqMHz ? v.freqMHz.replace(",", ".") : null,
      band: v.band,
      mode: v.mode,
      rstSent: v.rstSent,
      rstRcvd: v.rstRcvd,
      txPowerW: v.txPowerW ? Number(v.txPowerW) : null,
      grid: v.grid,
      name: v.name,
      qth: v.qth,
      state: v.state.toUpperCase(),
      county: v.county,
      email: v.email,
      parks: v.parks
        .split(/[,\s]+/)
        .map((p) => p.trim().toUpperCase())
        .filter(Boolean),
      mySigInfo: v.mySigInfo,
      notes: v.notes,
      qslSent: v.qslSent,
      qslRcvd: v.qslRcvd,
    };
    try {
      if (id) {
        await api(`/api/qsos/${id}`, { method: "PATCH", body });
        router.push(`/log/${id}`);
        router.refresh();
      } else {
        await api("/api/qsos", { body });
        clientId.current = newClientId();
        touched.current.clear();
        setV({ ...blank, ...now(), band: v.band, mode: v.mode, freqMHz: v.freqMHz, mySigInfo: v.mySigInfo, txPowerW: v.txPowerW });
        setLookup(null);
        setError(null);
        router.refresh();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const w = lookup?.worked;
  return (
    <form onSubmit={submit} className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Card>
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Callsign" className="sm:col-span-2">
            <Input value={v.callsign} onChange={(e) => set("callsign", e.target.value.toUpperCase())} required autoFocus className="font-mono text-base uppercase" />
          </Field>
          <Field label="Date (UTC)">
            <Input type="date" value={v.date} onChange={(e) => set("date", e.target.value)} required />
          </Field>
          <Field label="Time (UTC)">
            <div className="flex gap-1">
              <Input type="time" value={v.time} onChange={(e) => set("time", e.target.value)} required />
              <Button size="sm" variant="ghost" onClick={() => setV((s) => ({ ...s, ...now() }))}>
                Now
              </Button>
            </div>
          </Field>
          <Field label="Frequency (MHz)" help="Sets the band to match">
            <Input inputMode="decimal" value={v.freqMHz} onChange={(e) => set("freqMHz", e.target.value)} placeholder="14.074" className="font-mono" />
          </Field>
          <Field label="Band">
            <Select value={v.band} onChange={(e) => set("band", e.target.value)}>
              {BANDS.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </Select>
          </Field>
          <Field label="Mode">
            <Input list="modes" value={v.mode} onChange={(e) => set("mode", e.target.value.toUpperCase())} required />
            <datalist id="modes">
              {MODES.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Field>
          <Field label="Power (W)">
            <Input inputMode="numeric" value={v.txPowerW} onChange={(e) => set("txPowerW", e.target.value)} />
          </Field>
          <Field label="RST sent">
            <Input value={v.rstSent} onChange={(e) => set("rstSent", e.target.value)} className="font-mono" />
          </Field>
          <Field label="RST received">
            <Input value={v.rstRcvd} onChange={(e) => set("rstRcvd", e.target.value)} className="font-mono" />
          </Field>
          <Field label="Their grid">
            <Input value={v.grid} onChange={(e) => set("grid", e.target.value)} className="font-mono" />
          </Field>
          <Field label="Their park(s)" help="POTA references, comma separated">
            <Input value={v.parks} onChange={(e) => set("parks", e.target.value.toUpperCase())} placeholder="US-1234" className="font-mono" />
          </Field>
          <Field label="Name" className="sm:col-span-2">
            <Input value={v.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="QTH" className="sm:col-span-2">
            <Input value={v.qth} onChange={(e) => set("qth", e.target.value)} />
          </Field>
          <Field label="State">
            <Input value={v.state} onChange={(e) => set("state", e.target.value.toUpperCase())} maxLength={3} />
          </Field>
          <Field label="County">
            <Input value={v.county} onChange={(e) => set("county", e.target.value)} />
          </Field>
          <Field label="Email" className="sm:col-span-2">
            <Input value={v.email} onChange={(e) => set("email", e.target.value)} />
          </Field>
          <Field label="My park (activation)" help={stationGrid ? `Blank = home station (${stationGrid})` : undefined}>
            <Input value={v.mySigInfo} onChange={(e) => set("mySigInfo", e.target.value.toUpperCase())} placeholder="US-4567" className="font-mono" />
          </Field>
          <Field label="Card sent">
            <Select value={v.qslSent} onChange={(e) => set("qslSent", e.target.value)}>
              <option value="NONE">No</option>
              <option value="REQUESTED">Requested</option>
              <option value="SENT">Sent</option>
            </Select>
          </Field>
          <Field label="Card received">
            <Select value={v.qslRcvd} onChange={(e) => set("qslRcvd", e.target.value)}>
              <option value="NONE">No</option>
              <option value="REQUESTED">Requested</option>
              <option value="CONFIRMED">Received</option>
            </Select>
          </Field>
          <Field label="Notes" className="sm:col-span-4">
            <Textarea value={v.notes} onChange={(e) => set("notes", e.target.value)} rows={2} className="min-h-0" />
          </Field>
        </div>
        {error && (
          <div className="mt-4">
            <Notice tone="bad">{error}</Notice>
          </div>
        )}
        <div className="mt-4 flex gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Saving…" : id ? "Save changes" : "Log contact"}
          </Button>
          {id && (
            <Button variant="ghost" onClick={() => router.back()}>
              Cancel
            </Button>
          )}
        </div>
      </Card>
      <div className="space-y-4">
        <Card title="Lookup">
          {!lookup ? (
            <p className="text-sm text-muted">Type a callsign.</p>
          ) : (
            <div className="space-y-2 text-sm">
              {lookup.dxcc && (
                <div>
                  <span className="text-fg">{lookup.dxcc.name}</span>{" "}
                  <span className="text-muted">
                    · {lookup.dxcc.continent} · CQ {lookup.dxcc.cqZone}
                  </span>
                </div>
              )}
              {lookup.info ? (
                <div className="text-muted">
                  {lookup.info.name} {lookup.info.qth && `· ${lookup.info.qth}`}
                  <div className="text-xs text-subtle">from {lookup.info.source === "qrz" ? "QRZ" : "HamDB"}</div>
                </div>
              ) : (
                <div className="text-xs text-subtle">No callbook record.</div>
              )}
              {w && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {w.total === 0 ? <Badge tone="ok">Never worked</Badge> : <Badge>{w.total} before</Badge>}
                  {w.thisBandMode > 0 && <Badge tone="warn">Worked on {v.band} {v.mode}</Badge>}
                  {w.today > 0 && <Badge tone="bad">Dupe today</Badge>}
                </div>
              )}
              {w?.last && <div className="text-xs text-subtle">Last: {utcDateTime(w.last.startTime)} {w.last.band} {w.last.submode ?? w.last.mode}</div>}
            </div>
          )}
        </Card>
        {!id && <p className="px-1 text-xs text-subtle">Contacts are saved to the log immediately. Today is {utcDate(Date.now())} UTC.</p>}
      </div>
    </form>
  );
}
