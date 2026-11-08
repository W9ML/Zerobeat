/**
 * Main-thread handle on the decoder thread. One job at a time; a job that has not come
 * back in 20 s kills and replaces the thread rather than wedging every later window.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { DecodeJob, DecodeResult } from "./decode-worker.ts";

function workerUrl(): { url: URL; execArgv: string[] } {
  const bundled = new URL("./decode-worker.mjs", import.meta.url);
  if (existsSync(fileURLToPath(bundled))) return { url: bundled, execArgv: [] };
  // Running from source (tsx): load the TypeScript worker through tsx.
  return { url: new URL("./decode-worker.ts", import.meta.url), execArgv: ["--import", "tsx"] };
}

export class Decoder {
  private worker: Worker | null = null;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (r: DecodeResult) => void; timer: NodeJS.Timeout }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly log: (msg: string) => void) {}

  private spawn(): Worker {
    const { url, execArgv } = workerUrl();
    const w = new Worker(url, { execArgv });
    w.on("message", (r: DecodeResult) => {
      const p = this.waiting.get(r.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.waiting.delete(r.id);
      p.resolve(r);
    });
    w.on("error", (e) => this.log(`decoder thread error: ${e.message}`));
    w.on("exit", (code) => {
      if (this.worker === w) this.worker = null;
      for (const [id, p] of this.waiting) {
        clearTimeout(p.timer);
        p.resolve({ id, decodes: [], ms: 0, error: `decoder thread exited (${code})` });
      }
      this.waiting.clear();
    });
    w.unref();
    return w;
  }

  /** Decode one window. Jobs are serialised so the hash-call book sees windows in order. */
  decode(job: Omit<DecodeJob, "id">): Promise<DecodeResult> {
    const run = () =>
      new Promise<DecodeResult>((resolve) => {
        if (!this.worker) this.worker = this.spawn();
        const id = this.nextId++;
        const timer = setTimeout(() => {
          this.waiting.delete(id);
          this.log("decoder thread wedged for 20s; restarting it");
          void this.worker?.terminate();
          this.worker = null;
          resolve({ id, decodes: [], ms: 20_000, error: "decode timed out" });
        }, 20_000);
        this.waiting.set(id, { resolve, timer });
        this.worker.postMessage({ ...job, id }, [job.samples.buffer as ArrayBuffer]);
      });
    const p = this.queue.then(run, run);
    this.queue = p;
    return p;
  }

  async close(): Promise<void> {
    await this.worker?.terminate();
    this.worker = null;
  }
}
