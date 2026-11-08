/** Outgoing email. One transport built from settings; callers never touch nodemailer. */
import nodemailer from "nodemailer";

import type { SettingsSnapshot } from "./settings/registry.ts";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType: string; cid?: string }[];
  headers?: Record<string, string>;
}

export function mailConfigured(s: SettingsSnapshot): boolean {
  return !!(s["smtp.host"] && s["smtp.from"]);
}

export async function sendMail(s: SettingsSnapshot, msg: MailMessage): Promise<{ messageId: string }> {
  if (!mailConfigured(s)) throw new Error("Email is not configured (Settings → Email & alerts)");
  const security = s["smtp.security"];
  const transport = nodemailer.createTransport({
    host: s["smtp.host"],
    port: s["smtp.port"],
    secure: security === "tls",
    requireTLS: security === "starttls",
    ignoreTLS: security === "none",
    auth: s["smtp.user"] ? { user: s["smtp.user"], pass: s["smtp.password"] } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    const info = await transport.sendMail({
      from: s["smtp.from"],
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      headers: msg.headers,
      attachments: msg.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
        cid: a.cid,
        contentDisposition: a.cid ? "inline" : "attachment",
      })),
    });
    return { messageId: info.messageId };
  } finally {
    transport.close();
  }
}

/** Station alert, with a per-key cooldown so a flapping fault sends one message, not hundreds. */
export class Alerter {
  private last = new Map<string, number>();
  constructor(
    private readonly settings: (userId?: string | null) => SettingsSnapshot,
    private readonly cooldownMs = 6 * 3_600_000,
    private readonly log: (m: string) => void = () => {},
  ) {}

  /** To `userId`'s alert address (their accounts' trouble), or by default whoever is operating. */
  async raise(key: string, subject: string, body: string, now = Date.now(), userId?: string): Promise<void> {
    const s = this.settings(userId);
    const to = s["alerts.email"];
    if (!to || !mailConfigured(s)) return;
    const k = userId ? `${userId}:${key}` : key;
    const prev = this.last.get(k);
    if (prev && now - prev < this.cooldownMs) return;
    this.last.set(k, now);
    try {
      await sendMail(s, { to, subject: `[Zerobeat] ${subject}`, text: body });
    } catch (e) {
      this.log(`alert "${subject}" could not be sent: ${(e as Error).message}`);
    }
  }

  clear(key: string): void {
    this.last.delete(key);
  }
}
