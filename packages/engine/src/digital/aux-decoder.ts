/** Main-thread handle on aux-worker (see decoder.ts for the pattern): one job at a time, 90 s limit. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { AuxJob, AuxResult } from "./aux-worker.ts";

function workerUrl(): { url: URL; execArgv: string[] } {
  const bundled = new URL("./aux-worker.mjs", import.meta.url);
  if (existsSync(fileURLToPath(bundled))) return { url: bundled, execArgv: [] };
  return { url: new URL("./aux-worker.ts", import.meta.url), execArgv: ["--import", "tsx"] };
}

export class AuxDecoder {
  private worker: Worker | null = null;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (r: AuxResult) => void; timer: NodeJS.Timeout }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly log: (msg: string) => void) {}

  private spawn(): Worker {
    const { url, execArgv } = workerUrl();
    const w = new Worker(url, { execArgv });
    w.on("message", (r: AuxResult) => {
      const p = this.waiting.get(r.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.waiting.delete(r.id);
      p.resolve(r);
    });
    w.on("error", (e) => this.log(`aux decoder thread error: ${e.message}`));
    w.on("exit", (code) => {
      if (this.worker === w) this.worker = null;
      for (const [id, p] of this.waiting) {
        clearTimeout(p.timer);
        p.resolve({ id, kind: "wspr", decodes: [], ms: 0, error: `aux decoder thread exited (${code})` });
      }
      this.waiting.clear();
    });
    w.unref();
    return w;
  }

  decode(job: AuxJob extends infer J ? (J extends { id: number } ? Omit<J, "id"> : never) : never): Promise<AuxResult> {
    const run = () =>
      new Promise<AuxResult>((resolve) => {
        if (!this.worker) this.worker = this.spawn();
        const id = this.nextId++;
        const timer = setTimeout(() => {
          this.waiting.delete(id);
          this.log("aux decoder thread wedged for 90 s; restarting it");
          void this.worker?.terminate();
          this.worker = null;
          resolve({ id, kind: job.kind, decodes: [], ms: 90_000, error: "decode timed out" });
        }, 90_000);
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
