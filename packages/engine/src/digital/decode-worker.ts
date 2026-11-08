/**
 * Decoder thread. Holds one HashCallBook (and one FT8History for a7 decoding at depth 3)
 * for its whole life, so hashed callsigns learned in one window resolve in the next.
 */
import { parentPort } from "node:worker_threads";
import { decodeFT4, decodeFT8, FT8History, HashCallBook } from "@e04/ft8ts";

export interface DecodeJob {
  id: number;
  mode: "FT8" | "FT4" | "FT2";
  samples: Float32Array;
  slotStart: number;
  depth: number;
  knownCalls?: string[];
}

export interface DecodeResult {
  id: number;
  decodes: { freq: number; dt: number; snr: number; msg: string; ap?: number }[];
  ms: number;
  error?: string;
}

/** Twice as many samples, linearly interpolated: the signal at half speed. */
export function stretch2(x: Float32Array): Float32Array {
  const y = new Float32Array(x.length * 2);
  for (let i = 0; i < x.length; i++) {
    const a = x[i]!;
    const b = i + 1 < x.length ? x[i + 1]! : a;
    y[2 * i] = a;
    y[2 * i + 1] = (a + b) / 2;
  }
  return y;
}

const book = new HashCallBook();
const history = new FT8History();

parentPort?.on("message", (job: DecodeJob) => {
  const t0 = performance.now();
  try {
    for (const c of job.knownCalls ?? []) book.save(c);
    const opts = { sampleRate: 12_000, depth: job.depth, freqLow: 100, freqHigh: 3_100, hashCallBook: book };
    // FT2 is FT4 at twice the speed: played at half speed it IS FT4, at half the audio
    // frequency. Decode it that way and scale frequency and time back.
    const ft2 = job.mode === "FT2";
    const raw =
      job.mode === "FT8"
        ? decodeFT8(job.samples, { ...opts, history, slotStart: job.slotStart })
        : ft2
          ? decodeFT4(stretch2(job.samples), { ...opts, freqLow: 50, freqHigh: 1_560 })
          : decodeFT4(job.samples, opts);
    const k = ft2 ? 2 : 1;
    const decodes = raw.map((d) => ({
      freq: Math.round(d.freq * k),
      dt: Math.round((d.dt / k) * 10) / 10,
      // Stretched, the noise in the 2.5 kHz reference band doubles; add the 3 dB back.
      snr: Math.round(d.snr + (ft2 ? 3 : 0)),
      msg: d.msg.trim(),
      ...("ap" in d && d.ap ? { ap: d.ap as number } : {}),
    }));
    const res: DecodeResult = { id: job.id, decodes, ms: Math.round(performance.now() - t0) };
    parentPort!.postMessage(res);
  } catch (e) {
    const res: DecodeResult = { id: job.id, decodes: [], ms: Math.round(performance.now() - t0), error: (e as Error).message };
    parentPort!.postMessage(res);
  }
});
