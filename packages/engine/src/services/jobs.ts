/**
 * Background jobs on fixed intervals. Each job runs alone (never overlapping itself),
 * records its last result in engine_state for the Services page, and logs a repeated
 * failure once rather than every run.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { sweepSessions, LoginThrottle } from "@zerobeat/core/auth/sessions";
import type { Db } from "@zerobeat/core/db/client";
import { getSqlite } from "@zerobeat/core/db/client";
import { CTY_CSV_URL, parseCtyCsv, reloadDxcc } from "@zerobeat/core/dxcc/cty";
import { httpRequest } from "@zerobeat/core/integrations/http";
import { QrzLookup } from "@zerobeat/core/integrations/qrz";
import type { Alerter } from "@zerobeat/core/mail";
import { mailConfigured, sendMail } from "@zerobeat/core/mail";
import { approveQsls, enqueueQsl, isOptedOut, qslCandidates, sendApproved } from "@zerobeat/core/qsl/queue";
import type { SettingsStore } from "@zerobeat/core/settings/store";
import type { EngineState } from "@zerobeat/core/state/engine-state";
import type { Logger } from "@zerobeat/core/util/log";
import { accounts } from "@zerobeat/core/log/owners";
import { defaultStation } from "@zerobeat/core/log/qsos";
import { qslCardPath } from "@zerobeat/core/qsl/card-path";
import type { SettingsSnapshot } from "@zerobeat/core/settings/registry";

import type { Station } from "../operate/station.ts";
import type { PskReporter } from "./pskreporter.ts";
import type { UploadRunner } from "./uploads.ts";
import { syncEqsl, syncLotw, syncQrz } from "./confirmations.ts";
import { fetchHeardBy } from "./heardby.ts";
import type { Pusher } from "./push.ts";
import { recentRuns, type NewOne } from "../operate/runs.ts";

interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<string>;
  firstAfterMs?: number;
}

/** One user's turn in a job: their station, settings and state. */
interface UserRun {
  userId: string;
  stationId: string;
  callsign: string;
  grid: string;
  s: SettingsSnapshot;
  st: EngineState;
}

export class Jobs {
  private timers: NodeJS.Timeout[] = [];
  private busy = new Set<string>();
  private readonly jobs: Job[];
  private radioDownSince: number | null = null;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsStore,
    private readonly state: EngineState,
    private readonly uploads: UploadRunner,
    private readonly station: Station,
    private readonly psk: PskReporter,
    private readonly alerter: Alerter,
    private readonly log: Logger,
    private readonly dataDir: string,
    private readonly pusher: Pusher,
  ) {
    this.jobs = [
      { name: "uploads", everyMs: 2 * 60_000, firstAfterMs: 20_000, run: async () => summarise(await this.uploads.runAll()) },
      { name: "lotw-confirmations", everyMs: 6 * 3_600_000, firstAfterMs: 5 * 60_000, run: () => this.eachUser((a) => syncLotw(this.db, a.s, a.st, a.stationId)) },
      { name: "eqsl-confirmations", everyMs: 6 * 3_600_000, firstAfterMs: 7 * 60_000, run: () => this.eachUser((a) => syncEqsl(this.db, a.s, a.st, a.stationId)) },
      { name: "qrz-confirmations", everyMs: 6 * 3_600_000, firstAfterMs: 9 * 60_000, run: () => this.eachUser((a) => syncQrz(this.db, a.s, a.st, a.stationId)) },
      { name: "qsl", everyMs: 5 * 60_000, firstAfterMs: 60_000, run: () => this.eachUser((a) => this.qslJob(a)) },
      { name: "pskreporter", everyMs: 60_000, run: () => this.pskJob() },
      { name: "radio-watch", everyMs: 60_000, run: () => this.radioWatch() },
      { name: "heard-by", everyMs: 5 * 60_000 + 5_000, firstAfterMs: 90_000, run: () => this.heardBy() },
      { name: "digest", everyMs: 60_000, firstAfterMs: 30_000, run: () => this.digest() },
      { name: "housekeeping", everyMs: 6 * 3_600_000, firstAfterMs: 2 * 60_000, run: () => this.housekeeping() },
      { name: "backup", everyMs: 24 * 3_600_000, firstAfterMs: 10 * 60_000, run: () => this.backup() },
      { name: "dxcc-refresh", everyMs: 7 * 24 * 3_600_000, firstAfterMs: 30 * 60_000, run: () => this.refreshCty() },
    ];
  }

  start(): void {
    for (const j of this.jobs) {
      const first = setTimeout(() => void this.runJob(j.name), j.firstAfterMs ?? j.everyMs);
      const every = setInterval(() => void this.runJob(j.name), j.everyMs);
      this.timers.push(first, every);
    }
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  names(): string[] {
    return this.jobs.map((j) => j.name);
  }

  async runJob(name: string): Promise<{ ok: boolean; detail: string }> {
    const job = this.jobs.find((j) => j.name === name);
    if (!job) return { ok: false, detail: "no such job" };
    if (this.busy.has(name)) return { ok: false, detail: "already running" };
    this.busy.add(name);
    let result: { ok: boolean; detail: string };
    try {
      const detail = await job.run();
      result = { ok: true, detail };
      this.log.clear(`job:${name}`);
    } catch (e) {
      result = { ok: false, detail: (e as Error).message };
      this.log.once(`job:${name}`, "warn", `${name}: ${(e as Error).message}`);
    } finally {
      this.busy.delete(name);
    }
    if (!["pskreporter", "radio-watch", "digest", "heard-by"].includes(name) || result.detail.startsWith("sent") || /new$/.test(result.detail)) {
      this.state.set("jobs", { ...(this.state.get("jobs") ?? {}), [name]: { at: Date.now(), ...result } });
    }
    return result;
  }

  // ---------------------------------------------------------------------------

  /**
   * Run a job once for every user with their own settings, state and logbook; the results
   * are joined "CALL: result" (a single user's alone). Users with nothing set up say "off".
   */
  private async eachUser(fn: (a: UserRun) => Promise<string>): Promise<string> {
    const out: string[] = [];
    const list = accounts(this.db);
    for (const acc of list) {
      const a: UserRun = { ...acc, s: this.settings.snapshot(acc.userId), st: this.state.forUser(acc.userId) };
      try {
        out.push(`${list.length > 1 ? `${a.callsign}: ` : ""}${await fn(a)}`);
      } catch (e) {
        out.push(`${a.callsign}: ${(e as Error).message}`);
      }
    }
    return out.join("; ") || "no users";
  }

  /** A QRZ XML client for one user's login (lookups for QSL addresses), reused while it holds. */
  private qrzFor = new Map<string, QrzLookup>();
  private lookup(s: SettingsSnapshot): QrzLookup | null {
    if (!s["qrz.username"] || !s["qrz.password"]) return null;
    const key = `${s["qrz.username"]}|${s["qrz.password"]}`;
    let q = this.qrzFor.get(key);
    if (!q) {
      q = new QrzLookup(s["qrz.username"], s["qrz.password"]);
      this.qrzFor.set(key, q);
    }
    return q;
  }

  /** Where a user's QSL card picture is: their own, or the shack's old one for its owner. */
  cardPath(userId: string): string {
    return qslCardPath(this.dataDir, userId, defaultStation(this.db)?.userId);
  }

  private async qslJob(a: UserRun): Promise<string> {
    const s = a.s;
    if (s["qsl.mode"] === "off") return "off";
    if (!mailConfigured(s)) return "email is not configured";
    if (!s["app.publicUrl"]) return "Public URL is not set";
    const qrz = this.lookup(s);
    let queued = 0;
    const newIds: string[] = [];
    if (qrz) {
      for (const q of qslCandidates(this.db, s, Date.now(), 25, a.stationId)) {
        if (isOptedOut(this.db, q.callsign)) continue;
        let email = q.email;
        if (!email) {
          const info = await qrz.lookup(q.callsign).catch(() => null);
          if (info?.qslManager && /NOQSOCC|NO\s*EMAIL|NOEQSL/i.test(info.qslManager)) continue;
          email = info?.email ?? null;
        }
        if (!email) {
          // Mark as considered so it is not looked up again every five minutes.
          this.db.run(sql`INSERT INTO qsl_emails (id, qso_id, to_address, subject, body, status, error, created_at, updated_at)
            VALUES (${"x" + q.id}, ${q.id}, '', '', '', 'cancelled', 'no email address on QRZ', ${Date.now()}, ${Date.now()})`);
          continue;
        }
        const r = enqueueQsl(this.db, s, q.id, email);
        if (r.ok) {
          queued++;
          newIds.push(r.id);
        }
      }
    }
    if (s["qsl.mode"] === "send") approveQsls(this.db, newIds, null);
    const sent = await sendApproved(this.db, s, { cardImagePath: this.cardPath(a.userId), log: (m) => this.log.warn(m), stationId: a.stationId });
    return `queued ${queued}, sent ${sent.sent}${sent.failed ? `, ${sent.failed} failed` : ""}${qrz ? "" : " (no QRZ login, so no new addresses)"}`;
  }

  private async pskJob(): Promise<string> {
    const s = this.settings.snapshot();
    if (!s["pskreporter.enabled"]) return "off";
    const st = this.station.me();
    if (!st) return "no station";
    const n = await this.psk.flush({ callsign: st.call, grid: st.grid, antenna: s["pskreporter.antenna"] });
    return `sent ${n}`;
  }

  private async radioWatch(): Promise<string> {
    const now = Date.now();
    if (this.station.ft0) {
      this.radioDownSince = null;
      return "FT-0";
    }
    if (this.station.radio) {
      if (this.radioDownSince && now - this.radioDownSince > 10 * 60_000) {
        void this.alerter.raise("radio-up", "radio reconnected", `The radio is connected again after ${Math.round((now - this.radioDownSince) / 60_000)} minutes.`);
      }
      this.alerter.clear("radio-down");
      this.radioDownSince = null;
      return "connected";
    }
    this.radioDownSince ??= now;
    if (now - this.radioDownSince > 10 * 60_000) {
      const mins = Math.round((now - this.radioDownSince) / 60_000);
      await this.alerter.raise("radio-down", "radio is not connected", `Zerobeat has not been able to connect to the radio for ${mins} minutes.\n\nLast status: ${this.station.snapshot().radio.detail}`);
      if (mins === 10) await this.pusher.send("faults", { title: "Radio not connected", body: `For ${mins} minutes. ${this.station.snapshot().radio.detail}`, url: "/operate", tag: "radio-down" });
    }
    return "down";
  }

  private async housekeeping(): Promise<string> {
    const s = this.settings.snapshot();
    const cutoff = Date.now() - s["app.decodeRetentionDays"] * 86_400_000;
    const d = this.db.run(sql`DELETE FROM decodes WHERE at < ${cutoff} AND logged_qso_id IS NULL`).changes;
    const sess = sweepSessions(this.db);
    new LoginThrottle(this.db).sweep();
    getSqlite().pragma("wal_checkpoint(TRUNCATE)");
    getSqlite().pragma("optimize");
    return `pruned ${d} decodes, ${sess} expired sessions`;
  }

  private async backup(): Promise<string> {
    const dir = join(this.dataDir, "backups");
    mkdirSync(dir, { recursive: true });
    const name = `zerobeat-${new Date().toISOString().slice(0, 10)}.db`;
    const path = join(dir, name);
    // Write beside it and rename over: if the backup fails, today's earlier copy is
    // still there (it used to be deleted first).
    const partial = `${path}.partial`;
    if (existsSync(partial)) rmSync(partial);
    await getSqlite().backup(partial);
    renameSync(partial, path);
    const prune = (d: string, re: RegExp, keep: number) => {
      const files = readdirSync(d).filter((f) => re.test(f)).sort();
      for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(d, f));
      return Math.min(files.length, keep);
    };
    const kept = prune(dir, /^zerobeat-\d{4}-\d{2}-\d{2}\.db$/, 14);
    // update.sh's copies, one per update: the last five.
    prune(dir, /^pre-update-\d{8}-\d{6}\.db$/, 5);
    let copy = "";
    const other = this.settings.get("app.backupCopyDir");
    if (other) {
      try {
        copyFileSync(path, join(other, `${name}.partial`));
        renameSync(join(other, `${name}.partial`), join(other, name));
        prune(other, /^zerobeat-\d{4}-\d{2}-\d{2}\.db$/, 14);
        copy = `; copied to ${other}`;
      } catch (e) {
        copy = `; copying to ${other} FAILED: ${(e as Error).message}`;
      }
    }
    return `wrote ${name}; keeping ${kept}${copy}`;
  }

  private async heardBy(force = false): Promise<string> {
    const st = this.station.me();
    if (!st) return "no station";
    const s = this.settings.snapshot();
    const last = this.station.lastTx;
    return fetchHeardBy(this.db, this.state, {
      callsign: st.call,
      grid: st.grid,
      // Only an address the operator chose to give PSKReporter (it used to be the alert
      // or SMTP address, sent without saying so).
      contact: s["pskreporter.contact"].trim(),
      lastTxAt: last?.ok ? last.at : null,
      force,
    });
  }

  /** Ask PSKReporter now (still within its five-minute limit). */
  heardByNow(): Promise<string> {
    return this.heardBy(true);
  }

  /** The morning summary for each user: what their station did since the last one. */
  async digest(force = false, onlyUser?: string): Promise<string> {
    return this.eachUser((a) => (onlyUser && a.userId !== onlyUser ? Promise.resolve("skipped") : this.digestFor(a, force)));
  }

  private async digestFor(a: UserRun, force: boolean): Promise<string> {
    const s = a.s;
    const at = s["alerts.digestTime"];
    if (!at && !force) return "off";
    const now = new Date();
    const [hh, mm] = (at || "07:00").split(":").map(Number) as [number, number];
    const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm).getTime();
    const last = a.st.get("digestLastAt") ?? 0;
    if (!force && (now.getTime() < due || last >= due)) return "not due";
    const since = last || now.getTime() - 24 * 3_600_000;
    a.st.set("digestLastAt", now.getTime());
    const runs = recentRuns(this.db, since).filter((r) => r.stationId === a.stationId);
    const qsos = this.db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM qsos WHERE created_at >= ${since} AND station_id = ${a.stationId}`)?.n ?? 0;
    if (!runs.length && !qsos && !force) return "nothing happened";
    const newOnes = runs.flatMap((r) => JSON.parse(r.newOnes) as NewOne[]).filter((n) => ["dxcc", "zone", "continent", "park"].includes(n.kind));
    const faults = runs.flatMap((r) => JSON.parse(r.faults) as { reason: string }[]);
    const t = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const lines = [
      `${qsos} contact${qsos === 1 ? "" : "s"} in ${runs.length} automatic run${runs.length === 1 ? "" : "s"}.`,
      ...newOnes.slice(0, 8).map((n) => `• ${n.label} (${n.callsign})`),
      ...runs.slice(0, 5).map((r) => `${t(r.startedAt)}–${r.endedAt ? t(r.endedAt) : "now"} ${(JSON.parse(r.modes) as string[]).join("/")}: ${r.qsos} QSOs${r.stopReason ? `, stopped: ${r.stopReason}` : ""}`),
      ...(faults.length ? [`Faults: ${faults.map((f) => f.reason).slice(0, 3).join("; ")}`] : []),
    ];
    const title = newOnes.length ? `${qsos} QSOs, ${newOnes.length} new` : `${qsos} QSOs since the last summary`;
    const pushed = await this.pusher.send("digest", { title: `Zerobeat: ${title}`, body: lines.slice(0, 4).join("\n"), url: "/runs", tag: "digest" }, a.userId);
    if (s["alerts.email"] && mailConfigured(s)) {
      await sendMail(s, { to: s["alerts.email"], subject: `[Zerobeat] ${title}`, text: lines.join("\n") }).catch((e) => this.log.warn(`digest email: ${(e as Error).message}`));
    }
    return `sent: ${title} (${pushed} device${pushed === 1 ? "" : "s"})`;
  }

  private async refreshCty(): Promise<string> {
    const r = await httpRequest(CTY_CSV_URL, { timeoutMs: 60_000 });
    if (r.status !== 200) throw new Error(`cty.csv HTTP ${r.status}`);
    const parsed = parseCtyCsv(r.text);
    if (parsed.entities.size < 300 || parsed.problems.length > 5) throw new Error(`refusing a cty.csv with ${parsed.entities.size} entities and ${parsed.problems.length} problems`);
    writeFileSync(join(this.dataDir, "cty.csv"), r.text);
    reloadDxcc();
    return `${parsed.entities.size} entities, ${parsed.prefixes.size} prefixes`;
  }
}

function summarise(r: Record<string, string>): string {
  const parts = Object.entries(r).map(([k, v]) => `${k}: ${v}`);
  return parts.length ? parts.join("; ") : "no services enabled";
}
