/**
 * Transmit waveforms. ft8ts derives symbol length from `samplesPerSymbol`, NOT from
 * `sampleRate`; without it a 24 kHz waveform plays at twice the symbol rate and nobody
 * can decode it. Baud rates: FT8 6.25, FT4 12000/576 = 20.833.
 */
import { encodeFT4, encodeFT8 } from "@e04/ft8ts";

import type { DigitalMode } from "./timing.ts";

// FT2 is the FT4 waveform at twice the keying rate (Decodium encodes it with its FT4 encoder).
const BAUD: Record<DigitalMode, number> = { FT8: 6.25, FT4: 12_000 / 576, FT2: 12_000 / 288 };

export const MIN_TX_HZ = 200;
export const MAX_TX_HZ = 2900;

export function buildWaveform(message: string, mode: DigitalMode, offsetHz: number, sampleRate = 24_000): Float32Array {
  if (offsetHz < MIN_TX_HZ || offsetHz > MAX_TX_HZ) throw new Error(`TX offset ${offsetHz} Hz is outside ${MIN_TX_HZ}-${MAX_TX_HZ} Hz`);
  const opts = { sampleRate, samplesPerSymbol: Math.round(sampleRate / BAUD[mode]), baseFrequency: offsetHz };
  const w = mode === "FT8" ? encodeFT8(message, opts) : encodeFT4(message, opts);
  // Leave a little headroom below full scale for the radio's ALC.
  let peak = 0;
  for (let i = 0; i < w.length; i++) peak = Math.max(peak, Math.abs(w[i]!));
  const k = peak > 0 ? 0.9 / peak : 1;
  for (let i = 0; i < w.length; i++) w[i]! *= k;
  return w;
}
