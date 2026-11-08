/** Talking to the engine process (127.0.0.1, bearer token from the environment). */
import "server-only";

import { createHmac, hkdfSync } from "node:crypto";

const BASE = process.env.ENGINE_URL ?? "http://127.0.0.1:3101";
const TOKEN = process.env.ENGINE_TOKEN ?? "";

export class EngineDown extends Error {}

export async function engine<T = unknown>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, timeoutMs = 15_000, userId?: string): Promise<{ status: number; data: T }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(userId ? { "x-zerobeat-user": userId } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
      cache: "no-store",
    });
    const data = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, data };
  } catch (e) {
    throw new EngineDown(ctl.signal.aborted ? "the engine did not answer in time" : `the engine is not running (${(e as Error).message})`);
  } finally {
    clearTimeout(timer);
  }
}

/** Fire-and-forget: tell the engine settings changed. */
/** Fire-and-forget: tell the engine a contact was logged here (UDP feed, uploads). */
export function engineQsoLogged(id: string): void {
  void engine("POST", "/qso-logged", { id }).catch(() => {});
}

export function engineReload(): void {
  void engine("POST", "/reload").catch(() => {});
}

/** Same construction as the engine's verifyTicket. */
export function wsTicket(user: string, now = Date.now()): string {
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(TOKEN), Buffer.alloc(0), Buffer.from("zerobeat:ws-ticket"), 32));
  const body = `${now + 60_000}.${Buffer.from(user).toString("base64url")}`;
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

export function wsUrlHint(): string | null {
  return process.env.ENGINE_WS_PUBLIC ?? null;
}
