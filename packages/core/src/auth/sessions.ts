/**
 * Sessions, login throttling and API keys. Framework-agnostic: the web tier handles
 * cookies and headers and passes raw tokens in.
 *
 *  - Session and API-key tokens are 256-bit random; only SHA-256 hashes are stored.
 *  - The login throttle is persisted (a restart does not clear a lockout) and keyed by
 *    BOTH the client address and the account, so neither password spraying across
 *    accounts nor a botnet against one account gets a fresh budget.
 */
import { createHash } from "node:crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { apiKeys, loginAttempts, sessions, users, type Role, type User } from "../db/schema.ts";
import { newId, newToken } from "../util/id.ts";
import { hashPassword, needsRehash, verifyPassword } from "./password.ts";

export const SESSION_COOKIE = "ds_session";
const LAST_SEEN_THROTTLE_MS = 5 * 60_000;

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  callsign: string | null;
  role: Role;
}

const ROLE_RANK: Record<Role, number> = { VIEWER: 1, OPERATOR: 2, ADMIN: 3 };
export function roleAtLeast(have: Role, need: Role): boolean {
  return ROLE_RANK[have] >= ROLE_RANK[need];
}

function toAuthUser(u: User): AuthUser {
  return { id: u.id, email: u.email, name: u.name, callsign: u.callsign, role: u.role };
}

// ---------------------------------------------------------------------------
// Throttle
// ---------------------------------------------------------------------------

const MAX_FAILURES = { ip: 20, user: 5 } as const;
const LOCK_MS = 15 * 60_000;
/** Per account: after MAX_FAILURES.user, each failure delays the next attempt, up to this. */
const USER_DELAY_MAX_MS = 30_000;
const DECAY_MS = 30 * 60_000;

export class LoginThrottle {
  constructor(private readonly db: Db) {}

  /** Milliseconds until the attempt is allowed; 0 when it may proceed. */
  blockedFor(ip: string, email: string, now = Date.now()): number {
    let wait = 0;
    for (const key of [`ip:${ip}`, `user:${email.toLowerCase()}`]) {
      const row = this.db.select().from(loginAttempts).where(eq(loginAttempts.key, key)).get();
      if (row?.lockedUntil && row.lockedUntil > now) wait = Math.max(wait, row.lockedUntil - now);
    }
    return wait;
  }

  fail(ip: string, email: string, now = Date.now()): void {
    for (const [kind, key] of [
      ["ip", `ip:${ip}`],
      ["user", `user:${email.toLowerCase()}`],
    ] as const) {
      const row = this.db.select().from(loginAttempts).where(eq(loginAttempts.key, key)).get();
      const stale = !row || now - row.updatedAt > DECAY_MS;
      const failures = (stale ? 0 : row.failures) + 1;
      // An IP that keeps failing is locked out. An account that keeps failing is slowed
      // down, never locked: its name is public (a callsign), and a lock would let anyone
      // keep its owner out.
      const over = failures - MAX_FAILURES[kind];
      const lockedUntil = over < 0 ? (row?.lockedUntil ?? null) : kind === "ip" ? now + LOCK_MS : now + Math.min(USER_DELAY_MAX_MS, 2_000 * 2 ** over);
      this.db
        .insert(loginAttempts)
        .values({ key, failures, lockedUntil, updatedAt: now })
        .onConflictDoUpdate({ target: loginAttempts.key, set: { failures, lockedUntil, updatedAt: now } })
        .run();
    }
  }

  succeed(email: string): void {
    this.db.delete(loginAttempts).where(eq(loginAttempts.key, `user:${email.toLowerCase()}`)).run();
  }

  sweep(now = Date.now()): void {
    this.db.delete(loginAttempts).where(lt(loginAttempts.updatedAt, now - 24 * 3_600_000)).run();
  }
}

// ---------------------------------------------------------------------------
// Login and sessions
// ---------------------------------------------------------------------------

// A real scrypt hash of a random string, so an unknown account costs the same as a
// wrong password and response time does not reveal which emails exist.
const DUMMY_HASH = "scrypt$65536$8$1$8nYqBqX0pY7yA9X0b2m9fA==$K5VQ4bqW6h4m6rS3pV7yE0eYJ8f2r1Z3gN9xC6tQh2o=";

export type LoginResult =
  | { ok: true; user: AuthUser; token: string; expiresAt: number }
  | { ok: false; reason: "invalid" | "locked"; retryAfterMs?: number };

export async function login(
  db: Db,
  opts: { identifier: string; password: string; ip: string; userAgent: string | null; sessionDays: number },
): Promise<LoginResult> {
  const throttle = new LoginThrottle(db);
  const ident = opts.identifier.trim();
  const wait = throttle.blockedFor(opts.ip, ident);
  if (wait > 0) return { ok: false, reason: "locked", retryAfterMs: wait };

  const user = ident.includes("@")
    ? db.select().from(users).where(sql`lower(${users.email}) = ${ident.toLowerCase()}`).get()
    : db.select().from(users).where(sql`upper(${users.callsign}) = ${ident.toUpperCase()}`).get();

  const valid = await verifyPassword(opts.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !valid || !user.active) {
    throttle.fail(opts.ip, ident);
    return { ok: false, reason: "invalid" };
  }
  throttle.succeed(ident);

  const now = Date.now();
  const updates: Partial<User> = { lastLoginAt: now };
  if (needsRehash(user.passwordHash)) updates.passwordHash = await hashPassword(opts.password);
  db.update(users).set(updates).where(eq(users.id, user.id)).run();

  const { token, expiresAt } = createSession(db, user.id, { ip: opts.ip, userAgent: opts.userAgent, sessionDays: opts.sessionDays });
  return { ok: true, user: toAuthUser(user), token, expiresAt };
}

export function createSession(
  db: Db,
  userId: string,
  opts: { ip: string | null; userAgent: string | null; sessionDays: number },
): { token: string; expiresAt: number } {
  const token = newToken(32);
  const now = Date.now();
  const expiresAt = now + opts.sessionDays * 86_400_000;
  db.insert(sessions)
    .values({
      id: newId(),
      tokenHash: sha256(token),
      userId,
      expiresAt,
      createdAt: now,
      lastSeenAt: now,
      ip: opts.ip?.slice(0, 64) ?? null,
      userAgent: opts.userAgent?.slice(0, 255) ?? null,
    })
    .run();
  return { token, expiresAt };
}

/** Resolve a session token to its user, or null. Checks expiry and `active` every call. */
export function userForSession(db: Db, token: string | null | undefined, now = Date.now()): AuthUser | null {
  if (!token || token.length > 128) return null;
  const row = db
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, sha256(token)))
    .get();
  if (!row) return null;
  if (row.s.expiresAt <= now) {
    db.delete(sessions).where(eq(sessions.id, row.s.id)).run();
    return null;
  }
  if (!row.u.active) return null;
  if (now - row.s.lastSeenAt > LAST_SEEN_THROTTLE_MS) {
    db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.s.id)).run();
  }
  return toAuthUser(row.u);
}

export function destroySession(db: Db, token: string | null | undefined): void {
  if (!token) return;
  db.delete(sessions).where(eq(sessions.tokenHash, sha256(token))).run();
}

export function destroyUserSessions(db: Db, userId: string, exceptToken?: string): void {
  if (exceptToken) {
    db.delete(sessions)
      .where(and(eq(sessions.userId, userId), sql`${sessions.tokenHash} <> ${sha256(exceptToken)}`))
      .run();
  } else {
    db.delete(sessions).where(eq(sessions.userId, userId)).run();
  }
}

export function sweepSessions(db: Db, now = Date.now()): number {
  return db.delete(sessions).where(lt(sessions.expiresAt, now)).run().changes;
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

const API_KEY_PREFIX = "dsk_";

export function createApiKey(
  db: Db,
  opts: { name: string; role: Exclude<Role, "ADMIN">; createdById: string; expiresAt?: number | null },
): { id: string; token: string } {
  const token = API_KEY_PREFIX + newToken(32);
  const id = newId();
  db.insert(apiKeys)
    .values({
      id,
      name: opts.name,
      tokenHash: sha256(token),
      prefix: token.slice(0, 12),
      role: opts.role,
      createdById: opts.createdById,
      expiresAt: opts.expiresAt ?? null,
    })
    .run();
  return { id, token };
}

/** An API key's identity; it acts on the logbook of the user who made it (ownerId). */
export function identityForApiKey(db: Db, token: string | null | undefined, now = Date.now()): { id: string; name: string; role: Role; ownerId: string | null } | null {
  if (!token?.startsWith(API_KEY_PREFIX) || token.length > 128) return null;
  const row = db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.tokenHash, sha256(token)), eq(apiKeys.active, true)))
    .get();
  if (!row) return null;
  if (row.expiresAt && row.expiresAt <= now) return null;
  if (!row.lastUsedAt || now - row.lastUsedAt > LAST_SEEN_THROTTLE_MS) {
    db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.id)).run();
  }
  return { id: row.id, name: row.name, role: row.role, ownerId: row.createdById ?? null };
}

export function userCount(db: Db): number {
  return db.get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM users`)?.c ?? 0;
}

export function activeAdminCount(db: Db, excludingId?: string): number {
  return (
    db.get<{ c: number }>(
      sql`SELECT COUNT(*) AS c FROM users WHERE role = 'ADMIN' AND active = 1 ${excludingId ? sql`AND id <> ${excludingId}` : sql``}`,
    )?.c ?? 0
  );
}

