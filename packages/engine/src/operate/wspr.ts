/**
 * The WSPR desk: two-minute periods that start on the even minute. Receive audio is
 * gathered for each period and decoded on the aux thread 114 s in (the transmissions,
 * 110.6 s from 1 s past the minute, are over by then). Spots go to WSPRnet when that is
 * switched on, exactly as WSJT-X posts them (Network/wsprnet.cpp), with a status report
 * for periods that heard nothing.
 *
 * Transmit periods are chosen the way WSJT-X's scheduler does at 25 % and below
 * (WSPR/WsprTxScheduler.cpp, K1JT's algorithm): after each transmission, 2 to 5 receive
 * periods at 25 %, more at lower percentages, so stations do not lock into the same
 * slots. Keying stays with the station.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import type { AuxDecoder } from "../digital/aux-decoder.ts";
import type { WsprDecode } from "../digital/wspr/index.ts";

export const WSPR_PERIOD_MS = 120_000;
const RATE = 12_000;
/** Decode this far into the period. */
const DECODE_AT_MS = 114_000;

export interface WsprSpot extends WsprDecode {
  /** Start of the period, epoch ms. */
  at: number;
  dialHz: number;
  uploaded: boolean | null;
}

type Events = { state: []; spots: [WsprSpot[], number] };

export interface WsprConfig {
  call: string;
  grid6: string;
  dialHz: number;
  txPct: number;
  dbm: number;
  upload: boolean;
  version: string;
  /** False while transmit is off or blocked: every period is then a receive period. */
  canTransmit?: boolean;
}

/** WSJT-X's form fields for one spot (urlEncodeSpot + the per-spot items). */
export function wsprnetSpotForm(s: WsprSpot, c: WsprConfig): URLSearchParams {
  const d = new Date(s.at).toISOString();
  return new URLSearchParams({
    function: "wspr",
    rcall: c.call,
    rgrid: c.grid6,
    rqrg: ((s.dialHz + 1500) / 1e6).toFixed(6),
    date: d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10),
    time: d.slice(11, 13) + d.slice(14, 16),
    sig: String(s.snrDb),
    dt: s.dtSec.toFixed(1),
    drift: String(s.driftHz),
    tqrg: (s.freqHz / 1e6).toFixed(6),
    tcall: s.callsign ?? "",
    tgrid: s.grid ?? "",
    dbm: String(s.dbm),
    version: c.version,
    mode: "2",
  });
}

/** WSJT-X's status report for a period with nothing to spot (urlEncodeNoSpot). */
export function wsprnetStatusForm(c: WsprConfig): URLSearchParams {
  return new URLSearchParams({
    function: "wsprstat",
    rcall: c.call,
    rgrid: c.grid6,
    rqrg: ((c.dialHz + 1500) / 1e6).toFixed(6),
    tpct: String(c.txPct),
    tqrg: ((c.dialHz + 1500) / 1e6).toFixed(6),
    dbm: String(c.dbm),
    version: c.version,
    mode: "2",
  });
}

/** WSPR's message for a station: type 1 for a standard call, type 2 for a compound one. */
export function wsprMessage(call: string, grid: string, dbm: number): string {
  const c = call.toUpperCase();
  return /^[A-Z0-9]{1,2}\d[A-Z]{1,3}$|^[A-Z]\d{1,2}[A-Z]{1,3}$|^\d[A-Z]\d[A-Z]{1,3}$/.test(c) ? `${c} ${grid.slice(0, 4).toUpperCase()} ${dbm}` : `${c} ${dbm}`;
}

/** Receive periods to wait after a transmission (K1JT's algorithm for 25 % and below). */
export function receiveGap(pct: number, rnd = Math.random): number {
  if (pct <= 0) return Infinity;
  if (pct >= 50) return pct >= 100 ? 0 : 1;
  const rxavg = 100 / pct - 1;
  return Math.max(1, Math.floor(rxavg + 3 * Math.floor(rnd() * 100) / 100 - 1));
}

export class WsprDesk extends EventEmitter<Events> {
  active = false;
  spots: WsprSpot[] = [];
  /** The period being gathered: its start and its samples so far. */
  private period: { start: number; buf: Float32Array; n: number; tx: boolean } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private rxLeft = 1;
  nextTx: number | null = null;
  lastDecode: { at: number; count: number; ms: number; error?: string } | null = null;
  private readonly dir: string;

  constructor(
    private readonly aux: AuxDecoder,
    dataDir: string,
    private readonly config: () => WsprConfig,
    /** The station keys the radio; resolves when the transmission is over. */
    private readonly transmit: (periodStart: number) => Promise<void>,
    private readonly log: (level: "info" | "warn", msg: string) => void,
  ) {
    super();
    this.dir = path.join(dataDir, "wspr");
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.rxLeft = 1; // listen to one period before the first transmission
    this.schedule();
    this.emit("state");
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.period = null;
    this.nextTx = null;
    this.emit("state");
  }

  /** 12 kHz audio as it arrives, with the time of its first sample. */
  feed(x: Float32Array, firstMs: number): void {
    const p = this.period;
    if (!p || p.tx) return;
    const at = Math.round(((firstMs - p.start) / 1000) * RATE);
    for (let i = 0; i < x.length; i++) {
      const j = at + i;
      if (j >= 0 && j < p.buf.length) p.buf[j] = x[i]!;
    }
    p.n = Math.max(p.n, at + x.length);
  }

  /** At each even minute: start a period, transmitting in it if the plan says so. */
  private schedule(): void {
    if (!this.active) return;
    const now = Date.now();
    const start = Math.ceil(now / WSPR_PERIOD_MS) * WSPR_PERIOD_MS;
    // Plan this coming period now so the page can show it.
    const c = this.config();
    const txNext = c.txPct > 0 && c.canTransmit !== false && this.rxLeft <= 0;
    this.nextTx = txNext ? start : null;
    this.emit("state");
    this.timer = setTimeout(() => void this.periodStart(start, txNext), Math.max(0, start - now));
  }

  private async periodStart(start: number, tx: boolean): Promise<void> {
    if (!this.active) return;
    const c = this.config();
    this.period = { start, buf: new Float32Array(RATE * 120), n: 0, tx };
    if (tx) {
      this.rxLeft = receiveGap(c.txPct);
      this.schedule();
      await this.transmit(start).catch((e) => this.log("warn", `WSPR transmission: ${(e as Error).message}`));
      return;
    }
    this.rxLeft--;
    this.schedule();
    const p = this.period;
    setTimeout(() => void this.decode(p), Math.max(0, start + DECODE_AT_MS - Date.now()));
  }

  private async decode(p: { start: number; buf: Float32Array; n: number }): Promise<void> {
    if (!this.active) return;
    if (p.n < RATE * 100) {
      this.lastDecode = { at: p.start, count: 0, ms: 0, error: "not enough receive audio in that period" };
      this.emit("state");
      return;
    }
    const c = this.config();
    const r = await this.aux.decode({ kind: "wspr", samples: p.buf, dialHz: c.dialHz });
    this.lastDecode = { at: p.start, count: r.decodes.length, ms: r.ms, error: r.error };
    const found: WsprSpot[] = (r.decodes as WsprDecode[]).map((d) => ({ ...d, at: p.start, dialHz: c.dialHz, uploaded: c.upload ? false : null }));
    this.spots.push(...found);
    if (this.spots.length > 1000) this.spots.splice(0, this.spots.length - 1000);
    this.keep(found);
    this.emit("spots", found, p.start);
    this.emit("state");
    if (c.upload && c.call && c.grid6) await this.upload(found, c);
  }

  /** A day's spots, one JSON line each, for history. */
  private keep(found: WsprSpot[]): void {
    if (!found.length) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const day = new Date(found[0]!.at).toISOString().slice(0, 10);
      fs.appendFileSync(path.join(this.dir, `spots-${day}.jsonl`), found.map((s) => JSON.stringify(s)).join("\n") + "\n");
    } catch (e) {
      this.log("warn", `WSPR spot history: ${(e as Error).message}`);
    }
  }

  private async upload(found: WsprSpot[], c: WsprConfig): Promise<void> {
    const post = async (form: URLSearchParams) => {
      const res = await fetch("http://wsprnet.org/post/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString(), signal: AbortSignal.timeout(20_000) });
      return { ok: res.ok, text: await res.text() };
    };
    try {
      if (!found.length) {
        await post(wsprnetStatusForm(c));
        return;
      }
      for (const s of found) {
        const r = await post(wsprnetSpotForm(s, c));
        s.uploaded = r.ok && /spot\(s\) added/.test(r.text);
      }
      const n = found.filter((s) => s.uploaded).length;
      if (n < found.length) this.log("warn", `WSPRnet accepted ${n} of ${found.length} spots`);
    } catch (e) {
      this.log("warn", `WSPRnet: ${(e as Error).message}`);
    }
    this.emit("state");
  }

  snapshot() {
    return { active: this.active, nextTx: this.nextTx, transmittingPeriod: this.period?.tx ? this.period.start : null, lastDecode: this.lastDecode };
  }
}
