"use client";
/**
 * While you were away: when this browser was last looked at more than an hour ago, one
 * strip of what happened since, exceptions first. Facts with their calls, bands and
 * times, from the station's own records. Dismiss marks everything seen.
 */
import Link from "next/link";
import { useEffect, useState } from "react";

import { api } from "@/lib/client/api";
import { duration, utcTime } from "@/lib/format";

interface Away {
  since: number;
  contacts: number;
  runs: number;
  newOnes: { kind: string; label: string; callsign: string }[];
  missed: { dxcc: number; name: string; callsign: string; band: string; mode: string; at: number; snr: number; times: number }[];
  failedUploads: { service: string; count: number; lastError: string | null }[];
  faults: { at: number; reason: string }[];
}

const KEY = "ds.lastSeenAt";
const GAP = 60 * 60_000;

function readSeen(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
function markSeen(): void {
  try {
    localStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* not remembered */
  }
}

export function AwayStrip() {
  const [data, setData] = useState<Away | null>(null);
  useEffect(() => {
    const seen = readSeen();
    if (seen && Date.now() - seen > GAP) {
      api<Away>(`/api/away?since=${seen}`)
        .then((r) => {
          const any = r.contacts || r.newOnes.length || r.missed.length || r.failedUploads.length || r.faults.length;
          if (any) setData(r);
          else markSeen();
        })
        .catch(() => {});
    } else if (!seen) markSeen();
    // While the page is open and visible, the operator is here.
    const tick = setInterval(() => document.visibilityState === "visible" && markSeen(), 5 * 60_000);
    const hide = () => document.visibilityState === "hidden" && markSeen();
    document.addEventListener("visibilitychange", hide);
    return () => {
      clearInterval(tick);
      document.removeEventListener("visibilitychange", hide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!data) return null;
  const dismiss = () => {
    markSeen();
    setData(null);
  };
  const failed = data.failedUploads.reduce((a, f) => a + f.count, 0);
  return (
    <section className="rounded-lg border border-accent/50 bg-accent-soft px-4 py-3 text-sm" aria-label="While you were away">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="font-semibold text-fg">
            While you were away <span className="font-normal text-muted">({duration(Date.now() - data.since)})</span>
          </div>
          {data.faults.map((f, i) => (
            <div key={i} className="text-bad">
              {utcTime(f.at)}Z stopped: {f.reason}
            </div>
          ))}
          {failed > 0 && (
            <div className="text-warn">
              {failed} upload{failed === 1 ? "" : "s"} failed ({data.failedUploads.map((f) => f.service).join(", ")}).{" "}
              <Link href="/services" className="underline">
                Services
              </Link>
            </div>
          )}
          {data.missed.length > 0 && (
            <div>
              <span className="text-muted">Decoded, needed, not worked: </span>
              {data.missed.map((m, i) => (
                <span key={m.dxcc}>
                  {i > 0 && " · "}
                  <Link href={`/call/${encodeURIComponent(m.callsign)}`} className="text-fg hover:text-accent-strong">
                    {m.name}
                  </Link>{" "}
                  <span className="font-mono text-xs text-muted">
                    {m.callsign} {m.band.toLowerCase()} {utcTime(m.at)}Z {m.snr} dB
                  </span>
                </span>
              ))}
            </div>
          )}
          <div className="text-muted">
            {data.contacts} contact{data.contacts === 1 ? "" : "s"}
            {data.runs ? ` in ${data.runs} automatic run${data.runs === 1 ? "" : "s"}` : ""}
            {data.newOnes.length > 0 && (
              <>
                {" · new: "}
                <span className="text-ok">{data.newOnes.map((n) => `${n.label} (${n.callsign})`).join(", ")}</span>
              </>
            )}
            {data.runs > 0 && (
              <>
                {" · "}
                <Link href="/runs" className="underline">
                  Runs
                </Link>
              </>
            )}
          </div>
        </div>
        <button type="button" onClick={dismiss} className="shrink-0 rounded-md border border-line-strong px-2 py-1 text-xs text-muted hover:text-fg">
          Got it
        </button>
      </div>
    </section>
  );
}
