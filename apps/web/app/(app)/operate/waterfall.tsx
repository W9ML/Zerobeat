"use client";
/**
 * The Operate-page waterfall: 0–3000 Hz of the slice audio, 20 rows a second from the
 * engine, drawn on the GPU with a playhead that glides between rows so it scrolls
 * smoothly whatever the network does. Three views:
 *
 *   2D           the classic waterfall
 *   Spectrogram  a live spectrum trace (with peak hold) over a shorter waterfall
 *   3D           the same data as a lit landscape, newest at the front
 */
import { useEffect, useRef, useState } from "react";

import { useMedia } from "@/lib/client/media";

import { cn } from "@/components/ui";
import { onWaterfallRow, waterfallHistory, type WaterfallRow } from "@/lib/client/live";

import { PALETTES, paletteBytes, paletteCss, type PaletteId } from "./palettes";
import { HIST, WaterfallGL } from "./waterfall-gl";

const MAX_HZ = 3000;
const LAG_ROWS = 3; // jitter buffer: the playhead trails the newest row by this much

type View = "2d" | "spectrogram" | "3d";
interface Prefs {
  view: View;
  palette: PaletteId;
  seconds: number;
  lo: number;
  span: number;
  /** Height of each view, CSS pixels, as the operator dragged it. */
  heights: Record<View, number>;
}
const HEIGHT: Record<View, number> = { "2d": 210, spectrogram: 280, "3d": 280 };
const MIN_H = 110;
const maxH = () => Math.max(MIN_H + 50, Math.round(window.innerHeight * 0.75));
const DEFAULTS: Prefs = { view: "2d", palette: "classic", seconds: 30, lo: -14, span: 55, heights: HEIGHT };
// v3: the engine's rows and the default colours changed (SmartSDR-like), so older floor,
// range and colours are not carried over; view, history and heights are.
const KEY = "ds.waterfall.v3";
const OLD_KEY = "ds.waterfall.v2";

function loadPrefs(): Prefs {
  try {
    const saved = localStorage.getItem(KEY);
    const old = saved ? null : (JSON.parse(localStorage.getItem(OLD_KEY) ?? "{}") as Partial<Prefs>);
    const p = saved ? (JSON.parse(saved) as Partial<Prefs>) : { view: old?.view, seconds: old?.seconds, heights: old?.heights };
    const hs = (p.heights ?? {}) as Partial<Record<View, number>>;
    const h = (v: View) => (typeof hs[v] === "number" && hs[v]! >= MIN_H && hs[v]! <= 2000 ? Math.round(hs[v]!) : HEIGHT[v]);
    return {
      view: p.view === "spectrogram" || p.view === "3d" ? p.view : "2d",
      palette: p.palette && p.palette in PALETTES ? p.palette : DEFAULTS.palette,
      seconds: [15, 30, 60].includes(p.seconds ?? 0) ? p.seconds! : DEFAULTS.seconds,
      lo: typeof p.lo === "number" ? Math.min(10, Math.max(-20, p.lo)) : DEFAULTS.lo,
      span: typeof p.span === "number" ? Math.min(80, Math.max(15, p.span)) : DEFAULTS.span,
      heights: { "2d": h("2d"), spectrogram: h("spectrogram"), "3d": h("3d") },
    };
  } catch {
    return DEFAULTS;
  }
}

const VIEWS: { id: View; label: string; title: string }[] = [
  { id: "2d", label: "2D", title: "Classic waterfall" },
  { id: "spectrogram", label: "Spectrogram", title: "Live spectrum trace over the waterfall" },
  { id: "3d", label: "3D", title: "Waterfall as a 3D landscape" },
];

export function Waterfall({ txHz, qsoHz, onPick, cycleSec = 15 }: { txHz: number; qsoHz: number | null; onPick?: (hz: number) => void; cycleSec?: number }) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  const [showSettings, setShowSettings] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const glCanvas = useRef<HTMLCanvasElement>(null);
  const traceCanvas = useRef<HTMLCanvasElement>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const staleRef = useRef(false);
  const cycleRef = useRef(cycleSec);
  cycleRef.current = cycleSec;

  useEffect(() => {
    setPrefs(loadPrefs());
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* private window: settings just won't stick */
    }
  }, [prefs, ready]);

  // Renderer, row intake and the animation loop live for the component's lifetime;
  // settings are read through refs so changing them never rebuilds the GPU state.
  const glRef = useRef<WaterfallGL | null>(null);
  useEffect(() => {
    const canvas = glCanvas.current!;
    let gl: WaterfallGL;
    try {
      gl = new WaterfallGL(canvas);
    } catch (e) {
      setFailed((e as Error).message);
      return;
    }
    glRef.current = gl;
    gl.setPalette(paletteBytes(prefsRef.current.palette));

    let rate = 20;
    let lastCycle = -1;
    let avg: Float32Array | null = null;
    let peak: Float32Array | null = null;
    let traceDirty = false;
    const intake = (r: WaterfallRow) => {
      rate = r.rate;
      const cyc = Math.floor(r.at / (cycleRef.current * 1000));
      const mark = lastCycle !== -1 && cyc !== lastCycle;
      lastCycle = cyc;
      gl.push(r.data, mark, r.tx);
      if (!avg || avg.length !== r.data.length) {
        avg = new Float32Array(r.data.length).fill(-10);
        peak = new Float32Array(r.data.length).fill(-10);
      }
      const decay = 10 / rate; // peak hold falls 10 dB a second
      for (let k = 0; k < r.data.length; k++) {
        const db = r.data[k]! / 2.5 - 10;
        avg[k]! += (db - avg[k]!) * 0.35;
        peak![k] = Math.max(peak![k]! - decay, db);
      }
      traceDirty = true;
    };
    const hist = waterfallHistory();
    for (const r of hist.slice(-HIST + 10)) intake(r);
    const off = onWaterfallRow(intake);

    let vh = gl.total - LAG_ROWS;
    let last = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const target = gl.total - LAG_ROWS;
      if (Math.abs(target - vh) > rate * 2) vh = target;
      else {
        vh += dt * rate;
        vh += (target - vh) * Math.min(1, dt * 2.5);
      }
      vh = Math.max(0, Math.min(vh, gl.total));
      const p = prefsRef.current;
      gl.render({ view: p.view === "3d" ? "3d" : "flat", head: vh, rows: p.seconds * rate * (p.view === "spectrogram" ? 0.6 : 1), lo: p.lo, span: p.span });
      if (p.view === "spectrogram" && avg && (traceDirty || staleRef.current)) {
        drawTrace(traceCanvas.current, avg, peak!, p);
        traceDirty = false;
        staleRef.current = false;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      off();
      gl.dispose();
      glRef.current = null;
    };
  }, []);

  useEffect(() => {
    glRef.current?.setPalette(paletteBytes(prefs.palette));
    staleRef.current = true;
  }, [prefs.palette, prefs.lo, prefs.span, prefs.view]);

  const set = (p: Partial<Prefs>) => setPrefs((x) => ({ ...x, ...p }));
  const pct = (hz: number) => `${(hz / MAX_HZ) * 100}%`;
  const hzAt = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(MAX_HZ, Math.round((((e.clientX - r.left) / r.width) * MAX_HZ) / 5) * 5));
  };
  // On a phone the waterfall is a strip: the decodes and the contact are the job there.
  const narrow = useMedia("(max-width: 639px)");
  const height = narrow ? Math.min(prefs.heights[prefs.view], 96) : prefs.heights[prefs.view];
  const setHeight = (px: number) => set({ heights: { ...prefs.heights, [prefs.view]: Math.round(Math.min(maxH(), Math.max(MIN_H, px))) } });
  // Drag the grip under the scale: the waterfall grows or shrinks and everything below it
  // (the decodes) moves with it, keeping the same gap.
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = height;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setHeight(h0 + ev.clientY - y0);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <div className="select-none">
      <div className="flex items-center gap-3 border-b border-line px-3 py-1.5">
        <div className="flex overflow-hidden rounded-md border border-line-strong" role="group" aria-label="Waterfall view">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              title={v.title}
              aria-pressed={prefs.view === v.id}
              onClick={() => set({ view: v.id })}
              className={cn("px-2.5 py-1 text-xs transition-colors", prefs.view === v.id ? "bg-panel-3 text-fg" : "bg-panel-2 text-muted hover:text-fg")}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <button
            type="button"
            aria-expanded={showSettings}
            aria-label="Waterfall settings"
            title="Theme, history, floor and range"
            onClick={() => setShowSettings((v) => !v)}
            className={cn("rounded-md border px-2 py-1 text-xs", showSettings ? "border-accent text-fg" : "border-line-strong text-muted hover:text-fg")}
          >
            ⚙ Settings
          </button>
          {showSettings && (
        <div className="absolute right-0 top-full z-20 mt-1 flex w-64 flex-col gap-2.5 rounded-lg border border-line-strong bg-panel p-3 text-xs text-muted shadow-xl shadow-black/50">
          <label className="flex items-center gap-1.5">
            <span className="w-14">Theme</span>
            <select value={prefs.palette} onChange={(e) => set({ palette: e.target.value as PaletteId })} className="rounded border border-line-strong bg-panel-2 px-1.5 py-0.5 text-fg">
              {(Object.keys(PALETTES) as PaletteId[]).map((id) => (
                <option key={id} value={id}>
                  {PALETTES[id].label}
                </option>
              ))}
            </select>
            <span className="h-3 flex-1 rounded-sm" style={{ background: `linear-gradient(90deg, ${[0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => paletteCss(prefs.palette, t)).join(",")})` }} />
          </label>
          <label className="flex items-center gap-1.5">
            <span className="w-14">History</span>
            <select value={prefs.seconds} onChange={(e) => set({ seconds: Number(e.target.value) })} className="rounded border border-line-strong bg-panel-2 px-1.5 py-0.5 text-fg">
              <option value={15}>15 s</option>
              <option value={30}>30 s</option>
              <option value={60}>1 min</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5" title="Black level: how far above or below the noise floor the colors start">
            <span className="w-14">Floor</span>
            <input type="range" min={-20} max={10} step={1} value={prefs.lo} onChange={(e) => set({ lo: Number(e.target.value) })} className="flex-1 accent-[var(--color-accent)]" />
          </label>
          <label className="flex items-center gap-1.5" title="Range: how many dB the color scale covers">
            <span className="w-14">Range</span>
            <input type="range" min={15} max={80} step={1} value={prefs.span} onChange={(e) => set({ span: Number(e.target.value) })} className="flex-1 accent-[var(--color-accent)]" />
          </label>
          <div className="flex justify-between">
            {prefs.lo !== DEFAULTS.lo || prefs.span !== DEFAULTS.span ? (
              <button type="button" className="text-accent-strong hover:underline" onClick={() => set({ lo: DEFAULTS.lo, span: DEFAULTS.span })}>
                Reset floor and range
              </button>
            ) : (
              <span />
            )}
            <button type="button" className="text-fg hover:underline" onClick={() => setShowSettings(false)}>
              Done
            </button>
          </div>
        </div>
          )}
        </div>
      </div>

      <div
        className={cn("relative bg-[#07090d]", onPick && "cursor-crosshair")}
        style={{ height }}
        onMouseMove={(e) => setHover(hzAt(e))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => onPick?.(Math.round(hzAt(e) / 10) * 10)}
        title={onPick ? "Click to set your transmit offset" : undefined}
      >
        <div className="flex h-full flex-col">
          {prefs.view === "spectrogram" && <canvas ref={traceCanvas} className="block h-[38%] w-full border-b border-line" />}
          <canvas ref={glCanvas} className="block min-h-0 w-full flex-1" />
        </div>
        {prefs.view === "2d" && (
          // Seconds ago down the right edge, as on a radio's waterfall (newest at the top).
          <div className="pointer-events-none absolute inset-y-0 right-0 w-9 font-mono text-[10px] text-white/70">
            {Array.from({ length: Math.floor((prefs.seconds - 1) / (prefs.seconds > 30 ? 10 : 5)) }, (_, i) => (i + 1) * (prefs.seconds > 30 ? 10 : 5)).map((s) => (
              <span key={s} className="absolute right-1 flex -translate-y-1/2 items-center gap-1" style={{ top: `${(s / prefs.seconds) * 100}%` }}>
                {s}s<span className="h-px w-1.5 bg-white/60" />
              </span>
            ))}
          </div>
        )}
        {failed && <div className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-muted">The waterfall needs WebGL2, which this browser does not offer ({failed}).</div>}
        <Marker hz={txHz} label={`TX ${txHz}`} className="bg-accent/90" tagClass="bg-accent text-white" pct={pct} />
        {qsoHz !== null && qsoHz !== txHz && <Marker hz={qsoHz} label="QSO" className="bg-me/80" tagClass="bg-me text-bg" pct={pct} />}
        {hover !== null && (
          <div className="pointer-events-none absolute inset-y-0 w-px bg-white/40" style={{ left: pct(hover) }}>
            <span className="absolute bottom-1 left-1.5 rounded-sm bg-black/70 px-1 font-mono text-[10px] text-white">{hover} Hz</span>
          </div>
        )}
      </div>
      <div className="relative h-5 border-t border-line bg-panel-2 font-mono text-[10px] text-subtle">
        {[0, 500, 1000, 1500, 2000, 2500, 3000].map((hz) => (
          <span key={hz} className={cn("absolute top-0.5", hz === 0 ? "" : hz === MAX_HZ ? "-translate-x-full" : "-translate-x-1/2")} style={{ left: pct(hz) }}>
            {hz}
          </span>
        ))}
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Waterfall height"
        aria-valuenow={height}
        aria-valuemin={MIN_H}
        tabIndex={0}
        title="Drag to resize the waterfall (double-click to reset)"
        onPointerDown={startDrag}
        onDoubleClick={() => setHeight(HEIGHT[prefs.view])}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            setHeight(height + (e.key === "ArrowDown" ? 1 : -1) * (e.shiftKey ? 60 : 20));
          }
        }}
        className="group flex h-3 cursor-row-resize touch-none items-center justify-center rounded-b-lg border-t border-line bg-panel-2 hover:bg-panel focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="h-1 w-10 rounded-full bg-line-strong group-hover:bg-muted" />
      </div>
    </div>
  );
}

function Marker({ hz, label, className, tagClass, pct }: { hz: number; label: string; className: string; tagClass: string; pct: (hz: number) => string }) {
  return (
    <div className={cn("pointer-events-none absolute inset-y-0 w-[2px]", className)} style={{ left: pct(hz) }}>
      <span className={cn("absolute top-1 rounded-sm px-1 font-mono text-[10px]", hz > MAX_HZ * 0.9 ? "right-1.5" : "left-1.5", tagClass)}>{label}</span>
    </div>
  );
}

/** Spectrum trace: average level filled with the palette, peak hold as a faint line. */
function drawTrace(canvas: HTMLCanvasElement | null, avg: Float32Array, peak: Float32Array, p: Prefs): void {
  if (!canvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#07090d";
  ctx.fillRect(0, 0, w, h);
  const yOf = (db: number) => h - Math.min(1, Math.max(0, (db - p.lo) / p.span)) * (h - 4 * dpr) - 1;

  // dB grid relative to the noise floor.
  ctx.font = `${10 * dpr}px ui-monospace, monospace`;
  ctx.textBaseline = "bottom";
  for (let db = Math.ceil(p.lo / 10) * 10; db <= p.lo + p.span; db += 10) {
    const y = Math.round(yOf(db)) + 0.5;
    ctx.strokeStyle = db === 0 ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    if (y > 14 * dpr) ctx.fillText(db === 0 ? "floor" : `${db > 0 ? "+" : ""}${db} dB`, 4 * dpr, y - 2 * dpr);
  }

  const n = avg.length;
  const col = (arr: Float32Array, x: number) => {
    const a = Math.floor((x / w) * n);
    const b = Math.max(a + 1, Math.floor(((x + 1) / w) * n));
    let m = -Infinity;
    for (let k = a; k < b && k < n; k++) m = Math.max(m, arr[k]!);
    return m;
  };
  const step = Math.max(1, Math.round(dpr));
  const path = new Path2D();
  path.moveTo(0, h);
  for (let x = 0; x <= w; x += step) path.lineTo(x, yOf(col(avg, Math.min(x, w - 1))));
  path.lineTo(w, h);
  path.closePath();
  const grad = ctx.createLinearGradient(0, h, 0, 0);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) grad.addColorStop(t, paletteCss(p.palette, 0.15 + t * 0.85, 0.2 + t * 0.55));
  ctx.fillStyle = grad;
  ctx.fill(path);

  ctx.beginPath();
  for (let x = 0; x <= w; x += step) {
    const y = yOf(col(avg, Math.min(x, w - 1)));
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = paletteCss(p.palette, 0.75);
  ctx.lineWidth = 1.25 * dpr;
  ctx.stroke();

  ctx.beginPath();
  for (let x = 0; x <= w; x += step) {
    const y = yOf(col(peak, Math.min(x, w - 1)));
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 1 * dpr;
  ctx.stroke();
}
