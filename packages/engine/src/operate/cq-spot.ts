/**
 * Where to call CQ when someone else is on our frequency in our own slot: the nearest spot
 * as wide as a signal plus a guard to either side, clear of everyone heard in the slot.
 */
import type { DigitalMode } from "../digital/timing.ts";
import { MAX_TX_HZ, MIN_TX_HZ } from "../digital/waveform.ts";

/** How wide each mode's signal is on the air, Hz: its tones times their spacing. */
export const SIGNAL_HZ: Record<DigitalMode, number> = { FT8: 50, FT4: 84, FT2: 167 };

/** Null when our frequency is clear (or there is nowhere better to go). */
export function cqClearSpot(heard: { offsetHz: number; sender: string | null }[], here: number, mode: DigitalMode): { hz: number; call: string; theirHz: number } | null {
  const width = SIGNAL_HZ[mode];
  const onTop = heard.find((d) => Math.abs(d.offsetHz - here) < width);
  if (!onTop) return null;
  const need = width + 15;
  const lo = Math.max(400, MIN_TX_HZ + 100);
  const hi = MAX_TX_HZ - 100 - width;
  let near: number | null = null;
  let widest = { hz: here, gap: -1 };
  for (let f = lo; f <= hi; f += 5) {
    const gap = Math.min(...heard.map((d) => Math.abs(d.offsetHz - f)), 9999);
    if (gap >= need && (near === null || Math.abs(f - here) < Math.abs(near - here))) near = f;
    if (gap > widest.gap) widest = { hz: f, gap };
  }
  const hz = near ?? widest.hz;
  if (Math.abs(hz - here) < 5) return null;
  return { hz, call: onTop.sender ?? "a station", theirHz: Math.round(onTop.offsetHz) };
}
