/**
 * SSTV modes: the common analogue picture formats, with the timings from their published
 * specifications (JL Barber N7CXI, "Proposal for SSTV Mode Specifications", and the mode
 * definitions MMSSTV and QSSTV use). Frequencies: sync 1200 Hz, black 1500 Hz, white
 * 2300 Hz. Every transmission starts with the VIS header, which names the mode.
 *
 * Martin and Scottie send each line as green, blue and red scans (Scottie with its sync
 * between blue and red). Robot and PD send luminance and colour difference: Robot 36
 * alternates R-Y and B-Y line by line, Robot 72 sends both every line, PD sends a pair of
 * lines as Y(odd) R-Y B-Y Y(even).
 */

export type ModeFamily = "martin" | "scottie" | "robot36" | "robot72" | "pd";

export interface SstvMode {
  id: string;
  name: string;
  vis: number;
  family: ModeFamily;
  width: number;
  height: number;
  /** ms: sync pulse, porch after it, one colour (or Y) scan, separator. */
  syncMs: number;
  porchMs: number;
  scanMs: number;
  sepMs: number;
  /** Chroma scan (Robot), ms. */
  chromaMs?: number;
  /** One line (PD: one line pair), ms. */
  lineMs: number;
}

const martin = (id: string, name: string, vis: number, scanMs: number): SstvMode => ({
  id, name, vis, family: "martin", width: 320, height: 256, syncMs: 4.862, porchMs: 0.572, scanMs, sepMs: 0.572,
  lineMs: 4.862 + 0.572 * 4 + scanMs * 3,
});
const scottie = (id: string, name: string, vis: number, scanMs: number): SstvMode => ({
  id, name, vis, family: "scottie", width: 320, height: 256, syncMs: 9, porchMs: 1.5, scanMs, sepMs: 1.5,
  lineMs: 1.5 * 3 + 9 + scanMs * 3,
});
const pd = (id: string, name: string, vis: number, width: number, height: number, scanMs: number): SstvMode => ({
  id, name, vis, family: "pd", width, height, syncMs: 20, porchMs: 2.08, scanMs, sepMs: 0,
  lineMs: 20 + 2.08 + scanMs * 4,
});

export const MODES: readonly SstvMode[] = [
  martin("M1", "Martin 1", 44, 146.432),
  martin("M2", "Martin 2", 40, 73.216),
  scottie("S1", "Scottie 1", 60, 138.24),
  scottie("S2", "Scottie 2", 56, 88.064),
  scottie("SDX", "Scottie DX", 76, 345.6),
  { id: "R36", name: "Robot 36", vis: 8, family: "robot36", width: 320, height: 240, syncMs: 9, porchMs: 3, scanMs: 88, sepMs: 4.5, chromaMs: 44, lineMs: 150 },
  { id: "R72", name: "Robot 72", vis: 12, family: "robot72", width: 320, height: 240, syncMs: 9, porchMs: 3, scanMs: 138, sepMs: 4.5, chromaMs: 69, lineMs: 300 },
  pd("PD90", "PD 90", 99, 320, 256, 170.24),
  pd("PD120", "PD 120", 95, 640, 496, 121.6),
  pd("PD160", "PD 160", 98, 512, 400, 195.584),
  pd("PD180", "PD 180", 96, 640, 496, 183.04),
  pd("PD240", "PD 240", 97, 640, 496, 244.48),
];

export const modeById = (id: string) => MODES.find((m) => m.id === id) ?? null;
export const modeByVis = (vis: number) => MODES.find((m) => m.vis === vis) ?? null;

/** Lines (PD: line pairs) a transmission sends. */
export const scanLines = (m: SstvMode) => (m.family === "pd" ? m.height / 2 : m.height);

/** Seconds on the air, VIS included. */
export const durationSec = (m: SstvMode) => (VIS_MS + (m.family === "scottie" ? m.syncMs : 0) + scanLines(m) * m.lineMs) / 1000;

export const F_SYNC = 1200;
export const F_BLACK = 1500;
export const F_WHITE = 2300;
export const F_LEADER = 1900;
export const F_VIS_0 = 1300;
export const F_VIS_1 = 1100;
/** Leader 300, break 10, leader 300, start bit 30, eight bits of 30, stop bit 30. */
export const VIS_MS = 300 + 10 + 300 + 30 * 10;

export const levelToHz = (v: number) => F_BLACK + (Math.max(0, Math.min(255, v)) * (F_WHITE - F_BLACK)) / 255;
export const hzToLevel = (f: number) => Math.max(0, Math.min(255, ((f - F_BLACK) * 255) / (F_WHITE - F_BLACK)));

/** ITU-R BT.601 studio range, as Robot and PD (and PySSTV, QSSTV) use. */
export function rgbToYcc(r: number, g: number, b: number): [number, number, number] {
  return [16 + (65.738 * r + 129.057 * g + 25.064 * b) / 256, 128 + (112.439 * r - 94.154 * g - 18.285 * b) / 256, 128 + (-37.945 * r - 74.494 * g + 112.439 * b) / 256];
}
export function yccToRgb(y: number, cr: number, cb: number): [number, number, number] {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const yy = 1.164 * (y - 16);
  return [c(yy + 1.596 * (cr - 128)), c(yy - 0.813 * (cr - 128) - 0.391 * (cb - 128)), c(yy + 2.018 * (cb - 128))];
}
