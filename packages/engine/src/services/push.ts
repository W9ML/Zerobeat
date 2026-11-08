/**
 * Web Push to the operator's phone or desktop, no third-party service. VAPID keys are
 * generated on first use; the private key is stored encrypted. Subscriptions that the
 * push service reports gone (404/410) are deleted; others are retried next time.
 */
import webpush from "web-push";
import { eq, sql } from "drizzle-orm";

import { SecretBox } from "@zerobeat/core/crypto/secrets";
import type { Db } from "@zerobeat/core/db/client";
import { pushSubscriptions } from "@zerobeat/core/db/schema";
import type { EngineState } from "@zerobeat/core/state/engine-state";

export type PushCategory = "needed" | "faults" | "digest";

export interface PushMessage {
  title: string;
  body: string;
  /** Path to open when tapped. */
  url?: string;
  /** Notifications with the same tag replace each other. */
  tag?: string;
}

export function vapidKeys(state: EngineState): { publicKey: string; privateKey: string } {
  const box = SecretBox.fromEnv();
  const v = state.get("vapid");
  if (v) {
    const priv = box.decrypt(v.privateKeyEnc);
    if (priv) return { publicKey: v.publicKey, privateKey: priv };
  }
  const k = webpush.generateVAPIDKeys();
  state.set("vapid", { publicKey: k.publicKey, privateKeyEnc: box.encrypt(k.privateKey) });
  return k;
}

export class Pusher {
  private keys: { publicKey: string; privateKey: string } | null = null;

  constructor(
    private readonly db: Db,
    private readonly state: EngineState,
    private readonly subject: () => string,
    private readonly log: (m: string) => void,
  ) {}

  publicKey(): string {
    this.keys ??= vapidKeys(this.state);
    return this.keys.publicKey;
  }

  async send(category: PushCategory, msg: PushMessage, onlyUser?: string): Promise<number> {
    this.keys ??= vapidKeys(this.state);
    const subs = this.db
      .select()
      .from(pushSubscriptions)
      .all()
      .filter((s) => (onlyUser ? s.userId === onlyUser : (JSON.parse(s.categories) as string[]).includes(category)));
    let ok = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg), {
          TTL: category === "needed" ? 300 : 12 * 3600,
          urgency: category === "faults" ? "high" : "normal",
          vapidDetails: { subject: this.subject(), publicKey: this.keys.publicKey, privateKey: this.keys.privateKey },
          timeout: 10_000,
        });
        ok++;
        this.db.update(pushSubscriptions).set({ lastOkAt: Date.now(), failures: 0 }).where(eq(pushSubscriptions.id, s.id)).run();
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) {
          this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id)).run();
        } else {
          this.db.update(pushSubscriptions).set({ failures: sql`${pushSubscriptions.failures} + 1` }).where(eq(pushSubscriptions.id, s.id)).run();
          this.log(`push to ${s.label ?? s.id} failed: ${(e as Error).message}`);
        }
      }
    }
    return ok;
  }
}
