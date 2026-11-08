/**
 * The SSTV desk: listens for pictures while SSTV is the mode, keeps the picture being
 * received as data/sstv/current.png (redrawn every few lines, for the page to show it
 * growing), and saves each finished one as data/sstv/<time>-<mode>.png with a small
 * index the gallery reads. Keying stays with the station (Station.sendSstv).
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import { SstvReceiver, type SstvEvent } from "../digital/sstv/decode.ts";
import { MODES, type SstvMode } from "@zerobeat/core/sstv/modes";

export interface SstvPicture {
  file: string;
  mode: string;
  modeName: string;
  at: number;
  width: number;
  height: number;
  lines: number;
  complete: boolean;
  slantPpm: number;
  dialHz: number | null;
  dir: "rx" | "tx";
}

type Events = { state: []; picture: [SstvPicture] };

const DAY_MS = 86_400_000;
/** However long they are kept, never more than this many (about 1 GB). */
const MAX_PICTURES = 5000;

async function writePng(file: string, rgb: Uint8Array, width: number, height: number): Promise<void> {
  const { default: sharp } = await import("sharp");
  const tmp = `${file}.tmp`;
  await sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength), { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 6 })
    .toFile(tmp);
  fs.renameSync(tmp, file);
}

export class SstvDesk extends EventEmitter<Events> {
  active = false;
  pictures: SstvPicture[] = [];
  receiving: { mode: string; modeName: string; line: number; of: number; since: number } | null = null;
  sending: { mode: string; startedAt: number; durationMs: number } | null = null;
  private rx: SstvReceiver;
  private readonly dir: string;
  private lastDraw = 0;
  private writing = false;
  dialHz: () => number | null = () => null;
  /** How long pictures are kept (setting sstv.keepDays). */
  keepDays: () => number = () => 90;

  constructor(dataDir: string) {
    super();
    this.dir = path.join(dataDir, "sstv");
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.pictures = JSON.parse(fs.readFileSync(path.join(this.dir, "index.json"), "utf8")) as SstvPicture[];
    } catch {
      this.pictures = [];
    }
    this.rx = new SstvReceiver((e) => void this.onEvent(e));
  }

  start(): void {
    this.prune();
    if (this.active) return;
    this.active = true;
    this.rx = new SstvReceiver((e) => void this.onEvent(e));
    this.emit("state");
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.receiving = null;
    this.emit("state");
  }

  set muted(m: boolean) {
    this.rx.muted = m;
  }

  feed(samples: Float32Array, firstSampleMs: number): void {
    if (this.active) this.rx.push(samples, firstSampleMs);
  }

  private async onEvent(e: SstvEvent): Promise<void> {
    if (e.type === "start") {
      this.receiving = { mode: e.mode.id, modeName: e.mode.name, line: 0, of: e.mode.height, since: e.atMs };
      this.lastDraw = 0;
      this.emit("state");
      return;
    }
    if (e.type === "line") {
      if (this.receiving) this.receiving.line = e.line;
      // Redraw the picture in progress every 16 lines (and not while a write is under way).
      if (e.line - this.lastDraw >= 16 && !this.writing) {
        this.lastDraw = e.line;
        this.writing = true;
        await writePng(path.join(this.dir, "current.png"), e.rgb, e.mode.width, e.mode.height).catch(() => {});
        this.writing = false;
        this.emit("state");
      }
      return;
    }
    this.receiving = null;
    await this.save(e.mode, e.rgb, { at: e.atMs, lines: e.lines, complete: e.complete, slantPpm: e.slantPpm, dir: "rx" });
  }

  /** Keep a picture (received, or one we sent) in the gallery. */
  async save(mode: SstvMode, rgb: Uint8Array, meta: { at: number; lines: number; complete: boolean; slantPpm: number; dir: "rx" | "tx" }): Promise<SstvPicture> {
    const stamp = new Date(meta.at).toISOString().replace(/[-:]/g, "").slice(0, 15);
    const file = `${stamp}-${meta.dir}-${mode.id}.png`;
    await writePng(path.join(this.dir, file), rgb, mode.width, mode.height);
    const pic: SstvPicture = { file, mode: mode.id, modeName: mode.name, at: meta.at, width: mode.width, height: mode.height, lines: meta.lines, complete: meta.complete, slantPpm: meta.slantPpm, dialHz: this.dialHz(), dir: meta.dir };
    this.pictures.push(pic);
    this.prune();
    fs.writeFileSync(path.join(this.dir, "index.json"), JSON.stringify(this.pictures));
    this.emit("picture", pic);
    this.emit("state");
    return pic;
  }

  /** Delete pictures past the keep time, and the oldest beyond MAX_PICTURES. */
  prune(now = Date.now()): void {
    const cutoff = now - Math.max(1, this.keepDays()) * DAY_MS;
    const n = this.pictures.length;
    const keep = this.pictures.filter((p) => p.at >= cutoff);
    const gone = [...this.pictures.filter((p) => p.at < cutoff), ...keep.splice(0, Math.max(0, keep.length - MAX_PICTURES))];
    for (const old of gone) fs.rmSync(path.join(this.dir, old.file), { force: true });
    this.pictures = keep;
    if (this.pictures.length !== n) fs.writeFileSync(path.join(this.dir, "index.json"), JSON.stringify(this.pictures));
  }

  /** A page of the gallery, newest first: pictures before `before` (ms), and how many there are in all. */
  page(before = Infinity, limit = 60): { pictures: SstvPicture[]; total: number } {
    const older = this.pictures.filter((p) => p.at < before);
    return { pictures: older.slice(-limit).reverse(), total: this.pictures.length };
  }

  snapshot() {
    return { active: this.active, receiving: this.receiving, sending: this.sending, modes: MODES.map((m) => ({ id: m.id, name: m.name, width: m.width, height: m.height })) };
  }
}
