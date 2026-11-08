/**
 * WSPR-2 transmit side (WSJT-X lib/genwspr.f90 and lib/wsprd/wspr_wav.f90):
 * 162 symbols of continuous-phase 4-FSK, 12000/8192 = 1.4648 baud with the same tone
 * spacing, 110.6 s in all. The audio frequency names the centre of the four tones, as
 * WSJT-X's "Tx 1500 Hz" and wsprd's reported frequency do: tone t sits at
 * f0 + (t - 1.5) * 1.4648 Hz.
 */

import { packWspr } from "./codec.ts";
import { channelTones } from "./fec.ts";

export const WSPR_SYMBOLS = 162;
/** Samples per symbol at 12 kHz. */
export const WSPR_NSPS = 8192;
export const WSPR_BAUD = 12000 / WSPR_NSPS;
export const WSPR_TONE_SPACING_HZ = WSPR_BAUD;

/** The 162 channel tones (0-3) of a WSPR message ("K1ABC FN42 37", "PJ4/K1ABC 37", ...). */
export function wsprTones(message: string): number[] {
  return channelTones(packWspr(message));
}

/**
 * Unit-amplitude, phase-continuous waveform for the tones, centred on f0Hz. Symbol length
 * is 8192/12000 s at any sample rate (fractional sample counts are spread evenly).
 * The result starts with the first symbol; WSJT-X starts sending 1 s after the even
 * minute.
 */
export function wsprWaveform(tones: ArrayLike<number>, f0Hz: number, sampleRate = 12000): Float32Array {
  const nsps = (WSPR_NSPS * sampleRate) / 12000;
  const total = Math.round(tones.length * nsps);
  const out = new Float32Array(total);
  const twopi = 2 * Math.PI;
  let phi = 0;
  for (let k = 0; k < total; k++) {
    const sym = Math.min(tones.length - 1, Math.floor(k / nsps));
    const dphi = (twopi * (f0Hz + (tones[sym]! - 1.5) * WSPR_BAUD)) / sampleRate;
    // wspr_wav advances the phase before taking the sine
    phi += dphi;
    if (phi > twopi) phi -= twopi;
    out[k] = Math.sin(phi);
  }
  return out;
}
