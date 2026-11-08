/**
 * Emailed QSLs: queue, approve, send.
 *
 *   queued ──approve──► approved ──send──► sent
 *     │                     └────────────► failed (error kept; can be re-approved)
 *     └──cancel──► cancelled
 *
 * Auto mode "send" approves only rows it queued itself. Opt-outs (by callsign or address)
 * are checked when queueing and again when sending. Unsubscribe links are HMAC-signed
 * with a key derived from ZEROBEAT_SECRET_KEY, never the raw key.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { qslEmails, qslOptOuts, qsos, stations, type Qso, type Station } from "../db/schema.ts";
import { displayMode } from "../ham/modes.ts";
import { sendMail } from "../mail.ts";
import type { SettingsSnapshot } from "../settings/registry.ts";
import { newId } from "../util/id.ts";
import { utcDate, utcTime } from "../util/time.ts";
import { renderCard } from "./card.ts";

export function renderTemplate(tpl: string, q: Qso, station: Pick<Station, "callsign" | "grid">, operator: string): string {
  const vars: Record<string, string> = {
    call: q.callsign,
    name: q.name?.split(/\s+/)[0] ?? q.callsign,
    mycall: station.callsign,
    date: utcDate(q.startTime),
    time: utcTime(q.startTime, false),
    band: q.band.toLowerCase(),
    mode: displayMode(q.mode, q.submode),
    rst_sent: q.rstSent ?? "",
    rst_rcvd: q.rstRcvd ?? "",
    mygrid: q.myGrid ?? station.grid,
    operator: operator || station.callsign,
  };
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

function hmacKey(): Buffer {
  const raw = process.env.ZEROBEAT_SECRET_KEY ?? "";
  const ikm = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  return Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from("zerobeat:qsl-unsubscribe"), 32));
}

export function unsubscribeToken(callsign: string): string {
  return createHmac("sha256", hmacKey()).update(callsign.toUpperCase()).digest("base64url").slice(0, 32);
}

export function verifyUnsubscribe(callsign: string, token: string): boolean {
  const want = Buffer.from(unsubscribeToken(callsign));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function isOptedOut(db: Db, callsign: string, email?: string | null): boolean {
  const targets = [callsign.toUpperCase(), ...(email ? [email.toLowerCase()] : [])];
  return !!db.select().from(qslOptOuts).where(inArray(qslOptOuts.target, targets)).get();
}

export function optOut(db: Db, target: string, source: "unsubscribe" | "bounce" | "manual", note?: string): void {
  const t = target.includes("@") ? target.toLowerCase() : target.toUpperCase();
  db.insert(qslOptOuts).values({ target: t, source, note: note ?? null }).onConflictDoNothing().run();
  db.update(qslEmails)
    .set({ status: "cancelled", error: "recipient opted out", updatedAt: Date.now() })
    .where(and(inArray(qslEmails.status, ["queued", "approved"]), sql`(${qslEmails.qsoId} IN (SELECT id FROM qsos WHERE callsign = ${t}) OR lower(${qslEmails.toAddress}) = ${t.toLowerCase()})`))
    .run();
}

export type EnqueueResult = { ok: true; id: string } | { ok: false; reason: string };

export function enqueueQsl(db: Db, s: SettingsSnapshot, qsoId: string, email: string, opts: { force?: boolean } = {}): EnqueueResult {
  const q = db.select().from(qsos).where(eq(qsos.id, qsoId)).get();
  if (!q) return { ok: false, reason: "no such contact" };
  if (!s["app.publicUrl"]) return { ok: false, reason: "set the Public URL first (needed for the unsubscribe link)" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, reason: `not an email address: ${email}` };
  if (isOptedOut(db, q.callsign, email)) return { ok: false, reason: `${q.callsign} has opted out of emailed QSLs` };
  const existing = db.select().from(qslEmails).where(eq(qslEmails.qsoId, qsoId)).orderBy(desc(qslEmails.createdAt)).get();
  if (existing && !opts.force && existing.status !== "cancelled" && existing.status !== "failed") {
    return { ok: false, reason: existing.status === "sent" ? "already sent" : "already queued" };
  }
  const station = db.select().from(stations).where(eq(stations.id, q.stationId)).get()!;
  const id = newId();
  db.insert(qslEmails)
    .values({
      id,
      qsoId,
      toAddress: email,
      subject: renderTemplate(s["qsl.subject"], q, station, s["qsl.operatorName"]),
      body: renderTemplate(s["qsl.body"], q, station, s["qsl.operatorName"]),
      status: "queued",
    })
    .run();
  return { ok: true, id };
}

export function approveQsls(db: Db, ids: string[], userId: string | null): number {
  if (!ids.length) return 0;
  return db
    .update(qslEmails)
    .set({ status: "approved", approvedById: userId, error: null, updatedAt: Date.now() })
    .where(and(inArray(qslEmails.id, ids), inArray(qslEmails.status, ["queued", "failed"])))
    .run().changes;
}

export function cancelQsls(db: Db, ids: string[]): number {
  if (!ids.length) return 0;
  return db
    .update(qslEmails)
    .set({ status: "cancelled", updatedAt: Date.now() })
    .where(and(inArray(qslEmails.id, ids), inArray(qslEmails.status, ["queued", "approved", "failed"])))
    .run().changes;
}

/** Emailed QSLs sent in the last day, for one station's budget (or all). */
export function sentInLastDay(db: Db, now = Date.now(), stationId?: string): number {
  const mine = stationId ? sql` AND qso_id IN (SELECT id FROM qsos WHERE station_id = ${stationId})` : sql``;
  return db.get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM qsl_emails WHERE status = 'sent' AND sent_at >= ${now - 86_400_000}${mine}`)?.c ?? 0;
}

/** Send approved rows, oldest first, within the daily budget. */
export async function sendApproved(
  db: Db,
  s: SettingsSnapshot,
  opts: { cardImagePath: string; limit?: number; log?: (m: string) => void; stationId?: string },
): Promise<{ sent: number; failed: number }> {
  const budget = Math.max(0, s["qsl.maxPerDay"] - sentInLastDay(db, Date.now(), opts.stationId));
  const rows = db
    .select()
    .from(qslEmails)
    .where(and(eq(qslEmails.status, "approved"), opts.stationId ? sql`${qslEmails.qsoId} IN (SELECT id FROM qsos WHERE station_id = ${opts.stationId})` : undefined))
    .orderBy(asc(qslEmails.createdAt))
    .limit(Math.min(budget, opts.limit ?? 20))
    .all();
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const q = db.select().from(qsos).where(eq(qsos.id, row.qsoId)).get();
    if (!q || isOptedOut(db, q.callsign, row.toAddress)) {
      cancelQsls(db, [row.id]);
      continue;
    }
    const station = db.select().from(stations).where(eq(stations.id, q.stationId)).get()!;
    const unsub = `${s["app.publicUrl"]}/qsl/unsubscribe?call=${encodeURIComponent(q.callsign)}&t=${unsubscribeToken(q.callsign)}`;
    const text = `${row.body}\n\n--\nNo more emailed QSLs from ${station.callsign}: ${unsub}\n`;
    const attachments = [];
    let html: string | undefined;
    if (s["qsl.card.enabled"]) {
      try {
        const card = await renderCard(q, station, { imagePath: opts.cardImagePath, settings: s });
        attachments.push({ filename: `QSL-${station.callsign}-${q.callsign}.jpg`.replace(/\//g, "-"), content: card, contentType: "image/jpeg", cid: "qslcard" });
        const escHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        html = `<div style="font-family:sans-serif">${escHtml(row.body).replace(/\n/g, "<br>")}<p><img src="cid:qslcard" alt="QSL card" style="max-width:100%"></p><p style="color:#888;font-size:12px"><a href="${unsub}">No more emailed QSLs from ${station.callsign}</a></p></div>`;
      } catch (e) {
        opts.log?.(`card render failed for ${q.callsign}: ${(e as Error).message}`);
      }
    }
    try {
      await sendMail(s, {
        to: row.toAddress,
        subject: row.subject,
        text,
        html,
        attachments,
        headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      });
      const now = Date.now();
      db.update(qslEmails).set({ status: "sent", sentAt: now, error: null, updatedAt: now }).where(eq(qslEmails.id, row.id)).run();
      sent++;
    } catch (e) {
      db.update(qslEmails).set({ status: "failed", error: (e as Error).message.slice(0, 500), updatedAt: Date.now() }).where(eq(qslEmails.id, row.id)).run();
      failed++;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { sent, failed };
}

/** Contacts old enough to queue, not yet emailed, newest first. */
export function qslCandidates(db: Db, s: SettingsSnapshot, now = Date.now(), limit = 25, stationId?: string): Qso[] {
  const cutoff = now - s["qsl.minAgeMinutes"] * 60_000;
  return db
    .select()
    .from(qsos)
    .where(
      sql`${qsos.startTime} <= ${cutoff} AND ${qsos.startTime} >= ${now - 7 * 86_400_000}${stationId ? sql` AND ${qsos.stationId} = ${stationId}` : sql``}
          AND ${qsos.qslSent} IN ('NONE', 'REQUESTED')
          AND NOT EXISTS (SELECT 1 FROM qsl_emails e WHERE e.qso_id = ${qsos.id})`,
    )
    .orderBy(desc(qsos.startTime))
    .limit(limit)
    .all();
}
