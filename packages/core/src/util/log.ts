/**
 * Logger with repeat suppression.
 *
 * The previous install wrote the same ClubLog failure line 69,600 times. A line that
 * repeats under the same key is written once, then summarised ("… repeated 212× in the
 * last hour") when it changes or when the summary interval passes.
 */
export type Level = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

interface Repeat {
  message: string;
  count: number;
  firstAt: number;
  lastEmitAt: number;
}

export interface LoggerOptions {
  level?: Level;
  /** Internal: inherit a parent's numeric level. */
  rank?: number;
  /** How often a still-repeating message is re-summarised. */
  summaryIntervalMs?: number;
  sink?: (line: string) => void;
  clock?: () => number;
}

export class Logger {
  private readonly minRank: number;
  private readonly summaryIntervalMs: number;
  private readonly sink: (line: string) => void;
  private readonly clock: () => number;
  private readonly repeats = new Map<string, Repeat>();

  constructor(
    private readonly scope: string,
    opts: LoggerOptions = {},
  ) {
    this.minRank = opts.rank ?? LEVEL_RANK[opts.level ?? (process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;
    this.summaryIntervalMs = opts.summaryIntervalMs ?? 3_600_000;
    this.sink = opts.sink ?? ((line) => process.stdout.write(line + "\n"));
    this.clock = opts.clock ?? Date.now;
  }

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`, {
      rank: this.minRank,
      summaryIntervalMs: this.summaryIntervalMs,
      sink: this.sink,
      clock: this.clock,
    });
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.write("debug", msg, data);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.write("info", msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.write("warn", msg, data);
  }
  error(msg: string, data?: Record<string, unknown>): void {
    this.write("error", msg, data);
  }

  /**
   * Log once per distinct message under `key`; repeats are counted and summarised.
   * Use for anything that runs on a timer and can fail the same way every tick.
   */
  once(key: string, level: Level, msg: string, data?: Record<string, unknown>): void {
    const now = this.clock();
    const prev = this.repeats.get(key);
    if (prev && prev.message === msg) {
      prev.count += 1;
      if (now - prev.lastEmitAt >= this.summaryIntervalMs) {
        this.write(level, `${msg} (repeated ${prev.count}× since ${new Date(prev.firstAt).toISOString()})`, data);
        prev.lastEmitAt = now;
        prev.count = 0;
        prev.firstAt = now;
      }
      return;
    }
    if (prev && prev.count > 0) {
      this.write("info", `previous condition cleared after ${prev.count} repeat(s): ${prev.message}`);
    }
    this.repeats.set(key, { message: msg, count: 0, firstAt: now, lastEmitAt: now });
    this.write(level, msg, data);
  }

  /** Mark a keyed condition as resolved; logs the repeat count if there was one. */
  clear(key: string, resolvedMsg?: string): void {
    const prev = this.repeats.get(key);
    if (!prev) return;
    this.repeats.delete(key);
    this.write("info", resolvedMsg ?? `resolved: ${prev.message}` + (prev.count ? ` (after ${prev.count} repeat(s))` : ""));
  }

  private write(level: Level, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < this.minRank) return;
    const ts = new Date(this.clock()).toISOString();
    const extra = data && Object.keys(data).length ? " " + JSON.stringify(data) : "";
    this.sink(`${ts} ${level.padEnd(5)} [${this.scope}] ${msg}${extra}`);
  }
}

export const rootLogger = new Logger("zerobeat");
