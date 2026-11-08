/**
 * The upload queue. One row per (contact, service) in `upload_state`.
 *
 *  - sent/duplicate → done.
 *  - rejected       → failed, with the reason kept on the row (retry from the UI).
 *  - retry          → stays pending, next attempt after exponential backoff (2^n min, max 24 h).
 *  - auth           → the whole service pauses for an hour, persisted, and an alert goes out
 *                     once. Rows are untouched, so nothing is lost while credentials are fixed.
 *
 * A bad record cannot block the ones behind it, and a misconfigured service cannot flood
 * the log (the old install wrote one Club Log line a minute for two months).
 *
 * Each user's contacts go to their own accounts: a run goes through every user (accounts)
 * with their settings, their LoTW certificate and their pauses.
 */
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { qsoToAdif } from "@zerobeat/core/adif/adif";
import { SecretBox } from "@zerobeat/core/crypto/secrets";
import type { Db } from "@zerobeat/core/db/client";
import { qsoSigRefs, qsos, stations, uploadState, type Qso, type UploadService, operators } from "@zerobeat/core/db/schema";
import { getDxcc } from "@zerobeat/core/dxcc/cty";
import { clublogUpload, n3fjpSend } from "@zerobeat/core/integrations/clublog-n3fjp";
import { eqslUpload } from "@zerobeat/core/integrations/eqsl";
import type { UploadOutcome } from "@zerobeat/core/integrations/http";
import { buildTq8, lotwUpload, type LotwCert } from "@zerobeat/core/integrations/lotw";
import { qrzInsert } from "@zerobeat/core/integrations/qrz";
import { accounts } from "@zerobeat/core/log/owners";
import { wrlUpload, type WrlContactSource } from "@zerobeat/core/integrations/wrl";
import type { Alerter } from "@zerobeat/core/mail";
import type { SettingsSnapshot } from "@zerobeat/core/settings/registry";
import type { SettingsStore } from "@zerobeat/core/settings/store";
import type { EngineState } from "@zerobeat/core/state/engine-state";
import type { Logger } from "@zerobeat/core/util/log";

// WRL allows 60 writes a minute; 25 a run (plus a search per retried row) stays well inside it.
const BATCH: Record<UploadService, number> = { qrz: 25, eqsl: 25, clublog: 25, wrl: 25, n3fjp: 100, lotw: 300 };
const PAUSE_MS = 60 * 60_000;

export function backoffMs(attempts: number): number {
  return Math.min(24 * 3_600_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

export function loadLotwCert(state: EngineState): LotwCert | null {
  const c = state.get("lotwCert");
  if (!c) return null;
  const key = SecretBox.fromEnv().decrypt(c.keyEnc);
  if (!key) throw new Error("the stored LoTW key cannot be decrypted (ZEROBEAT_SECRET_KEY changed); upload the certificate again");
  return { ...c.info, certPem: c.certPem, keyPem: key };
}

export function serviceReady(service: UploadService, s: SettingsSnapshot, state: EngineState): string | null {
  switch (service) {
    case "qrz":
      return s["qrz.logbookKey"] ? null : "no QRZ Logbook API key";
    case "eqsl":
      return s["eqsl.username"] && s["eqsl.password"] ? null : "no eQSL username/password";
    case "clublog":
      if (!s["clublog.email"] || !s["clublog.password"]) return "no Club Log email/password";
      return s["clublog.apiKey"] ? null : "no Club Log API key (Club Log refuses uploads without one)";
    case "wrl":
      return s["wrl.apiKey"] ? null : "no World Radio League API key";
    case "n3fjp":
      return s["n3fjp.host"] ? null : "no N3FJP host";
    case "lotw":
      return state.get("lotwCert") ? null : "no LoTW certificate uploaded";
  }
}

/** One user's run: their station, settings and state. */
interface Account {
  userId: string;
  stationId: string;
  callsign: string;
  grid: string;
  s: SettingsSnapshot;
  st: EngineState;
}

export class UploadRunner {
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsStore,
    private readonly state: EngineState,
    private readonly alerter: Alerter,
    private readonly log: Logger,
  ) {}

  paused(service: UploadService, userId: string, now = Date.now()): { until: number; error: string } | null {
    const p = this.state.forUser(userId).get("servicePause")?.[service];
    return p && p.until > now ? p : null;
  }

  resume(service: UploadService, userId: string): void {
    const st = this.state.forUser(userId);
    const all = { ...(st.get("servicePause") ?? {}) };
    delete all[service];
    st.set("servicePause", all);
  }

  private pause(a: Account, service: UploadService, error: string, now: number): void {
    const all = { ...(a.st.get("servicePause") ?? {}), [service]: { until: now + PAUSE_MS, error } };
    a.st.set("servicePause", all);
    this.log.once(`upload:${a.userId}:${service}`, "warn", `${a.callsign} ${service} paused for an hour: ${error}`);
    void this.alerter.raise(
      `upload-${service}`,
      `${service} uploads paused`,
      `Zerobeat paused ${service} uploads for ${a.callsign} because the service refused the credentials or configuration:\n\n${error}\n\nFix it under My settings → Logbook services, then press Resume on the Services page.`,
      now,
      a.userId,
    );
  }

  /** Every user's uploads, or one user's. Results by "CALL service". */
  async runAll(now = Date.now(), onlyUser?: string): Promise<Record<string, string>> {
    if (this.running) return { all: "already running" };
    this.running = true;
    const out: Record<string, string> = {};
    try {
      for (const acc of accounts(this.db)) {
        if (onlyUser && acc.userId !== onlyUser) continue;
        const a: Account = { ...acc, s: this.settings.snapshot(acc.userId), st: this.state.forUser(acc.userId) };
        for (const service of ["qrz", "lotw", "eqsl", "clublog", "wrl", "n3fjp"] as UploadService[]) {
          if (!a.s[`uploads.${service}` as const]) continue;
          const key = `${a.callsign} ${service}`;
          const notReady = serviceReady(service, a.s, a.st);
          if (notReady) {
            out[key] = notReady;
            continue;
          }
          if (this.paused(service, a.userId, now)) {
            out[key] = "paused";
            continue;
          }
          try {
            out[key] = await this.runService(a, service, now);
            this.log.clear(`upload:${a.userId}:${service}`);
          } catch (e) {
            out[key] = (e as Error).message;
            this.log.once(`upload:${a.userId}:${service}`, "warn", `${key} upload run failed: ${(e as Error).message}`);
          }
        }
      }
    } finally {
      this.running = false;
    }
    return out;
  }

  private due(service: UploadService, stationId: string, now: number) {
    return this.db
      .select({ q: qsos })
      .from(uploadState)
      .innerJoin(qsos, eq(qsos.id, uploadState.qsoId))
      .where(and(eq(uploadState.service, service), eq(uploadState.status, "pending"), eq(qsos.stationId, stationId), or(isNull(uploadState.nextAttemptAt), lte(uploadState.nextAttemptAt, now))))
      .orderBy(asc(qsos.startTime))
      .limit(BATCH[service])
      .all()
      .map((r) => r.q);
  }

  private mark(qsoIds: string[], service: UploadService, o: UploadOutcome, now: number): void {
    if (!qsoIds.length) return;
    const where = and(eq(uploadState.service, service), inArray(uploadState.qsoId, qsoIds));
    if (o.status === "sent" || o.status === "duplicate") {
      this.db
        .update(uploadState)
        .set({ status: "sent", sentAt: now, lastError: o.status === "duplicate" ? "already there (duplicate)" : null, remoteId: o.remoteId ?? null, updatedAt: now, attempts: sql`${uploadState.attempts} + 1` })
        .where(where)
        .run();
    } else if (o.status === "rejected") {
      this.db.update(uploadState).set({ status: "failed", lastError: o.detail.slice(0, 500), updatedAt: now, attempts: sql`${uploadState.attempts} + 1` }).where(where).run();
    } else if (o.status === "retry") {
      for (const id of qsoIds) {
        const row = this.db.select().from(uploadState).where(and(eq(uploadState.service, service), eq(uploadState.qsoId, id))).get();
        const attempts = (row?.attempts ?? 0) + 1;
        this.db
          .update(uploadState)
          .set({ attempts, nextAttemptAt: now + backoffMs(attempts), lastError: o.detail.slice(0, 500), updatedAt: now })
          .where(and(eq(uploadState.service, service), eq(uploadState.qsoId, id)))
          .run();
      }
    }
  }

  private adifFor(q: Qso): string {
    const st = this.db.select().from(stations).where(eq(stations.id, q.stationId)).get()!;
    const refs = this.db.select().from(qsoSigRefs).where(eq(qsoSigRefs.qsoId, q.id)).all();
    const op = q.operatorId ? this.db.select({ callsign: operators.callsign }).from(operators).where(eq(operators.id, q.operatorId)).get() : undefined;
    return qsoToAdif(q, st, refs, { operator: op?.callsign ?? null });
  }

  async runService(a: Account, service: UploadService, now: number): Promise<string> {
    const s = a.s;
    const rows = this.due(service, a.stationId, now);
    if (!rows.length) return "nothing to send";
    let sent = 0;
    let failed = 0;
    if (service === "lotw") return this.runLotw(a, rows, now);
    if (service === "n3fjp") {
      const r = await n3fjpSend(s["n3fjp.host"], s["n3fjp.port"], rows.map((q) => this.adifFor(q)));
      const done = rows.slice(0, r.sent).map((q) => q.id);
      this.mark(done, "n3fjp", { status: "sent" }, now);
      if (r.error) this.mark(rows.slice(r.sent).map((q) => q.id), "n3fjp", { status: "retry", detail: r.error }, now);
      return r.error ? `sent ${r.sent}, then: ${r.error}` : `sent ${r.sent}`;
    }
    for (const q of rows) {
      const adif = this.adifFor(q);
      let o: UploadOutcome;
      if (service === "wrl") o = await wrlUpload(s["wrl.apiKey"], this.wrlSource(q), { logbookId: s["wrl.logbookId"] || null, checkFirst: this.attempts(q.id, "wrl") > 0 });
      else if (service === "qrz") o = await qrzInsert(s["qrz.logbookKey"], adif);
      else if (service === "eqsl") o = await eqslUpload({ username: s["eqsl.username"], password: s["eqsl.password"], qthNickname: s["eqsl.qthNickname"] }, adif);
      else o = await clublogUpload({ email: s["clublog.email"], password: s["clublog.password"], callsign: s["clublog.callsign"] || this.stationCall(q), apiKey: s["clublog.apiKey"] }, adif);
      if (o.status === "auth") {
        this.pause(a, service, o.detail, now);
        return `paused: ${o.detail}`;
      }
      this.mark([q.id], service, o, now);
      if (o.status === "sent" || o.status === "duplicate") sent++;
      else failed++;
      if (o.status === "retry") break; // the service is struggling; stop this run
    }
    return `sent ${sent}${failed ? `, ${failed} not sent` : ""}`;
  }

  private attempts(qsoId: string, service: UploadService): number {
    return this.db.select({ a: uploadState.attempts }).from(uploadState).where(and(eq(uploadState.service, service), eq(uploadState.qsoId, qsoId))).get()?.a ?? 0;
  }

  private wrlSource(q: Qso): WrlContactSource {
    const st = this.db.select().from(stations).where(eq(stations.id, q.stationId)).get()!;
    const refs = this.db.select().from(qsoSigRefs).where(eq(qsoSigRefs.qsoId, q.id)).all();
    return {
      callsign: q.callsign,
      startTime: q.startTime,
      freqHz: q.freqHz,
      band: q.band,
      mode: q.mode,
      submode: q.submode,
      rstSent: q.rstSent,
      rstRcvd: q.rstRcvd,
      txPowerW: q.txPowerW,
      notes: q.notes,
      name: q.name,
      qth: q.qth,
      state: q.state,
      grid: q.grid,
      myGrid: q.myGrid ?? st.grid,
      mySig: q.mySig,
      mySigInfo: q.mySigInfo,
      stationCallsign: st.callsign,
      theirRefs: refs.map((r) => ({ sig: r.sig, ref: r.ref })),
    };
  }

  private stationCall(q: Qso): string {
    return this.db.select().from(stations).where(eq(stations.id, q.stationId)).get()?.callsign ?? "";
  }

  private async runLotw(a: Account, rows: Qso[], now: number): Promise<string> {
    const s = a.s;
    const cert = loadLotwCert(a.st);
    if (!cert) return "no certificate";
    if (cert.validTo < now) {
      this.pause(a, "lotw", `the LoTW certificate for ${cert.callsign} expired on ${new Date(cert.validTo).toISOString().slice(0, 10)}`, now);
      return "certificate expired";
    }
    // Sign only contacts made under the certificate's callsign.
    const st = this.db.select().from(stations).all();
    const stationById = new Map(st.map((x) => [x.id, x]));
    const mine = rows.filter((q) => stationById.get(q.stationId)?.callsign.toUpperCase() === cert.callsign);
    const other = rows.filter((q) => !mine.includes(q));
    if (other.length) this.mark(other.map((q) => q.id), "lotw", { status: "rejected", detail: `station callsign is not ${cert.callsign} (the certificate's)` }, now);
    if (!mine.length) return "no contacts for the certificate's callsign";
    // One batch is one station location. A portable station (or a contact with its own
    // MY_GRIDSQUARE) is signed with its own grid, and the state, county and zones in
    // Settings, which describe the home station, are left off rather than put on it.
    // Contacts at other locations wait for the next run (every two minutes).
    const where = (q: Qso) => {
      const station = stationById.get(q.stationId)!;
      const grid = (q.myGrid || station.grid || "").toUpperCase();
      return { station, grid, key: `${station.id}|${grid.slice(0, 6)}` };
    };
    const first = where(mine[0]!);
    const batch = mine.filter((q) => where(q).key === first.key);
    // The state, county and zones in Settings describe the user's own station at its grid.
    const atHome = first.station.id === a.stationId && first.grid.slice(0, 6) === a.grid.toUpperCase().slice(0, 6);
    const tq8 = buildTq8(
      cert,
      {
        callsign: cert.callsign,
        dxcc: cert.dxcc ?? getDxcc().resolve(cert.callsign)?.adif ?? 0,
        grid: first.grid,
        state: atHome ? s["lotw.state"] || null : null,
        county: atHome ? s["lotw.county"] || null : null,
        cqZone: atHome ? s["lotw.cqZone"] || null : null,
        ituZone: atHome ? s["lotw.ituZone"] || null : null,
      },
      batch.map((q) => ({ id: q.id, callsign: q.callsign, band: q.band, mode: q.mode, submode: q.submode, freqHz: q.freqHz, propMode: q.propMode, satName: q.satName, startTime: q.startTime })),
    );
    for (const e of tq8.excluded) {
      this.db.update(uploadState).set({ status: "skipped", lastError: e.reason, updatedAt: now }).where(and(eq(uploadState.service, "lotw"), eq(uploadState.qsoId, e.id))).run();
    }
    if (!tq8.included.length) return `${tq8.excluded.length} outside the certificate's dates`;
    const o = await lotwUpload(tq8.gz, cert.callsign);
    if (o.status === "auth") {
      this.pause(a, "lotw", o.detail, now);
      return `paused: ${o.detail}`;
    }
    this.mark(tq8.included, "lotw", o, now);
    return o.status === "sent" ? `sent ${tq8.included.length}` : `${o.status}: ${"detail" in o ? o.detail : ""}`;
  }
}
