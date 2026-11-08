import { summary } from "@zerobeat/core/log/stats";

import { authorize, json } from "@/lib/server/auth";
import { requestScope } from "@/lib/server/scope";
import { db, VERSION } from "@/lib/server/ctx";
import { engine } from "@/lib/server/engine";

type Obj = Record<string, unknown>;

// Every field below is named on purpose: the snapshot also holds the radio's address, who holds
// it, the UDP targets and the band plan, none of which may leave through an API key.
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 200): string | null => (typeof v === "string" ? v.slice(0, max) : null);
const bool = (v: unknown): boolean => v === true;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function tx(v: unknown) {
  const t = obj(v);
  if (!t) return null;
  const last = obj(t.last);
  return {
    allowed: bool(t.allowed),
    blocked: str(t.blocked),
    last: last ? { at: num(last.at), message: str(last.message) ?? "", ok: bool(last.ok) } : null,
    nextAt: num(t.nextAt),
  };
}

function qsoDetail(v: unknown) {
  const q = obj(v);
  if (!q) return null;
  return {
    them: str(q.them, 20),
    grid: str(q.grid, 10),
    phase: str(q.phase, 40),
    reportSent: str(q.reportSent, 10),
    reportRcvd: str(q.reportRcvd, 10),
    repeats: num(q.repeats),
    maxRepeats: num(q.maxRepeats),
    logged: bool(q.logged),
    park: str(q.park, 40),
    transcript: list(q.transcript)
      .slice(-6)
      .map((e) => {
        if (typeof e === "string") return { text: e.slice(0, 200), dir: null, at: null };
        const l = obj(e);
        return { text: str(l?.text) ?? "", dir: l?.dir === "tx" || l?.dir === "rx" ? l.dir : null, at: num(l?.at) };
      }),
  };
}

function callers(v: unknown) {
  return list(v)
    .slice(-10)
    .map(obj)
    .filter((c): c is Obj => !!c && typeof c.callsign === "string")
    .map((c) => ({ callsign: str(c.callsign, 20)!, snr: num(c.snr), offsetHz: num(c.offsetHz), at: num(c.at) }));
}

function autoDetail(v: unknown) {
  const a = obj(v);
  if (!a) return null;
  const paused = obj(a.paused);
  const desk = obj(obj(a.contest)?.desk);
  const chase = obj(a.chase);
  const byBand: Record<string, number> = {};
  for (const b of list(desk?.byBand).map(obj)) {
    const band = str(b?.band, 10);
    if (band) byBand[band] = num(b?.qsos) ?? 0;
  }
  return {
    runStartedAt: num(a.runStartedAt),
    qsosThisRun: num(a.qsosThisRun) ?? 0,
    paused: paused ? { cause: str(paused.cause, 20), reason: str(paused.reason), at: num(paused.at) } : null,
    contest: desk
      ? { name: str(desk.name, 80), qsos: num(desk.qsos), dupes: num(desk.dupes), mults: num(desk.mults), score: num(desk.score), rate10: num(desk.rate10), rate60: num(desk.rate60), byBand }
      : null,
    chase: chase ? { activator: str(chase.activator, 20), park: str(chase.park, 40), since: num(chase.since) } : null,
  };
}

export async function GET(req: Request) {
  const who = authorize(req, "VIEWER", { apiKey: true });
  if (who instanceof Response) return who;
  const s = await engine<Obj>("GET", "/status").catch(() => null);
  const d = s && s.status === 200 ? obj(s.data) : null;
  const radio = obj(d?.radio);
  return json({
    version: VERSION,
    log: summary(db(), requestScope(req, who).stationId),
    station: d
      ? {
          radio: radio?.link ?? null,
          dialHz: d.dialHz ?? null,
          band: d.band ?? null,
          mode: d.mode ?? null,
          auto: obj(d.auto)?.mode ?? null,
          transmitting: radio?.transmitting ?? null,
          qso: obj(d.qso)?.them ?? null,
          tx: tx(d.tx),
          qsoDetail: qsoDetail(d.qso),
          callers: callers(d.callers),
          autoDetail: autoDetail(d.auto),
          now: num(d.now),
        }
      : null,
  });
}
