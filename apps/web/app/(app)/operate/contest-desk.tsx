"use client";
/**
 * The contest desk: pick the contest and what you send, then run it with the score,
 * rate, multipliers, the next serial, and a dupe check against this contest's log.
 * Works in the FT modes and in the keyboard modes; both share the contest's serial.
 */
import { useEffect, useMemo, useState } from "react";

import { Badge, Card, cn, Select } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { EngineSnapshot } from "@/lib/client/live";
import { utcDateTime } from "@/lib/format";

type Run = (path: string, body?: unknown) => Promise<boolean>;
type ContestId = EngineSnapshot["auto"]["contest"]["id"];

const OPTS: { id: ContestId; label: string; help: string; placeholder: string }[] = [
  { id: "none", label: "No contest", help: "", placeholder: "" },
  { id: "field-day", label: "ARRL Field Day", help: "Sends class and section, e.g. 1D WI.", placeholder: "1D WI" },
  { id: "rtty-roundup", label: "ARRL RTTY Roundup", help: "Sends 599 and your state or province; blank or DX sends a serial.", placeholder: "WI" },
  { id: "ww-digi", label: "WW Digi DX", help: "Sends your 4-character grid.", placeholder: "" },
  { id: "arrl-digi", label: "ARRL Digi", help: "Sends your 4-character grid.", placeholder: "" },
];

interface SheetRow {
  call: string;
  band: string;
  group: string;
  at: number;
  points: number;
  mults: string[];
  dupe: boolean;
  invalid: string | null;
  exchange: string;
}

/** A UTC time for <input type="datetime-local">, and back. */
const toLocalInput = (ms: number) => new Date(ms).toISOString().slice(0, 16);
const fromLocalInput = (s: string) => Date.parse(`${s}:00Z`);

export function ContestDesk({ snap, run, busy, canOperate }: { snap: EngineSnapshot; run: Run; busy: boolean; canOperate: boolean }) {
  const c = snap.auto.contest;
  const d = c.desk;
  const opt = OPTS.find((o) => o.id === c.id) ?? OPTS[0]!;
  const [exch, setExch] = useState<string | null>(null);
  const [serial, setSerial] = useState<string | null>(null);
  const [check, setCheck] = useState("");
  const [sheet, setSheet] = useState<{ rows: SheetRow[]; multList: string[]; missing: string[] } | null>(null);
  const [showSheet, setShowSheet] = useState(false);

  // The sheet follows the log: fetched again whenever the contact count changes.
  const qsoCount = d?.qsos ?? 0;
  const dupeCount = d?.dupes ?? 0;
  useEffect(() => {
    if (c.id === "none") return setSheet(null);
    let live = true;
    api<{ rows: SheetRow[]; multList: string[]; missing: string[] }>("/api/engine/contest/sheet")
      .then((r) => live && setSheet(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [c.id, c.since, qsoCount, dupeCount]);

  const matches = useMemo(() => {
    const q = check.trim().toUpperCase();
    if (!sheet || q.length < 2) return [];
    const byCall = new Map<string, Set<string>>();
    for (const r of sheet.rows) {
      if (r.dupe || !r.call.includes(q)) continue;
      const s = byCall.get(r.call) ?? new Set<string>();
      s.add(c.id === "field-day" ? `${r.band.toLowerCase()} ${r.group.toLowerCase()}` : r.band.toLowerCase());
      byCall.set(r.call, s);
    }
    return [...byCall.entries()].sort((a, b) => Number(b[0] === q) - Number(a[0] === q) || a[0].localeCompare(b[0])).slice(0, 12);
  }, [check, sheet, c.id]);

  const band = snap.band;
  const fieldsHere = useMemo(() => (sheet && band ? sheet.multList.filter((m) => m.startsWith(`${band}:`)).map((m) => m.slice(band.length + 1)) : []), [sheet, band]);

  if (c.id === "none") {
    return (
      <section className="flex items-center gap-3 rounded-lg border border-line bg-panel px-4 py-2" data-drag>
        <h2 className="text-[13px] font-semibold tracking-wide text-fg">Contest</h2>
        <Select aria-label="Contest" value={c.id} disabled={!canOperate || busy} onChange={(e) => void run("/contest", { id: e.target.value })} className="h-7 flex-1 text-xs">
          {OPTS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
      </section>
    );
  }

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {d ? d.name : "Contest"}
          {d && <span className="text-xs font-normal text-muted">since {utcDateTime(d.since)}</span>}
        </span>
      }
      actions={
        d ? (
          <a href={`/api/cabrillo?contest=${d.cabrillo}&from=${new Date(d.since).toISOString().slice(0, 10)}`} className="text-xs text-accent-strong hover:underline">
            Cabrillo
          </a>
        ) : undefined
      }
    >
      <div className="space-y-3 text-xs">
        <div className="flex items-center gap-2">
          <Select value={c.id} disabled={!canOperate || busy} onChange={(e) => void run("/contest", { id: e.target.value })} className="flex-1">
            {OPTS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        {(c.id === "field-day" || c.id === "rtty-roundup") && (
          <label className="flex items-center gap-2">
            <span className="w-16 text-muted">Exchange</span>
            <input
              value={exch ?? c.exchange}
              placeholder={opt.placeholder}
              disabled={!canOperate}
              onChange={(e) => setExch(e.target.value.toUpperCase())}
              onBlur={() => exch !== null && void run("/contest", { exchange: exch }).then(() => setExch(null))}
              className="h-7 flex-1 rounded-md border border-line-strong bg-panel-2 px-2 font-mono text-fg"
            />
          </label>
        )}
        {
          (c.problem ? (
            <p className="text-warn">{c.problem.replace(/^./, (x) => x.toUpperCase())}.</p>
          ) : (
            <p className="text-muted">
              {opt.help} Sending <span className="font-mono text-fg">{c.sending || snap.station?.grid || "your grid"}</span>.
            </p>
          ))}

        {d && (
          <>
            <div className="grid grid-cols-4 gap-2 text-center">
              {(
                [
                  ["Contacts", d.qsos],
                  ["Points", d.points],
                  [d.multsPer ? "Mults" : c.id === "field-day" ? "Power ×" : "Mults", d.multsPer ? d.mults : c.id === "field-day" ? d.fdPower : "—"],
                  ["Score", d.score],
                ] as [string, number | string][]
              ).map(([k, v]) => (
                <div key={k} className="rounded-md bg-panel-2 py-1.5">
                  <div className="font-mono text-base font-semibold tabular text-fg">{typeof v === "number" ? v.toLocaleString("en-US") : v}</div>
                  <div className="text-[10px] text-subtle">{k}</div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap justify-between gap-x-3 text-muted">
              <span>
                Rate <span className="font-mono text-fg">{d.rate10}</span>/h last 10 min · <span className="font-mono text-fg">{d.rate60}</span> last hour
              </span>
              {d.dupes > 0 && <span>{d.dupes} dupe{d.dupes === 1 ? "" : "s"} (no points)</span>}
            </div>

            {d.currentCall && d.current && (
              <div className={cn("flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5", d.current.dupe ? "border-bad" : "border-line")}>
                <span className="font-mono text-sm text-fg">{d.currentCall}</span>
                {d.current.dupe ? <Badge tone="bad">dupe on {band?.toLowerCase()}</Badge> : <Badge tone="ok">new</Badge>}
                {d.current.newMults.map((m) => (
                  <Badge key={m} tone="info">
                    mult {m.replace(/^[^:]*:/, "").replace(/^DXCC-/, "DXCC ")}
                  </Badge>
                ))}
                {d.current.workedOn.length > 0 && <span className="text-muted">worked on {d.current.workedOn.join(", ").toLowerCase()}</span>}
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <label className="flex items-center gap-2" title="The next serial number sent. It moves on after each contact that sent one, in every mode.">
                <span className="text-muted">Serial</span>
                <input
                  value={serial ?? String(d.serial).padStart(3, "0")}
                  inputMode="numeric"
                  disabled={!canOperate}
                  onChange={(e) => setSerial(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  onBlur={() => {
                    if (serial !== null && Number(serial) >= 1) void run("/contest", { serial: Number(serial) });
                    setSerial(null);
                  }}
                  className="h-7 w-16 rounded-md border border-line-strong bg-panel-2 px-2 font-mono text-fg"
                />
              </label>
              {c.id === "field-day" ? (
                <label className="flex items-center gap-2">
                  <span className="text-muted">Power</span>
                  <Select value={String(d.fdPower)} disabled={!canOperate} onChange={(e) => void run("/contest", { fdPower: Number(e.target.value) })} className="flex-1">
                    <option value="5">5 W, battery/solar (×5)</option>
                    <option value="2">100 W or less (×2)</option>
                    <option value="1">Over 100 W (×1)</option>
                  </Select>
                </label>
              ) : (
                <label className="flex items-center gap-2" title="Contacts from this time on (UTC) make up the contest log">
                  <span className="text-muted">From</span>
                  <input
                    type="datetime-local"
                    defaultValue={toLocalInput(d.since)}
                    key={d.since}
                    disabled={!canOperate}
                    onBlur={(e) => {
                      const t = fromLocalInput(e.target.value);
                      if (Number.isFinite(t) && t !== d.since) void run("/contest", { since: t });
                    }}
                    className="h-7 min-w-0 flex-1 rounded-md border border-line-strong bg-panel-2 px-1 font-mono text-[11px] text-fg"
                  />
                </label>
              )}
            </div>

            {d.byBand.length > 0 && (
              <table className="w-full text-right font-mono tabular">
                <thead className="text-[10px] text-subtle">
                  <tr>
                    <th className="text-left font-normal">Band</th>
                    <th className="font-normal">Contacts</th>
                    <th className="font-normal">Points</th>
                    {d.multsPer === "band" && <th className="font-normal">Fields</th>}
                  </tr>
                </thead>
                <tbody>
                  {d.byBand.map((b) => (
                    <tr key={b.band} className={cn(b.band === band && "text-fg")}>
                      <td className="text-left">{b.band.toLowerCase()}</td>
                      <td>{b.qsos}</td>
                      <td>{b.points}</td>
                      {d.multsPer === "band" && <td>{b.mults}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div>
              <input
                value={check}
                onChange={(e) => setCheck(e.target.value.toUpperCase())}
                placeholder="Check a call (2+ characters)"
                aria-label="Check a call against the contest log"
                className="h-7 w-full rounded-md border border-line-strong bg-panel-2 px-2 font-mono text-fg placeholder:font-sans"
              />
              {check.trim().length >= 2 && (
                <div className="mt-1 space-y-0.5">
                  {matches.length === 0 ? (
                    <div className="text-ok">{check.trim()} is not in the log: not a dupe anywhere</div>
                  ) : (
                    matches.map(([call, bands]) => (
                      <div key={call} className="flex justify-between gap-2">
                        <span className={cn("font-mono", call === check.trim() ? "text-fg" : "text-muted")}>{call}</span>
                        <span className={cn(band && [...bands].some((b) => b.startsWith(band.toLowerCase())) ? "text-bad" : "text-muted")}>{[...bands].join(", ")}</span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {d.multsPer === "band" && band && (
              <div className="text-muted">
                Fields on {band.toLowerCase()}: {fieldsHere.length ? <span className="font-mono text-fg">{fieldsHere.join(" ")}</span> : "none yet"}
              </div>
            )}
            {c.id === "rtty-roundup" && sheet && (
              <details>
                <summary className="cursor-pointer text-muted">
                  Multipliers: {sheet.multList.length} worked, {sheet.missing.length} states and provinces to go
                </summary>
                <div className="mt-1 font-mono text-[11px] text-subtle">{sheet.missing.join(" ")}</div>
              </details>
            )}

            {sheet && sheet.rows.length > 0 && (
              <div>
                <button type="button" onClick={() => setShowSheet((v) => !v)} className="text-muted underline hover:text-fg">
                  {showSheet ? "Hide" : "Show"} the log ({sheet.rows.length})
                </button>
                {showSheet && (
                  <div className="mt-1 max-h-56 overflow-y-auto">
                    <table className="w-full font-mono text-[11px] tabular">
                      <tbody>
                        {sheet.rows.slice(0, 500).map((r, i) => (
                          <tr key={`${r.call}-${r.at}-${i}`} className={cn(r.dupe || r.invalid ? "text-subtle line-through" : "text-muted")} title={r.invalid ?? (r.dupe ? "dupe" : undefined)}>
                            <td>{new Date(r.at).toISOString().slice(11, 16)}</td>
                            <td>{r.band.toLowerCase()}</td>
                            <td className="text-fg">{r.call}</td>
                            <td>{r.exchange}</td>
                            <td className="text-right">{r.points}</td>
                            <td className="text-right text-info">{r.mults.map((m) => m.replace(/^[^:]*:/, "")).join(" ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            <p className="text-[11px] text-subtle">
              {d.note} The rules require a person to start each contact, so automatic hunting stays off; CQ runs while you watch.
            </p>
          </>
        )}
      </div>
    </Card>
  );
}
