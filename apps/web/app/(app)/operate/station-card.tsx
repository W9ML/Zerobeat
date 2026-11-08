"use client";
/**
 * The station we are working, beside the contact: who they are (callbook name, QTH,
 * photo), where (a great-circle map from our station, distance and bearing both ways),
 * and our history with them. Shown while a contact is on.
 */
import Link from "next/link";
import { useEffect, useState } from "react";

import { Badge, Card, cn } from "@/components/ui";
import { api } from "@/lib/client/api";
import { bringBack, openPopout, usePopped } from "@/lib/client/popout";
import { useDistanceUnit } from "@/lib/client/units";
import { fmtDistance } from "@/lib/distance";
import { qrzUrl } from "@/lib/qrz";
import { utcDate } from "@/lib/format";

interface Lookup {
  callsign: string;
  dxcc: { name: string; continent: string; cqZone: number; ituZone: number } | null;
  info: { name: string | null; qth: string | null; country: string | null; grid: string | null; lotw: boolean | null; photo: boolean; source: string } | null;
  worked: { total: number; thisBand: number; thisBandMode: number; today: number; last: { startTime: number; band: string; mode: string; submode: string | null } | null };
  path: { from: string; to: string; km: number; bearing: number; longKm: number; longBearing: number } | null;
}

/**
 * Lookups already made, for ten minutes: the card moves (and remounts) as a contact stops
 * and is retried, and calling the same station again must not look it all up again.
 */
const seen = new Map<string, { at: number; d: Lookup }>();
const SEEN_MS = 600_000;
const recall = (key: string) => {
  const hit = seen.get(key);
  return hit && Date.now() - hit.at < SEEN_MS ? hit.d : null;
};

/** Path maps already fetched, by URL (the URL carries a ten-minute slot, so they go stale on their own). */
const maps = new Map<string, string>();

/**
 * The path map, drawn inline rather than as an <img> so the callsigns on it are links (each
 * opens its QRZ.com page). The SVG is made by our own /api/map/path, from a validated
 * callsign and grid, with every label escaped.
 */
function PathMap({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [svg, setSvg] = useState<string | null>(() => maps.get(src) ?? null);
  useEffect(() => {
    let live = true;
    const hit = maps.get(src);
    if (hit) {
      setSvg(hit);
      return;
    }
    fetch(src)
      .then((r) => (r.ok && (r.headers.get("content-type") ?? "").startsWith("image/svg+xml") ? r.text() : null))
      .then((t) => {
        if (!t || !t.startsWith("<svg")) return;
        maps.set(src, t);
        if (maps.size > 30) maps.delete(maps.keys().next().value!);
        if (live) setSvg(t);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [src]);
  return (
    <div
      role="group"
      aria-label={alt}
      className={cn("block [&>svg]:block [&>svg]:h-full [&>svg]:w-full [&_a:hover]:opacity-80", className)}
      dangerouslySetInnerHTML={{ __html: svg ?? "" }}
    />
  );
}

/** mapOnly: the map window (app/pop/map), the map as large as the window allows. */
export function StationCard({ call, grid, band, mode, mapOnly = false }: { call: string; grid: string | null; band: string | null; mode: string; mapOnly?: boolean }) {
  const unit = useDistanceUnit();
  const mapAway = usePopped().has("map") && !mapOnly;
  const q = new URLSearchParams({ ...(grid ? { grid } : {}), ...(band ? { band } : {}), mode }).toString();
  const key = `${call}?${q}`;
  const [d, setD] = useState<Lookup | null>(() => recall(key));
  const [failed, setFailed] = useState(false);
  const [photoOk, setPhotoOk] = useState(true);
  useEffect(() => {
    let live = true;
    setFailed(false);
    const known = recall(key);
    if (known) {
      setD(known);
      return;
    }
    setPhotoOk(true);
    // A moment after the call settles: typing one in must not look up every keystroke.
    const t = setTimeout(() => {
      api<Lookup>(`/api/lookup/${encodeURIComponent(call)}?${q}`)
        .then((r) => {
          seen.set(key, { at: Date.now(), d: r });
          if (seen.size > 100) seen.delete(seen.keys().next().value!);
          if (live) setD(r);
        })
        .catch(() => live && setFailed(true));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [call, q, key]);

  const fresh = d && d.callsign === call ? d : null;
  const info = fresh?.info;
  const p = fresh?.path;
  const w = fresh?.worked;
  // Ten-minute steps: the map's night side follows the clock without a reload per poll.
  const slot = Math.floor(Date.now() / 600_000);
  if (mapOnly && !p) return <Card pad={false}><div className="p-4 text-sm text-muted">{fresh ? `No grid for ${call} yet, so no map.` : failed ? "Lookup failed" : "Looking up…"}</div></Card>;
  return (
    <Card pad={false}>
      <div className="flex gap-3 p-3" data-drag>
        {info?.photo && photoOk ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/lookup/${encodeURIComponent(call)}/photo`} alt="" onError={() => setPhotoOk(false)} className="h-16 w-16 shrink-0 rounded-md border border-line object-cover" />
        ) : (
          <div className="grid h-16 w-16 shrink-0 place-items-center rounded-md border border-line bg-panel-2 font-mono text-lg text-subtle">{call.replace(/\/.*$/, "").slice(-3)}</div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <a href={qrzUrl(call)} target="_blank" rel="noopener noreferrer" title={`${call} on QRZ.com`} className="font-mono text-lg font-semibold text-fg hover:text-accent-strong">
              {call}
            </a>
            {info?.lotw && (
              <Badge tone="ok" title="Uploads to Logbook of The World (from the callbook), so a LoTW confirmation is likely">
                LoTW user
              </Badge>
            )}
            {w && w.total === 0 && <Badge tone="info">first contact</Badge>}
          </div>
          <div className="truncate text-sm text-fg">{info?.name ?? (fresh ? "No callbook record" : failed ? "Lookup failed" : "Looking up…")}</div>
          <div className="truncate text-xs text-muted">{[info?.qth, info?.country ?? fresh?.dxcc?.name].filter(Boolean).join(" · ")}</div>
        </div>
      </div>
      {p && (
        <>
          {mapAway ? (
            <div className="flex items-center justify-between gap-2 border-y border-line px-3 py-2 text-xs text-muted">
              <span>The map is in its own window</span>
              <button type="button" className="text-accent-strong hover:underline" onClick={() => bringBack("map")}>
                Bring back
              </button>
            </div>
          ) : (
            <div className="relative">
              <PathMap
                src={`/api/map/path?to=${encodeURIComponent(p.to)}&call=${encodeURIComponent(call)}&t=${slot}`}
                alt={`Map of the path to ${call} in ${p.to}`}
                className={cn("aspect-[8/5] w-full border-y border-line bg-[#0e1622]", mapOnly && "max-h-[calc(100vh-200px)]")}
              />
              {!mapOnly && (
                <button
                  type="button"
                  onClick={() => openPopout("map")}
                  title="Open the map in its own window"
                  aria-label="Open the map in its own window"
                  className="absolute right-2 top-2 rounded-md border border-line-strong bg-panel/80 px-1.5 text-sm text-muted hover:text-fg"
                >
                  ⧉
                </button>
              )}
            </div>
          )}
          <div className="grid grid-cols-3 gap-2 px-3 py-2 text-xs">
            <div>
              <div className="text-subtle">Distance</div>
              <div className="font-mono tabular text-fg">{fmtDistance(p.km, unit)}</div>
              <div className="font-mono tabular text-muted">LP {fmtDistance(p.longKm, unit)}</div>
            </div>
            <div>
              <div className="text-subtle">Beam</div>
              <div className="font-mono tabular text-fg">{p.bearing}°</div>
              <div className="font-mono tabular text-muted" title={`Long path ${fmtDistance(p.longKm, unit)}`}>
                LP {p.longBearing}°
              </div>
            </div>
            <div>
              <div className="text-subtle">Grid</div>
              <div className="font-mono text-fg">{p.to}</div>
              <div className="text-muted">{fresh?.dxcc ? `CQ ${fresh.dxcc.cqZone} · ${fresh.dxcc.continent}` : ""}</div>
            </div>
          </div>
        </>
      )}
      {w && w.total > 0 && !mapOnly && (
        <div className="border-t border-line px-3 py-2 text-xs text-muted">
          <Link href={`/call/${encodeURIComponent(call)}`} className="text-accent-strong hover:underline" title={`Every contact with ${call}`}>
            {w.total} contact{w.total === 1 ? "" : "s"} before
          </Link>
          {w.last && (
            <>
              {" "}
              · last {utcDate(w.last.startTime)} on {w.last.band.toLowerCase()} {w.last.submode ?? w.last.mode}
            </>
          )}
          {band && w.thisBandMode === 0 && <span className="text-ok"> · new on {band.toLowerCase()} {mode}</span>}
          {w.today > 0 && <span className="text-warn"> · already worked today on this band and mode</span>}
        </div>
      )}
    </Card>
  );
}

