/**
 * Web-tier authentication.
 *
 * Pages: `requireUser(role)` redirects to /login (or /setup on a fresh install).
 * Route handlers: `authorize(req, role, { apiKey })` returns the identity or a Response.
 * Every state-changing request from a browser must come from our own origin
 * (Sec-Fetch-Site / Origin), which closes the CSRF gap SameSite=Lax alone leaves.
 */
import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  identityForApiKey,
  roleAtLeast,
  SESSION_COOKIE,
  userCount,
  userForSession,
  type AuthUser,
} from "@zerobeat/core/auth/sessions";
import type { Role } from "@zerobeat/core/db/schema";

import { db } from "./ctx";

export type Identity = (AuthUser & { kind: "user" }) | { kind: "apikey"; id: string; name: string; role: Role; email: string; ownerId: string | null };

export async function currentUser(): Promise<AuthUser | null> {
  const jar = await cookies();
  return userForSession(db(), jar.get(SESSION_COOKIE)?.value);
}

export async function requireUser(role: Role = "VIEWER"): Promise<AuthUser> {
  const user = await currentUser();
  if (!user) {
    if (userCount(db()) === 0) redirect("/setup");
    const h = await headers();
    const path = h.get("x-invoke-path") ?? "";
    redirect(path ? `/login?next=${encodeURIComponent(path)}` : "/login");
  }
  if (!roleAtLeast(user.role, role)) redirect("/");
  return user;
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

export function problem(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return json({ error, ...extra }, status);
}

function sameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function cookieValue(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/**
 * Authorise a route handler request. API keys are accepted only where `apiKey` is set,
 * and are capped below ADMIN. Browser writes must be same-origin.
 */
export function authorize(req: Request, role: Role, opts: { apiKey?: boolean } = {}): Identity | Response {
  const auth = req.headers.get("authorization");
  const key = auth?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? req.headers.get("x-api-key");
  if (key && opts.apiKey) {
    const id = identityForApiKey(db(), key);
    if (!id) return problem(401, "invalid API key");
    if (!roleAtLeast(id.role, role)) return problem(403, "this API key's role cannot do that");
    return { kind: "apikey", id: id.id, name: id.name, role: id.role, email: `apikey:${id.name}`, ownerId: id.ownerId };
  }
  const user = userForSession(db(), cookieValue(req, SESSION_COOKIE));
  if (!user) return problem(401, "sign in first");
  if (!roleAtLeast(user.role, role)) return problem(403, "your role cannot do that");
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) return problem(403, "cross-site request refused");
  return { ...user, kind: "user" };
}

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? "local";
}

export function isSecure(req: Request): boolean {
  return (req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "")) === "https";
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
