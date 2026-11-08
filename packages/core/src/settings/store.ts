/**
 * Settings read/write.
 *
 * Reads return a full typed snapshot (defaults filled in), cached per process and
 * invalidated by a cheap check of the newest `updated_at`. Two processes share the same
 * SQLite file, so a write in the web tier is seen by the engine within one check; the
 * web tier also pokes the engine's /reload so the change applies at once.
 *
 * Secrets are encrypted with AES-256-GCM and never returned to the browser; the UI gets
 * `{ set: true, hint: "••••1234" }` instead.
 *
 * Personal settings (registry isPersonal: service accounts, QSL email, hunting rules…) are
 * each user's own, in user_settings; a snapshot for a user is the shack's settings with
 * that user's personal ones over them. The engine reads as whoever has the radio (actAs).
 */
import { sql } from "drizzle-orm";

import { SecretBox, maskSecret } from "../crypto/secrets.ts";
import type { Db } from "../db/client.ts";
import { settings, userSettings } from "../db/schema.ts";
import {
  SETTINGS,
  SETTINGS_BY_KEY,
  isPersonal,
  settingDefaults,
  type SettingDef,
  type SettingKey,
  type SettingsSnapshot,
} from "./registry.ts";

export class SettingsError extends Error {
  constructor(
    message: string,
    readonly issues: Record<string, string> = {},
  ) {
    super(message);
    this.name = "SettingsError";
  }
}

export interface SettingView {
  key: string;
  value: unknown;
  /** Secrets only. */
  set?: boolean;
  hint?: string;
  /** True when the stored value could not be decrypted (wrong ZEROBEAT_SECRET_KEY). */
  unreadable?: boolean;
}

function decodeStored(def: SettingDef<any>, raw: string): unknown {
  if (def.kind === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : def.default;
  }
  if (def.kind === "boolean") return raw === "true" || raw === "1";
  return raw;
}

function encodeValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export class SettingsStore {
  private cache = new Map<string, { stamp: string; snap: SettingsSnapshot; unreadable: Set<string> }>();
  /** Whose personal settings snapshot() reads when not told: the engine's operator. */
  private acting: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox | null,
  ) {}

  /** The newest updated_at plus row count of the shack's and this user's rows. */
  private stamp(userId: string | null): string {
    const row = this.db.get<{ m: number | null; c: number }>(sql`SELECT MAX(updated_at) AS m, COUNT(*) AS c FROM settings`);
    const mine = userId
      ? this.db.get<{ m: number | null; c: number }>(sql`SELECT MAX(updated_at) AS m, COUNT(*) AS c FROM user_settings WHERE user_id = ${userId}`)
      : null;
    return `${row?.m ?? 0}:${row?.c ?? 0}:${mine?.m ?? 0}:${mine?.c ?? 0}`;
  }

  invalidate(): void {
    this.cache.clear();
  }

  /** Read as this user from now on (the engine, when the radio changes hands). */
  actAs(userId: string | null): void {
    this.acting = userId;
  }

  get actingUser(): string | null {
    return this.acting;
  }

  private decode(def: SettingDef<any>, row: { key: string; value: string; encrypted: boolean }, snap: Record<string, unknown>, unreadable: Set<string>): void {
    if (row.encrypted) {
      const plain = this.box?.decrypt(row.value) ?? null;
      if (plain === null) unreadable.add(row.key);
      else snap[row.key] = plain;
    } else {
      snap[row.key] = decodeStored(def, row.value);
    }
  }

  /**
   * Full typed snapshot: the shack's settings, and the personal ones of `userId` (by
   * default whoever the engine acts as; null: defaults). Secrets decrypted, server-side only.
   */
  snapshot(userId: string | null = this.acting): SettingsSnapshot {
    const stamp = this.stamp(userId);
    const hit = this.cache.get(userId ?? "");
    if (hit && hit.stamp === stamp) return hit.snap;
    const snap = settingDefaults() as Record<string, unknown>;
    const unreadable = new Set<string>();
    const own = userId ? this.db.select().from(userSettings).where(sql`${userSettings.userId} = ${userId}`).all() : [];
    const ownKeys = new Set(own.map((r) => r.key));
    for (const row of this.db.select().from(settings).all()) {
      const def = SETTINGS_BY_KEY.get(row.key);
      // A personal setting still in the shack table (before the move to user_settings)
      // counts only until the user has their own.
      if (!def || (isPersonal(row.key) && ownKeys.has(row.key))) continue;
      this.decode(def, row, snap, unreadable);
    }
    for (const row of own) {
      const def = SETTINGS_BY_KEY.get(row.key);
      if (def && isPersonal(row.key)) this.decode(def, row, snap, unreadable);
    }
    const typed = snap as SettingsSnapshot;
    this.cache.set(userId ?? "", { stamp, snap: typed, unreadable });
    return typed;
  }

  get<K extends SettingKey>(key: K): SettingsSnapshot[K] {
    return (this.snapshot() as Record<string, unknown>)[key] as SettingsSnapshot[K];
  }

  /** What the settings page may see for a user: secrets masked. */
  describe(userId: string | null = this.acting): SettingView[] {
    const snap = this.snapshot(userId) as Record<string, unknown>;
    const unreadable = this.cache.get(userId ?? "")?.unreadable ?? new Set<string>();
    return (SETTINGS as readonly SettingDef<any>[]).map((def) => {
      if (def.kind !== "secret") return { key: def.key, value: snap[def.key] };
      const v = String(snap[def.key] ?? "");
      return {
        key: def.key,
        value: "",
        set: v.length > 0 || unreadable.has(def.key),
        hint: v ? maskSecret(v) : undefined,
        unreadable: unreadable.has(def.key) || undefined,
      };
    });
  }

  /**
   * Validate and write a partial update. For secrets, `undefined`/absent means keep and
   * `""` means clear. Unknown keys are rejected rather than silently stored. Personal
   * settings go to `userId`'s own (and need one); the shack's are recorded as changed by them.
   */
  write(patch: Record<string, unknown>, userId: string | null): SettingKey[] {
    const issues: Record<string, string> = {};
    const rows: { key: string; value: string; encrypted: boolean; clear: boolean }[] = [];
    for (const [key, raw] of Object.entries(patch)) {
      const def = SETTINGS_BY_KEY.get(key);
      if (!def) {
        issues[key] = "Unknown setting";
        continue;
      }
      if (raw === undefined) continue;
      let candidate = raw;
      if (def.kind === "number" && typeof raw === "string") candidate = raw.trim() === "" ? NaN : Number(raw);
      if (def.kind === "boolean" && typeof raw === "string") candidate = raw === "true";
      const parsed = def.schema.safeParse(candidate);
      if (!parsed.success) {
        issues[key] = parsed.error.issues[0]?.message ?? "Invalid value";
        continue;
      }
      const value = parsed.data;
      if (isPersonal(key) && !userId) {
        issues[key] = "A personal setting needs the user it belongs to";
        continue;
      }
      if (def.kind === "secret") {
        const s = String(value);
        if (s === "") {
          rows.push({ key, value: "", encrypted: false, clear: true });
          continue;
        }
        if (!this.box) {
          issues[key] = "ZEROBEAT_SECRET_KEY is not configured, so secrets cannot be stored";
          continue;
        }
        rows.push({ key, value: this.box.encrypt(s), encrypted: true, clear: false });
      } else {
        rows.push({ key, value: encodeValue(value), encrypted: false, clear: false });
      }
    }
    if (Object.keys(issues).length) throw new SettingsError("Some settings are not valid", issues);

    const now = Date.now();
    this.db.transaction((tx) => {
      for (const r of rows) {
        if (isPersonal(r.key)) {
          const uid = userId!;
          if (r.clear) {
            tx.delete(userSettings).where(sql`${userSettings.userId} = ${uid} AND ${userSettings.key} = ${r.key}`).run();
            // Cleared means cleared: not the shack's leftover value from before the split.
            tx.insert(userSettings).values({ userId: uid, key: r.key, value: "", encrypted: false, updatedAt: now }).run();
            continue;
          }
          tx.insert(userSettings)
            .values({ userId: uid, key: r.key, value: r.value, encrypted: r.encrypted, updatedAt: now })
            .onConflictDoUpdate({ target: [userSettings.userId, userSettings.key], set: { value: r.value, encrypted: r.encrypted, updatedAt: now } })
            .run();
          continue;
        }
        if (r.clear) {
          tx.delete(settings).where(sql`${settings.key} = ${r.key}`).run();
          continue;
        }
        tx.insert(settings)
          .values({ key: r.key, value: r.value, encrypted: r.encrypted, updatedAt: now, updatedBy: userId })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value: r.value, encrypted: r.encrypted, updatedAt: now, updatedBy: userId },
          })
          .run();
      }
    });
    this.invalidate();
    return rows.map((r) => r.key as SettingKey);
  }
}

export function openSettings(db: Db): SettingsStore {
  let box: SecretBox | null = null;
  try {
    box = SecretBox.fromEnv();
  } catch {
    box = null;
  }
  return new SettingsStore(db, box);
}
