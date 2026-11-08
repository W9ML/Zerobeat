"use client";
/**
 * SSTV on the Operate page: the picture arriving (redrawn every few lines), the gallery
 * of pictures received and sent, a card to send one, and a card to log the contact. Any
 * picture is cropped to the mode's size on the server, with the text you give written
 * across the bottom.
 */
import { useEffect, useMemo, useState } from "react";

import { toast } from "@/components/overlays";
import { Badge, Button, Card, cn, Input, Select } from "@/components/ui";
import { control, useLive, type EngineSnapshot, type SstvPicture } from "@/lib/client/live";
import { cleanLine, expandTokens, insetBox, MAX_LINES, overlaySvg, TEMPLATES, TOKENS, type Corner, type LinePos, type LineSize, type TextLine, type TokenContext } from "@/lib/sstv-caption";
import { setSstvContact, useSstvContact } from "@/lib/client/sstv-contact";
import { utcTime } from "@/lib/format";
import { api } from "@/lib/client/api";

import { StationCard } from "./station-card";

/** The enlarged picture's "Log contact" hands its time to the log card. */
const LOG_FROM_PICTURE = "ds-sstv-log-from-picture";

function useNow(ms: number, on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return now;
}

const img = (file: string, bust?: string | number) => `/api/sstv/image/${encodeURIComponent(file)}${bust !== undefined ? `?v=${bust}` : ""}`;

export function SstvPanel({ snap }: { snap: EngineSnapshot }) {
  const { sstvPictures: live } = useLive();
  const [initial, setInitial] = useState<SstvPicture[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<SstvPicture | null>(null);
  // A page at a time, newest first; "Show older" asks for the page before the oldest shown.
  const load = (before?: number) => {
    setLoading(true);
    void fetch(`/api/engine/sstv?limit=60${before ? `&before=${before}` : ""}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { pictures: SstvPicture[]; total?: number } | null) => {
        if (!j) return;
        setInitial((cur) => (before ? [...cur, ...j.pictures] : j.pictures));
        setTotal(j.total ?? j.pictures.length);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(() => load(), []);
  const pictures = useMemo(() => {
    const seen = new Set<string>();
    return [...live, ...initial].filter((p) => (seen.has(p.file) ? false : (seen.add(p.file), true)));
  }, [live, initial]);
  const shownOf = Math.max(total + live.filter((p) => !initial.some((q) => q.file === p.file)).length, pictures.length);

  // The enlarged picture steps through the gallery: right is the next (older) one, left
  // the one before; past the last one loaded, the next page is fetched and stepped into.
  const at = open ? pictures.findIndex((p) => p.file === open.file) : -1;
  const [stepAfterLoad, setStepAfterLoad] = useState(false);
  const step = (d: -1 | 1) => {
    if (at < 0) return;
    const next = pictures[at + d];
    if (next) setOpen(next);
    else if (d === 1 && pictures.length < shownOf && !loading) {
      setStepAfterLoad(true);
      load(pictures.at(-1)!.at);
    }
  };
  useEffect(() => {
    if (stepAfterLoad && !loading && at >= 0 && pictures[at + 1]) {
      setStepAfterLoad(false);
      setOpen(pictures[at + 1]!);
    }
  }, [stepAfterLoad, loading, at, pictures]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "Escape") setOpen(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const hasOlder = at >= 0 && (at < pictures.length - 1 || pictures.length < shownOf);
  const rx = snap.sstv.receiving;
  return (
    <div className="space-y-4">
      <Card
        title={
          <span className="flex items-center gap-2">
            SSTV
            <span className="text-xs font-normal text-muted">{snap.radio.link !== "connected" ? "radio disconnected" : rx ? `receiving ${rx.modeName}: line ${rx.line} of ${rx.of}` : "watching for a picture (any common mode, named by its VIS header)"}</span>
          </span>
        }
      >
        {rx ? (
          <div className="space-y-2">
            <div className="h-1.5 overflow-hidden rounded-full bg-panel-3">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${(rx.line / rx.of) * 100}%` }} />
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img("current.png", rx.line)} alt={`${rx.modeName} picture arriving`} className="mx-auto w-full max-w-[640px] rounded-md border border-line bg-black [image-rendering:pixelated]" />
          </div>
        ) : pictures[0] ? (
          <button type="button" onClick={() => setOpen(pictures[0]!)} className="block w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img(pictures[0].file)} alt="Latest picture" className="mx-auto w-full max-w-[640px] rounded-md border border-line bg-black" />
            <div className="mt-1 text-center text-xs text-muted">
              Latest: {pictures[0].modeName} {pictures[0].dir === "tx" ? "sent" : "received"} {utcTime(pictures[0].at)}Z
            </div>
          </button>
        ) : (
          <div className="px-4 py-12 text-center text-sm text-muted">No pictures yet. 14.230 MHz is the busiest SSTV frequency.</div>
        )}
      </Card>

      {pictures.length > 0 && (
        <Card title={<span>Gallery <span className="text-xs font-normal text-muted">· {pictures.length < shownOf ? `${pictures.length} of ${shownOf}` : pictures.length}</span></span>}>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {pictures.map((p) => (
              <button key={p.file} type="button" onClick={() => setOpen(p)} className="group relative overflow-hidden rounded-md border border-line bg-black" title={`${p.modeName} ${p.dir === "tx" ? "sent" : "received"} ${new Date(p.at).toISOString().slice(0, 16).replace("T", " ")}Z`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img(p.file)} alt={p.modeName} loading="lazy" className="aspect-[5/4] w-full object-cover transition group-hover:opacity-80" />
                <span className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 text-[10px] text-white">
                  {utcTime(p.at)}Z {p.mode}
                  {p.dir === "tx" ? " · sent" : !p.complete ? " · part" : ""}
                </span>
              </button>
            ))}
          </div>
          {pictures.length < shownOf && (
            <div className="mt-3 text-center">
              <Button size="sm" variant="secondary" disabled={loading} onClick={() => load(pictures.at(-1)!.at)}>
                {loading ? "Loading…" : "Show older"}
              </Button>
            </div>
          )}
        </Card>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center gap-3 bg-black/80 p-4" onClick={() => setOpen(null)}>
          <NavArrow dir={-1} disabled={at <= 0} onClick={() => step(-1)} />
          <div className="max-w-3xl min-w-0 space-y-2" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img(open.file)} alt={open.modeName} className="max-h-[80vh] w-auto rounded-md" />
            <div className="flex items-center justify-between gap-4 text-sm text-white">
              <span>
                {open.modeName} · {open.dir === "tx" ? "sent" : "received"} {new Date(open.at).toISOString().slice(0, 16).replace("T", " ")}Z
                {open.dialHz ? ` · ${(open.dialHz / 1e6).toFixed(3)} MHz` : ""}
                {open.dir === "rx" && Math.abs(open.slantPpm) > 50 ? ` · slant corrected ${open.slantPpm} ppm` : ""}
              </span>
              <span className="flex shrink-0 items-center gap-3">
                {open.dir === "rx" && (
                  <button
                    type="button"
                    className="underline"
                    title="Log the contact with this picture's time"
                    onClick={() => {
                      window.dispatchEvent(new CustomEvent(LOG_FROM_PICTURE, { detail: { at: open.at, mode: open.modeName } }));
                      setOpen(null);
                    }}
                  >
                    Log contact
                  </button>
                )}
                <span className="tabular text-white/70">
                  {at + 1} of {shownOf}
                </span>
                <a href={img(open.file)} download={open.file} className="underline">
                  Download
                </a>
              </span>
            </div>
          </div>
          <NavArrow dir={1} disabled={!hasOlder || (stepAfterLoad && loading)} onClick={() => step(1)} />
        </div>
      )}
    </div>
  );
}

/** A big left or right arrow beside the enlarged picture. */
function NavArrow({ dir, disabled, onClick }: { dir: -1 | 1; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={dir === 1 ? "Next picture" : "Previous picture"}
      title={dir === 1 ? "Next (→)" : "Previous (←)"}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="grid size-11 shrink-0 place-items-center rounded-full bg-white/10 text-2xl text-white transition hover:bg-white/25 disabled:invisible"
    >
      {dir === 1 ? "›" : "‹"}
    </button>
  );
}

/**
 * Log an SSTV contact: their call and the reports (RSV, 595 by default), on the radio's
 * frequency now, at the time of a received picture when one was picked ("Log contact" on
 * it) or else now. Goes into your logbook like any contact, uploads and all.
 */
export function SstvLogCard({ snap, canOperate }: { snap: EngineSnapshot; canOperate: boolean }) {
  const [call, setCall] = useState("");
  const [sent, setSent] = useState("595");
  const [rcvd, setRcvd] = useState("595");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [at, setAt] = useState<{ at: number; mode: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const on = (e: Event) => setAt((e as CustomEvent<{ at: number; mode: string }>).detail);
    window.addEventListener(LOG_FROM_PICTURE, on);
    return () => window.removeEventListener(LOG_FROM_PICTURE, on);
  }, []);
  const callOk = /^[A-Z0-9/]{3,}$/.test(call) && /\d/.test(call);
  // The send card fills {call}, {rst} and {name} from here.
  useEffect(() => setSstvContact({ call, rst: sent, name }), [call, sent, name]);

  async function log() {
    setBusy(true);
    try {
      await api("/api/qsos", {
        body: {
          clientId: `sstv-${call}-${at?.at ?? Date.now()}`,
          callsign: call,
          freqMHz: snap.dialHz / 1e6,
          mode: "SSTV",
          startTime: at?.at ?? Date.now(),
          rstSent: sent || null,
          rstRcvd: rcvd || null,
          name: name || null,
          notes: notes || null,
        },
      });
      toast({ title: `Logged ${call}`, body: `SSTV on ${(snap.dialHz / 1e6).toFixed(3)} MHz${at ? ` at ${utcTime(at.at)}Z` : ""}`, tone: "ok" });
      setCall("");
      setName("");
      setNotes("");
      setAt(null);
    } catch (e) {
      toast({ title: "Not logged", body: (e as Error).message, tone: "bad" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card title="Log a contact">
        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_64px_64px] gap-2">
            <label className="block text-xs text-muted">
              Their call
              <Input value={call} maxLength={16} onChange={(e) => setCall(e.target.value.toUpperCase().trim())} className="mt-1 w-full font-mono uppercase" placeholder="K1ABC" />
            </label>
            <label className="block text-xs text-muted">
              Sent
              <Input value={sent} maxLength={6} onChange={(e) => setSent(e.target.value)} className="mt-1 w-full font-mono" />
            </label>
            <label className="block text-xs text-muted">
              Rcvd
              <Input value={rcvd} maxLength={6} onChange={(e) => setRcvd(e.target.value)} className="mt-1 w-full font-mono" />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-muted">
              Name
              <Input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} className="mt-1 w-full" />
            </label>
            <label className="block text-xs text-muted">
              Notes
              <Input value={notes} maxLength={200} onChange={(e) => setNotes(e.target.value)} className="mt-1 w-full" />
            </label>
          </div>
          <div className="flex items-center justify-between gap-2 text-xs text-muted">
            <span>
              SSTV · {(snap.dialHz / 1e6).toFixed(3)} MHz · {at ? <>{utcTime(at.at)}Z, the time of their {at.mode} picture</> : "now"}
            </span>
            {at && (
              <button type="button" className="shrink-0 whitespace-nowrap text-accent-strong hover:underline" onClick={() => setAt(null)}>
                Use now
              </button>
            )}
          </div>
          <Button variant="primary" className="w-full" disabled={!canOperate || busy || !callOk} onClick={() => void log()}>
            {busy ? "Logging…" : "Log contact"}
          </Button>
          <p className="text-[11px] text-subtle">To use a picture&apos;s time, open it in the gallery and press Log contact.</p>
        </div>
      </Card>
      {callOk && <StationCard call={call} grid={null} band={snap.band} mode="SSTV" />}
    </div>
  );
}

/** A picture source for the send card: a file to upload, or one of My pictures. */
type Source = { kind: "upload"; file: File } | { kind: "library"; id: string };

const TEMPLATE_KEY = "ds.sstv.templates";
const LINES_KEY = "ds.sstv.lines";
const POS_LABEL: Record<LinePos, string> = { top: "Top", middle: "Middle", bottom: "Bottom" };
const SIZE_LABEL: Record<LineSize, string> = { s: "Small", m: "Medium", l: "Large" };
const CORNER_LABEL: Record<Corner, string> = { tl: "Top left", tr: "Top right", bl: "Bottom left", br: "Bottom right" };

function readStored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* not remembered */
  }
}

/** "My pictures": the user's own pictures kept on the server to send again. */
function useLibrary() {
  const [items, setItems] = useState<{ id: string; at: number }[]>([]);
  const [max, setMax] = useState(60);
  const reload = () =>
    void fetch("/api/sstv/library", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { items: { id: string; at: number }[]; max: number } | null) => {
        if (j) {
          setItems(j.items);
          setMax(j.max);
        }
      })
      .catch(() => {});
  useEffect(reload, []);
  return { items, max, reload };
}

export function SstvSendCard({ snap, canOperate }: { snap: EngineSnapshot; canOperate: boolean }) {
  const [source, setSource] = useState<Source | null>(null);
  const [save, setSave] = useState(true);
  const [mode, setMode] = useState("M1");
  const [lines, setLinesState] = useState<TextLine[]>(() => TEMPLATES[0]!.lines);
  const [saved, setSaved] = useState<{ name: string; lines: TextLine[] }[]>([]);
  const [insetOn, setInsetOn] = useState(false);
  const [insetFile, setInsetFile] = useState("");
  const [corner, setCorner] = useState<Corner>("br");
  const [busy, setBusy] = useState(false);
  const lib = useLibrary();
  const contact = useSstvContact();
  const { sstvPictures: live } = useLive();
  const [recent, setRecent] = useState<SstvPicture[]>([]);
  useEffect(() => {
    // The layout last used, and saved templates: this browser's.
    setLinesState(readStored(LINES_KEY, TEMPLATES[0]!.lines));
    setSaved(readStored(TEMPLATE_KEY, []));
    void fetch("/api/engine/sstv?limit=12", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { pictures: SstvPicture[] } | null) => j && setRecent(j.pictures))
      .catch(() => {});
  }, []);
  const setLines = (l: TextLine[]) => {
    setLinesState(l);
    store(LINES_KEY, l);
  };
  // Their pictures (received), newest first, for setting one into a corner.
  const theirs = useMemo(() => {
    const seen = new Set<string>();
    return [...live, ...recent].filter((p) => p.dir === "rx" && !seen.has(p.file) && (seen.add(p.file), true)).slice(0, 12);
  }, [live, recent]);
  const insetPic = insetOn ? (theirs.find((p) => p.file === insetFile) ?? theirs[0] ?? null) : null;

  const sending = snap.sstv.sending;
  const now = useNow(1000, true);
  const m = snap.sstv.modes.find((x) => x.id === mode);
  const uploadUrl = useMemo(() => (source?.kind === "upload" ? URL.createObjectURL(source.file) : null), [source]);
  useEffect(() => () => void (uploadUrl && URL.revokeObjectURL(uploadUrl)), [uploadUrl]);
  const preview = source?.kind === "library" ? `/api/sstv/library/${source.id}` : uploadUrl;
  const ctx: TokenContext = { mycall: snap.station?.callsign ?? "", grid: snap.station?.grid ?? "", call: contact.call, rst: contact.rst, name: contact.name, mode: m?.name ?? "", now };
  const expanded = lines.map((l) => ({ ...l, text: expandTokens(l.text, ctx) }));
  const caption = useMemo(() => {
    const svg = m ? overlaySvg(expanded.map((l) => cleanLine(l)).filter((l): l is TextLine => !!l), m.width, m.height) : null;
    return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null;
  }, [JSON.stringify(expanded), m]); // eslint-disable-line react-hooks/exhaustive-deps
  const box = insetPic && m ? insetBox(corner, m.width, m.height) : null;
  const incoming = snap.sstv.receiving;
  const missing = expanded.some((l, i) => !l.text && lines[i]!.text.trim());

  async function addToLibrary(f: File) {
    const fd = new FormData();
    fd.set("image", f);
    const r = await fetch("/api/sstv/library", { method: "POST", body: fd }).catch(() => null);
    const j = (await r?.json().catch(() => null)) as { id?: string; error?: string } | null;
    if (!r?.ok || !j?.id) return toast({ title: "Not added", body: j?.error ?? "the server did not answer", tone: "bad" });
    lib.reload();
    setSource({ kind: "library", id: j.id });
  }

  async function removeFromLibrary(id: string) {
    await fetch(`/api/sstv/library/${id}`, { method: "DELETE" }).catch(() => null);
    if (source?.kind === "library" && source.id === id) setSource(null);
    lib.reload();
  }

  async function send() {
    if (!source) return;
    setBusy(true);
    const fd = new FormData();
    if (source.kind === "upload") {
      fd.set("image", source.file);
      if (save) fd.set("save", "1");
    } else fd.set("libraryId", source.id);
    fd.set("mode", mode);
    fd.set("lines", JSON.stringify(expanded));
    if (insetPic) {
      fd.set("insetFile", insetPic.file);
      fd.set("insetCorner", corner);
    }
    const r = await fetch("/api/sstv/send", { method: "POST", body: fd }).catch(() => null);
    setBusy(false);
    if (r?.ok && source.kind === "upload" && save) lib.reload();
    if (!r || !r.ok) {
      const j = (await r?.json().catch(() => null)) as { error?: string } | null;
      // Not our JSON: say what came back (a web server in front can refuse an upload).
      toast({ title: "Not sent", body: j?.error ?? (r ? `the server refused the picture (HTTP ${r.status})` : "the server did not answer"), tone: "bad" });
    }
  }

  const saveTemplate = () => {
    const name = window.prompt("Name this layout")?.trim();
    if (!name) return;
    const next = [...saved.filter((t) => t.name !== name), { name, lines }].slice(-12);
    setSaved(next);
    store(TEMPLATE_KEY, next);
  };
  const dropTemplate = (name: string) => {
    const next = saved.filter((t) => t.name !== name);
    setSaved(next);
    store(TEMPLATE_KEY, next);
  };
  const setLine = (i: number, patch: Partial<TextLine>) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  const pct = sending ? Math.max(0, Math.min(100, ((now - sending.startedAt) / sending.durationMs) * 100)) : 0;
  return (
    <Card title="Send a picture">
      <div className="space-y-4">
        {/* The picture: one of My pictures, or a new one. */}
        <section className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-fg">Picture</span>
            <span className="text-subtle">
              My pictures · {lib.items.length} of {lib.max}
            </span>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            <label className={cn("grid aspect-[5/4] cursor-pointer place-items-center rounded-md border border-dashed border-line-strong text-center text-[11px] text-muted hover:border-accent hover:text-fg", !canOperate && "pointer-events-none opacity-50")}>
              <input type="file" accept="image/*" className="hidden" disabled={!canOperate} onChange={(e) => e.target.files?.[0] && setSource({ kind: "upload", file: e.target.files[0] })} />
              + New
            </label>
            {lib.items.map((it) => (
              <div key={it.id} className="group relative">
                <button
                  type="button"
                  onClick={() => setSource({ kind: "library", id: it.id })}
                  className={cn("block w-full overflow-hidden rounded-md border-2 bg-black", source?.kind === "library" && source.id === it.id ? "border-accent" : "border-transparent")}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/sstv/library/${it.id}`} alt="" loading="lazy" className="aspect-[5/4] w-full object-cover" />
                </button>
                {canOperate && (
                  <button
                    type="button"
                    aria-label="Remove from My pictures"
                    title="Remove from My pictures"
                    onClick={() => void removeFromLibrary(it.id)}
                    className="absolute right-0.5 top-0.5 hidden size-5 place-items-center rounded-full bg-black/70 text-[11px] text-white group-hover:grid"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
          {source?.kind === "upload" && (
            <div className="flex items-center justify-between gap-2 text-xs text-muted">
              <span className="min-w-0 truncate">{source.file.name}</span>
              <span className="flex shrink-0 items-center gap-3">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} className="accent-[var(--color-accent)]" />
                  Keep in My pictures
                </label>
                <button type="button" className="text-accent-strong hover:underline" onClick={() => void addToLibrary(source.file)}>
                  Keep now
                </button>
              </span>
            </div>
          )}
        </section>

        {preview && (
          <div className="relative overflow-hidden rounded-md border border-line bg-black" style={{ aspectRatio: m ? `${m.width} / ${m.height}` : "5 / 4" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview} alt="Picture to send" className="h-full w-full object-cover" />
            {box && insetPic && m && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={img(insetPic.file)}
                alt="Their picture"
                className="absolute object-cover"
                style={{
                  left: `${(box.left / m.width) * 100}%`,
                  top: `${(box.top / m.height) * 100}%`,
                  width: `${(box.width / m.width) * 100}%`,
                  height: `${(box.height / m.height) * 100}%`,
                  border: `${Math.max(1, (box.border / m.width) * 100 * 3)}px solid white`,
                }}
              />
            )}
            {caption && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={caption} alt="" className="pointer-events-none absolute inset-0 h-full w-full" />
            )}
          </div>
        )}

        {/* The text: layouts, then each line. */}
        <section className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="mr-1 font-medium text-fg">Text</span>
            {TEMPLATES.map((t) => (
              <button key={t.id} type="button" onClick={() => setLines(t.lines)} className="rounded-md border border-line-strong px-2 py-0.5 text-muted hover:border-accent hover:text-fg">
                {t.label}
              </button>
            ))}
            {saved.map((t) => (
              <span key={t.name} className="group inline-flex items-center rounded-md border border-line-strong">
                <button type="button" onClick={() => setLines(t.lines)} className="px-2 py-0.5 text-muted hover:text-fg">
                  {t.name}
                </button>
                <button type="button" aria-label={`Forget ${t.name}`} onClick={() => dropTemplate(t.name)} className="hidden pr-1.5 text-subtle hover:text-bad group-hover:inline">
                  ×
                </button>
              </span>
            ))}
            <button type="button" onClick={saveTemplate} className="text-accent-strong hover:underline">
              Save layout
            </button>
          </div>
          {lines.map((l, i) => (
            <div key={i} className="space-y-1 rounded-md border border-line p-2">
              <div className="flex items-center gap-1.5">
                <Input value={l.text} maxLength={60} onChange={(e) => setLine(i, { text: e.target.value })} className="min-w-0 flex-1 font-mono uppercase" placeholder="CQ DE {mycall}" />
                <input type="color" aria-label="Colour" value={l.color} onChange={(e) => setLine(i, { color: e.target.value })} className="h-8 w-8 shrink-0 cursor-pointer rounded border border-line-strong bg-transparent" />
                <button type="button" aria-label="Remove line" onClick={() => setLines(lines.filter((_, k) => k !== i))} className="px-1 text-subtle hover:text-bad">
                  ×
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <Select value={l.pos} onChange={(e) => setLine(i, { pos: e.target.value as LinePos })} className="h-7 w-auto! text-xs">
                  {(Object.keys(POS_LABEL) as LinePos[]).map((p) => (
                    <option key={p} value={p}>
                      {POS_LABEL[p]}
                    </option>
                  ))}
                </Select>
                <Select value={l.size} onChange={(e) => setLine(i, { size: e.target.value as LineSize })} className="h-7 w-auto! text-xs">
                  {(Object.keys(SIZE_LABEL) as LineSize[]).map((z) => (
                    <option key={z} value={z}>
                      {SIZE_LABEL[z]}
                    </option>
                  ))}
                </Select>
                <label className="flex items-center gap-1 text-muted">
                  <input type="checkbox" checked={l.band} onChange={(e) => setLine(i, { band: e.target.checked })} className="accent-[var(--color-accent)]" />
                  Dark band
                </label>
                {expanded[i]!.text !== l.text.trim().replace(/\s{2,}/g, " ") && <span className="truncate font-mono text-subtle">→ {expanded[i]!.text || "(empty)"}</span>}
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between gap-2 text-[11px] text-subtle">
            <span>
              Fill-ins: {TOKENS.join(" ")}. {"{call}"}, {"{rst}"} and {"{name}"} come from Log a contact.
            </span>
            {lines.length < MAX_LINES && (
              <button type="button" className="shrink-0 text-accent-strong hover:underline" onClick={() => setLines([...lines, { text: "", pos: "middle", size: "m", color: "#ffffff", band: false }])}>
                + Line
              </button>
            )}
          </div>
          {missing && <p className="text-xs text-warn">A line is empty once filled in: type their call in Log a contact.</p>}
        </section>

        {/* Their picture in a corner: the SSTV way of replying. */}
        <section className="space-y-2 text-xs">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={insetOn} disabled={!theirs.length} onChange={(e) => setInsetOn(e.target.checked)} className="accent-[var(--color-accent)]" />
            <span className="font-medium text-fg">Put their picture in a corner</span>
            {!theirs.length && <span className="text-subtle">(none received yet)</span>}
          </label>
          {insetOn && theirs.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              <Select value={insetPic?.file ?? ""} onChange={(e) => setInsetFile(e.target.value)} className="h-7 text-xs">
                {theirs.map((p) => (
                  <option key={p.file} value={p.file}>
                    {utcTime(p.at)}Z {p.modeName}
                  </option>
                ))}
              </Select>
              <Select value={corner} onChange={(e) => setCorner(e.target.value as Corner)} className="h-7 text-xs">
                {(Object.keys(CORNER_LABEL) as Corner[]).map((c) => (
                  <option key={c} value={c}>
                    {CORNER_LABEL[c]}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </section>

        <label className="block text-xs text-muted">
          Mode
          <Select value={mode} onChange={(e) => setMode(e.target.value)} className="mt-1 w-full">
            {snap.sstv.modes.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} ({x.width}×{x.height})
              </option>
            ))}
          </Select>
        </label>
        {sending ? (
          <div className="flex items-center gap-3 text-xs">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel-3">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
            </div>
            <span className="w-20 text-right text-muted">{Math.max(0, Math.ceil((sending.startedAt + sending.durationMs - now) / 1000))} s left</span>
            <Button size="sm" variant="danger" onClick={() => void control("/sstv/halt")}>
              Halt TX
            </Button>
          </div>
        ) : (
          <Button variant="primary" className="w-full" disabled={!canOperate || busy || !source || !!incoming} title={incoming ? "A picture is coming in on this frequency" : snap.tx.blocked ? `Transmit is blocked: ${snap.tx.blocked}` : undefined} onClick={() => void send()}>
            {busy ? "Preparing…" : incoming ? `Wait: receiving ${incoming.modeName}` : !source ? "Pick a picture" : "Send"}
          </Button>
        )}
        <p className="text-[11px] text-subtle">
          The whole picture goes out in one transmission: Martin 1 is about 2 minutes, PD 180 about 3. Check your radio&apos;s transmit timeout allows it. <Badge tone="neutral">USB, no offset</Badge>
        </p>
      </div>
    </Card>
  );
}
