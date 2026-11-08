/**
 * Operating schedule. Blocks are local time ("08:00-12:00=hunt"), start inclusive, end
 * exclusive, may wrap midnight; the last matching block wins; quiet hours override all.
 * The engine acts only when the DECISION changes, so an operator who overrides the
 * schedule keeps control until the next boundary.
 */
export type AutoMode = "off" | "cq" | "hunt" | "hunt-pota" | "pota-chase";
export const AUTO_MODES: AutoMode[] = ["off", "cq", "hunt", "hunt-pota", "pota-chase"];

interface Block {
  from: number;
  to: number;
  mode: AutoMode;
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function inRange(m: number, from: number, to: number): boolean {
  return from <= to ? m >= from && m < to : m >= from || m < to;
}

export function parseBlocks(text: string): Block[] {
  return text
    .split(/[\n,]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => {
      const m = /^(\d\d:\d\d)-(\d\d:\d\d)=(hunt|hunt-pota|pota-chase|cq)$/.exec(p);
      return m ? [{ from: toMin(m[1]!), to: toMin(m[2]!), mode: m[3] as AutoMode }] : [];
    });
}

export interface ScheduleDecision {
  mode: AutoMode;
  why: string;
}

export function decideSchedule(opts: { blocks: string; sleep: string; paResting: boolean }, local: Date): ScheduleDecision {
  const m = local.getHours() * 60 + local.getMinutes();
  if (opts.sleep) {
    const [a, b] = opts.sleep.split("-");
    if (a && b && inRange(m, toMin(a), toMin(b))) return { mode: "off", why: `quiet hours ${opts.sleep}` };
  }
  if (opts.paResting) return { mode: "off", why: "PA resting" };
  let hit: Block | null = null;
  for (const b of parseBlocks(opts.blocks)) if (inRange(m, b.from, b.to)) hit = b;
  return hit ? { mode: hit.mode, why: "schedule block" } : { mode: "off", why: "no block now" };
}

/** Counts keyed time; asks for a rest after `onMinutes` of it. */
export class PaDuty {
  keyedMs = 0;
  restUntil = 0;

  addKeyed(ms: number, onMinutes: number, restMinutes: number, now: number): boolean {
    if (onMinutes <= 0) return false;
    this.keyedMs += ms;
    if (this.keyedMs >= onMinutes * 60_000) {
      this.keyedMs = 0;
      this.restUntil = now + restMinutes * 60_000;
      return true;
    }
    return false;
  }

  resting(now: number): boolean {
    return now < this.restUntil;
  }
}
