"use client";
/**
 * The Hell tape: what the receiver prints at the marker, line after line, the newest at
 * the bottom. Each column shows two columns' worth of the pixel stream, the way the old
 * Hellschreiber's two-turn helix printed it, so a character lands whole somewhere in the
 * band however the sender's timing sits against ours. Each line is then lined up on its
 * own text (hell-align.ts) so it prints as two whole copies, not half, whole and half.
 * Our own messages print in the accent colour.
 */
import { useEffect, useRef, useState } from "react";

import { cn } from "@/components/ui";
import { hellTape, onHell, type HellChunk } from "@/lib/client/live";

import { hellPhase } from "@zerobeat/core/ham/hell-align";

const ROWS = 14;
const BAND = ROWS * 2;
const GAP = 8;
/** px per column and per pixel row; a font dot is a column wide and two pixels tall. */
const ZOOM = { s: { col: 2, row: 1 }, m: { col: 3, row: 1.5 }, l: { col: 4, row: 2 } } as const;
type Zoom = keyof typeof ZOOM;

function read<T extends string>(key: string, ok: readonly T[], dflt: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && ok.includes(v) ? v : dflt;
  } catch {
    return dflt;
  }
}

function save(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* fine */
  }
}

/** A CSS colour (any syntax, theme variables included) as RGB. */
function rgbOf(el: HTMLElement, cssVar: string): [number, number, number] {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const g = c.getContext("2d")!;
  g.fillStyle = getComputedStyle(el).getPropertyValue(cssVar).trim() || "#888";
  g.fillRect(0, 0, 1, 1);
  const d = g.getImageData(0, 0, 1, 1).data;
  return [d[0]!, d[1]!, d[2]!];
}

export function HellTape({ rxHz, empty }: { rxHz: number; empty: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState<Zoom>(() => read("ds.hell.zoom", ["s", "m", "l"], "m"));
  const [contrast, setContrast] = useState<number>(() => {
    const n = Number(read("ds.hell.contrast", Array.from({ length: 101 }, (_, i) => String(i)), "30"));
    return Number.isFinite(n) ? n : 30;
  });
  const [cols, setCols] = useState(0);

  useEffect(() => {
    const el = wrap.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    let frame = 0;
    let dirty = true;
    const z = ZOOM[zoom];
    // Ink below the cut is paper; above it the ink is stretched to full.
    const cut = (contrast / 100) * 0.6;

    const draw = () => {
      frame = 0;
      if (!dirty) return;
      dirty = false;
      const chunks = hellTape();
      const dpr = window.devicePixelRatio || 1;
      const W = el.clientWidth;
      const H = el.clientHeight;
      if (!W || !H) return;
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      cv.style.width = `${W}px`;
      cv.style.height = `${H}px`;
      const g = cv.getContext("2d")!;
      const [pr, pg, pb] = rgbOf(el, "--color-panel");
      const ink = rgbOf(el, "--color-fg");
      const txInk = rgbOf(el, "--color-accent");
      g.fillStyle = `rgb(${pr},${pg},${pb})`;
      g.fillRect(0, 0, cv.width, cv.height);

      // The whole stream, and which columns were ours.
      let total = 0;
      for (const c of chunks) total += c.px.length;
      const px = new Uint8Array(total);
      const ncols = Math.floor(total / ROWS);
      const tx = new Uint8Array(ncols + 1);
      let o = 0;
      for (const c of chunks) {
        px.set(c.px, o);
        if (c.tx) tx.fill(1, Math.floor(o / ROWS), Math.floor((o + c.px.length) / ROWS));
        o += c.px.length;
      }
      setCols(ncols);
      if (!ncols) return;

      const perLine = Math.max(10, Math.floor((W - 16) / z.col));
      const lineH = BAND * z.row + GAP;
      const lines = Math.ceil(ncols / perLine);
      const shown = Math.min(lines, Math.max(1, Math.floor((H - 8) / lineH)));
      // Draw at one pixel a column / pixel row, then scale up without smoothing.
      const img = new ImageData(perLine, shown * (BAND + 2));
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = pr;
        d[i + 1] = pg;
        d[i + 2] = pb;
        d[i + 3] = 255;
      }
      const first = lines - shown;
      // Where each received line's columns start, found from the line's own text so it
      // prints as two whole copies (hell-align.ts). A line with no clear text keeps the line
      // before's. Our own columns are already whole: the engine prints them from the font.
      let rxPhase = 0;
      const phases: number[] = [];
      for (let L = 0; L < lines; L++) {
        const a = L * perLine;
        rxPhase = hellPhase(px, a, Math.min(ncols, a + perLine), (k) => !tx[k]) ?? rxPhase;
        phases.push(rxPhase);
      }
      for (let L = 0; L < shown; L++) {
        const base = (first + L) * perLine;
        const rxP = phases[first + L]!;
        for (let x = 0; x < perLine; x++) {
          const k = base + x;
          if (k >= ncols) break;
          const col = tx[k] ? txInk : ink;
          const phase = tx[k] ? 0 : rxP;
          for (let y = 0; y < BAND; y++) {
            // Bottom of the band is the column's first pixel (Hell sends bottom to top).
            const s = k * ROWS + phase + (BAND - 1 - y);
            if (s >= total) continue;
            let v = px[s]! / 255;
            v = v <= cut ? 0 : (v - cut) / (1 - cut);
            if (v <= 0) continue;
            const p = ((L * (BAND + 2) + y) * perLine + x) * 4;
            d[p] = pr + (col[0] - pr) * v;
            d[p + 1] = pg + (col[1] - pg) * v;
            d[p + 2] = pb + (col[2] - pb) * v;
          }
        }
      }
      const off = document.createElement("canvas");
      off.width = img.width;
      off.height = img.height;
      off.getContext("2d")!.putImageData(img, 0, 0);
      g.imageSmoothingEnabled = false;
      for (let L = 0; L < shown; L++) {
        // Newest line at the bottom.
        const y = H - 4 - (shown - L) * lineH + GAP;
        g.drawImage(off, 0, L * (BAND + 2), perLine, BAND, 8 * dpr, y * dpr, perLine * z.col * dpr, BAND * z.row * dpr);
      }
    };
    const kick = () => {
      dirty = true;
      if (!frame) frame = requestAnimationFrame(draw);
    };
    kick();
    const off = onHell(kick);
    const ro = new ResizeObserver(kick);
    ro.observe(el);
    return () => {
      off();
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [zoom, contrast]);

  return (
    <div>
      <div ref={wrap} className="relative h-72 overflow-hidden bg-panel" data-hell-cols={cols}>
        <canvas ref={canvas} className="absolute inset-0" aria-label={`Hell tape at ${rxHz} Hz`} />
        {cols === 0 && <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted">{empty}</div>}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-3 py-1.5 text-[11px] text-muted">
        <span className="flex items-center gap-1">
          Size
          {(["s", "m", "l"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setZoom(k);
                save("ds.hell.zoom", k);
              }}
              className={cn("rounded px-1.5 py-0.5 uppercase", zoom === k ? "bg-panel-3 text-fg" : "hover:text-fg")}
            >
              {k}
            </button>
          ))}
        </span>
        <label className="flex items-center gap-2" title="Raise it to clean noise off the paper; lower it to dig out a weak signal">
          Contrast
          <input
            type="range"
            min={0}
            max={100}
            value={contrast}
            onChange={(e) => {
              setContrast(Number(e.target.value));
              save("ds.hell.contrast", e.target.value);
            }}
            className="w-24 accent-[var(--color-accent)]"
          />
        </label>
        <span className="ml-auto">Each line lines itself up on its text; text that slopes means the sender&apos;s clock is a little off.</span>
      </div>
    </div>
  );
}

export type { HellChunk };
