/**
 * A second decoder thread for the slower decoders (WSPR's two-minute periods, JS8), so a
 * decode that takes seconds never holds up the engine. One job at a time.
 */
import { parentPort } from "node:worker_threads";

import { decodeJs8, type Js8Decode } from "./js8/modem.ts";
import type { Js8Submode } from "./js8/params.ts";
import { decodeWspr, WsprHashTable, type WsprDecode } from "./wspr/index.ts";

export type AuxJob =
  | { id: number; kind: "wspr"; samples: Float32Array; dialHz: number }
  | { id: number; kind: "js8"; samples: Float32Array; submode: Js8Submode; nfqsoHz: number };
export type AuxResult = { id: number; kind: AuxJob["kind"]; decodes: (WsprDecode | Js8Decode)[]; ms: number; error?: string };

// Callsign hashes learned from decoded messages, for later type 3 messages (as wsprd keeps).
const hashes = new WsprHashTable();

parentPort?.on("message", (job: AuxJob) => {
  const t0 = performance.now();
  try {
    const decodes =
      job.kind === "wspr"
        ? decodeWspr(job.samples, { dialHz: job.dialHz, wideband: true, hashTable: hashes })
        : decodeJs8(job.samples, job.submode, { depth: 2, nfqsoHz: job.nfqsoHz });
    parentPort!.postMessage({ id: job.id, kind: job.kind, decodes, ms: Math.round(performance.now() - t0) } satisfies AuxResult);
  } catch (e) {
    parentPort!.postMessage({ id: job.id, kind: job.kind, decodes: [], ms: Math.round(performance.now() - t0), error: (e as Error).message } satisfies AuxResult);
  }
});
