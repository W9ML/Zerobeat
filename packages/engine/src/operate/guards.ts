/**
 * Safety brakes for automatic operating. Pure state with an injected clock.
 *
 * Pause causes and their remedies:
 *   fault   SWR, PA temperature, deaf receiver. Needs a person (or, for SWR, a band hop).
 *   quiet   Too many unanswered CQs. A band hop clears it.
 *   limit   Run time or contact count reached. Needs a person or the next schedule block.
 *
 * The run clock belongs to the run: re-arming after a fault does NOT reset it (the old
 * code did, so the run-time limit was only enforced across restarts).
 */
export type PauseCause = "fault" | "quiet" | "limit";

export interface GuardLimits {
  maxRunMinutes: number;
  maxQsosPerRun: number;
  maxUnansweredCqs: number;
  maxSwr: number;
  maxPaTempC: number;
  /** Consecutive receive windows with no decodes AND no audio before calling the receiver deaf. */
  deafWindows: number;
}

export interface GuardState {
  paused: { cause: PauseCause; reason: string; at: number } | null;
  runStartedAt: number | null;
  qsosThisRun: number;
  unansweredCqs: number;
  deafCount: number;
  lastSwr: number | null;
  lastPaTempC: number | null;
}

export class Guards {
  state: GuardState = { paused: null, runStartedAt: null, qsosThisRun: 0, unansweredCqs: 0, deafCount: 0, lastSwr: null, lastPaTempC: null };

  constructor(private limits: () => GuardLimits) {}

  private pause(cause: PauseCause, reason: string, now: number): void {
    const rank = { quiet: 1, limit: 2, fault: 3 } as const;
    if (this.state.paused && rank[this.state.paused.cause] > rank[cause]) return;
    this.state.paused = { cause, reason, at: now };
  }

  /** qsosSoFar: contacts the run already made, when a restart carries it on. */
  beginRun(now: number, resumedFrom?: number | null, qsosSoFar = 0): void {
    this.state.runStartedAt = resumedFrom ?? now;
    this.state.qsosThisRun = qsosSoFar;
    this.state.unansweredCqs = 0;
    this.state.deafCount = 0;
    if (this.state.paused?.cause !== "fault") this.state.paused = null;
  }

  endRun(): void {
    this.state.runStartedAt = null;
    if (this.state.paused?.cause !== "fault") this.state.paused = null;
  }

  /** A person cleared the pause. The run clock keeps running. */
  rearm(): void {
    this.state.paused = null;
    this.state.unansweredCqs = 0;
    this.state.deafCount = 0;
    this.state.lastSwr = null;
  }

  /** After a band hop: a quiet pause no longer applies; an SWR fault is re-measured. */
  afterBandChange(): void {
    if (this.state.paused?.cause === "quiet") this.state.paused = null;
    if (this.state.paused?.cause === "fault" && /SWR/.test(this.state.paused.reason)) this.state.paused = null;
    this.state.unansweredCqs = 0;
    this.state.deafCount = 0;
    this.state.lastSwr = null;
  }

  /** Can an automatic transmission go out now? Returns the refusal reason or null. */
  checkAuto(now: number): string | null {
    const l = this.limits();
    if (this.state.runStartedAt !== null && l.maxRunMinutes > 0 && now - this.state.runStartedAt >= l.maxRunMinutes * 60_000) {
      this.pause("limit", `run time limit of ${l.maxRunMinutes} min reached`, now);
    }
    if (l.maxQsosPerRun > 0 && this.state.qsosThisRun >= l.maxQsosPerRun) {
      this.pause("limit", `${this.state.qsosThisRun} contacts this run (limit ${l.maxQsosPerRun})`, now);
    }
    return this.state.paused ? this.state.paused.reason : null;
  }

  onTelemetry(t: { swr: number | null; paTempC: number | null }, keyed: boolean, now: number): void {
    const l = this.limits();
    if (keyed && t.swr !== null && t.swr > 0) {
      this.state.lastSwr = t.swr;
      if (t.swr > l.maxSwr) this.pause("fault", `SWR ${t.swr.toFixed(1)}:1 is above the ${l.maxSwr}:1 limit`, now);
    }
    if (t.paTempC !== null) {
      this.state.lastPaTempC = t.paTempC;
      if (t.paTempC > l.maxPaTempC) this.pause("fault", `PA temperature ${t.paTempC.toFixed(0)} °C is above ${l.maxPaTempC} °C`, now);
    }
  }

  /** One receive window finished (not one we transmitted in). */
  onRxWindow(decodes: number, rms: number, now: number): void {
    if (decodes === 0 && rms < 1e-5) this.state.deafCount++;
    else this.state.deafCount = 0;
    const l = this.limits();
    if (l.deafWindows > 0 && this.state.deafCount >= l.deafWindows) {
      this.pause("fault", `no receive audio for ${this.state.deafCount} windows — check the radio's receive audio (DAX on a Flex, the USB sound card otherwise)`, now);
    }
  }

  onCqSent(now: number): void {
    this.state.unansweredCqs++;
    const l = this.limits();
    if (l.maxUnansweredCqs > 0 && this.state.unansweredCqs >= l.maxUnansweredCqs) {
      this.pause("quiet", `${this.state.unansweredCqs} CQs without an answer`, now);
    }
  }

  onAnswered(): void {
    this.state.unansweredCqs = 0;
  }

  onQsoLogged(): void {
    this.state.qsosThisRun++;
    this.state.unansweredCqs = 0;
  }
}
