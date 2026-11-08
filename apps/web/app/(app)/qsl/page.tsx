import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";

import { qslEmails, qsos } from "@zerobeat/core/db/schema";
import { mailConfigured } from "@zerobeat/core/mail";
import { sentInLastDay } from "@zerobeat/core/qsl/queue";

import { Card, Notice, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/server/auth";
import { db, settingsStore } from "@/lib/server/ctx";

import { QslQueue, CardDesigner } from "./view";
import { pageScope } from "@/lib/server/scope";

export const metadata = { title: "QSL" };

/** "k•••@example.com": viewers see that there is an address, not whose it is. */
function maskEmail(a: string): string {
  const at = a.indexOf("@");
  return at > 0 ? `${a[0]}•••${a.slice(at)}` : "•••";
}

export default async function QslPage() {
  const user = await requireUser();
  // The viewer's own emailed QSLs, settings and card.
  const scope = await pageScope(user);
  const s = settingsStore().snapshot(scope.userId);
  const rows = db()
    .select({ e: qslEmails, q: { callsign: qsos.callsign, band: qsos.band, mode: qsos.mode, submode: qsos.submode, startTime: qsos.startTime } })
    .from(qslEmails)
    .innerJoin(qsos, eq(qsos.id, qslEmails.qsoId))
    .where(and(eq(qsos.stationId, scope.stationId), inArray(qslEmails.status, ["queued", "approved", "failed", "sent"])))
    .orderBy(desc(qslEmails.createdAt))
    .limit(200)
    .all();
  const problems: string[] = [];
  if (!mailConfigured(s)) problems.push("SMTP is not configured");
  if (!s["app.publicUrl"]) problems.push("the Public URL is not set (needed for unsubscribe links)");
  if (!s["qrz.username"]) problems.push("no QRZ login, so new contacts have no email address to send to");

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="QSL"
        subtitle={`Emailed QSLs are ${s["qsl.mode"] === "off" ? "off" : s["qsl.mode"] === "queue" ? "queued for your approval" : "sent automatically"} · ${sentInLastDay(db(), Date.now(), scope.stationId)} sent in the last 24 h of ${s["qsl.maxPerDay"]} allowed`}
        actions={
          <Link href="/settings/qsl" className="text-sm text-accent-strong hover:underline">
            QSL settings
          </Link>
        }
      />
      {problems.length > 0 && s["qsl.mode"] !== "off" && <Notice tone="warn">Not ready: {problems.join("; ")}.</Notice>}
      <QslQueue
        rows={rows.map((r) => ({ id: r.e.id, status: r.e.status, to: user.role === "VIEWER" ? maskEmail(r.e.toAddress) : r.e.toAddress, subject: r.e.subject, body: r.e.body, error: r.e.error, sentAt: r.e.sentAt, createdAt: r.e.createdAt, call: r.q.callsign, band: r.q.band, mode: r.q.submode ?? r.q.mode, at: r.q.startTime }))}
        canOperate={user.role !== "VIEWER" && !scope.readOnly}
      />
      <Card title="Card">
        <CardDesigner admin={user.role !== "VIEWER" && !scope.readOnly} />
      </Card>
    </div>
  );
}
