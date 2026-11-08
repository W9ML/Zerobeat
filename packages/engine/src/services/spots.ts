/**
 * DX spots: a DX cluster node and the Reverse Beacon Network, both telnet services that
 * send one line per spot after the client gives its callsign:
 *
 *   DX de K1TTT-#:   14074.0  W1XYZ        FT8 -12 dB                     1830Z
 *   DX de N0XYZ:     21025.5  JA1ABC       CQ, loud                       1831Z FN42
 *
 * Read-only: nothing is ever sent but the login, so no spot or command leaves this
 * station. Each connection reconnects with backoff, and the newest spots are kept for
 * the Operate page, the hunt and the "needed" alerts.
 */
import { EventEmitter } from "node:events";
import net from "node:net";

export interface Spot {
  at: number;
  freqHz: number;
  call: string;
  spotter: string;
  comment: string;
  mode: string | null;
  snr: number | null;
  wpm: number | null;
  grid: string | null;
  source: "cluster" | "rbn";
}

const SPOT_RE = /^DX de ([A-Z0-9/#-]+):?\s+(\d+(?:\.\d+)?)\s+([A-Z0-9/]+)\s+(.*?)\s*(\d{4})Z(?:\s+([A-R]{2}\d{2}))?\s*$/i;
const MODES = ["FT8", "FT4", "FT2", "JTTY", "JS8", "RTTY", "PSK31", "PSK63", "CW", "HELL", "SSB", "USB", "LSB", "FM", "AM", "WSPR", "SSTV", "MSK144", "Q65"];

/** One spot line, or null when the line is anything else (banners, prompts, talk). */
export function parseSpot(line: string, source: Spot["source"], now = Date.now()): Spot | null {
  const m = SPOT_RE.exec(line.trim());
  if (!m) return null;
  const [, spotter, khz, call, comment, hhmm, grid] = m;
  const freqHz = Math.round(Number(khz) * 1000);
  if (!freqHz || freqHz < 100_000) return null;
  const upper = comment!.toUpperCase();
  const mode = MODES.find((x) => new RegExp(`\\b${x}\\b`).test(upper)) ?? null;
  const snr = /(-?\d+)\s*DB\b/.exec(upper);
  const wpm = /(\d+)\s*WPM\b/.exec(upper);
  // The spot's time of day, today (or yesterday just after midnight).
  const d = new Date(now);
  let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Number(hhmm!.slice(0, 2)), Number(hhmm!.slice(2)));
  if (at > now + 5 * 60_000) at -= 86_400_000;
  return {
    at,
    freqHz,
    call: call!.toUpperCase(),
    spotter: spotter!.toUpperCase().replace(/-#$/, ""),
    comment: comment!.trim(),
    mode: mode === "USB" || mode === "LSB" ? "SSB" : mode,
    snr: snr ? Number(snr[1]) : null,
    wpm: wpm ? Number(wpm[1]) : null,
    grid: grid ? grid.toUpperCase() : null,
    source,
  };
}

export interface SpotSource {
  id: string;
  host: string;
  port: number;
  source: Spot["source"];
}

type Events = { spot: [Spot]; status: [] };

/** One telnet connection: log in with the callsign, read spot lines, reconnect on loss. */
class SpotConnection {
  private sock: net.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = false;
  private buf = "";
  private loggedIn = false;
  state: "connecting" | "connected" | "waiting" | "stopped" = "connecting";
  detail = "";

  constructor(
    readonly src: SpotSource,
    private readonly login: string,
    private readonly onLine: (line: string) => void,
    private readonly onStatus: () => void,
    private readonly log: (msg: string) => void,
  ) {
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    this.state = "connecting";
    this.detail = `${this.src.host}:${this.src.port}`;
    this.onStatus();
    this.loggedIn = false;
    this.buf = "";
    const s = net.connect({ host: this.src.host, port: this.src.port });
    this.sock = s;
    s.setEncoding("latin1");
    s.setTimeout(15 * 60_000); // a cluster that says nothing for 15 minutes has gone away
    const loginTimer = setTimeout(() => this.sendLogin(), 4_000);
    s.on("connect", () => {
      this.attempt = 0;
      this.state = "connected";
      this.detail = `${this.src.host}:${this.src.port}`;
      this.onStatus();
    });
    s.on("data", (d: string) => {
      this.buf += d;
      // Prompts arrive without a newline: answer them as soon as they appear.
      if (!this.loggedIn && /(login|call(sign)?)\s*[:?>]?\s*$/i.test(this.buf)) this.sendLogin();
      let i: number;
      while ((i = this.buf.search(/\r?\n/)) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + (this.buf[i] === "\r" ? 2 : 1));
        this.onLine(line);
      }
      if (this.buf.length > 8192) this.buf = "";
    });
    s.on("timeout", () => s.destroy(new Error("no data for 15 minutes")));
    s.on("error", (e) => (this.detail = e.message));
    s.on("close", () => {
      clearTimeout(loginTimer);
      this.sock = null;
      if (this.stopped) return;
      const delay = Math.min(10 * 60_000, 5_000 * 2 ** Math.min(this.attempt++, 7));
      this.state = "waiting";
      this.detail = `${this.detail || "closed"}; retrying in ${Math.round(delay / 1000)} s`;
      this.onStatus();
      if (this.attempt <= 3 || this.attempt % 10 === 0) this.log(`${this.src.id}: ${this.detail}`);
      this.timer = setTimeout(() => this.connect(), delay);
    });
  }

  private sendLogin(): void {
    if (this.loggedIn || !this.sock || this.sock.destroyed) return;
    this.loggedIn = true;
    this.sock.write(`${this.login}\r\n`);
  }

  stop(): void {
    this.stopped = true;
    this.state = "stopped";
    if (this.timer) clearTimeout(this.timer);
    this.sock?.destroy();
  }
}

export class SpotFeed extends EventEmitter<Events> {
  private conns = new Map<string, SpotConnection>();
  /** Newest last, at most KEEP. */
  spots: Spot[] = [];
  static readonly KEEP = 600;
  private seen = new Map<string, number>();

  constructor(private readonly log: (msg: string) => void) {
    super();
  }

  /** Connect to exactly these sources (reconnecting any whose address or login changed). */
  configure(sources: SpotSource[], login: string): void {
    const want = new Map(sources.map((s) => [`${s.id}|${s.host}|${s.port}|${login}`, s]));
    for (const [k, c] of this.conns) {
      if (!want.has(k)) {
        c.stop();
        this.conns.delete(k);
      }
    }
    if (!login) return;
    for (const [k, s] of want) {
      if (this.conns.has(k)) continue;
      this.conns.set(k, new SpotConnection(s, login, (line) => this.line(line, s.source), () => this.emit("status"), this.log));
    }
    this.emit("status");
  }

  private line(line: string, source: Spot["source"]): void {
    const spot = parseSpot(line, source);
    if (!spot) return;
    // The same station on the same frequency, spotted again within a few minutes, is one spot.
    const key = `${spot.call}|${Math.round(spot.freqHz / 500)}|${source}`;
    const last = this.seen.get(key);
    if (last && spot.at - last < 3 * 60_000) return;
    this.seen.set(key, spot.at);
    if (this.seen.size > 5_000) for (const [k, t] of this.seen) if (spot.at - t > 30 * 60_000) this.seen.delete(k);
    this.spots.push(spot);
    if (this.spots.length > SpotFeed.KEEP) this.spots.splice(0, this.spots.length - SpotFeed.KEEP);
    this.emit("spot", spot);
  }

  status(): { id: string; host: string; state: string; detail: string }[] {
    return [...this.conns.values()].map((c) => ({ id: c.src.id, host: `${c.src.host}:${c.src.port}`, state: c.state, detail: c.detail }));
  }

  stop(): void {
    for (const c of this.conns.values()) c.stop();
    this.conns.clear();
  }
}
