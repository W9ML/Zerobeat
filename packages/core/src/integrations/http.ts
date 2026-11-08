/** Outbound HTTP with a timeout and an honest User-Agent. Never throws on HTTP status. */
export const USER_AGENT = "Zerobeat/2.0";

export class NetError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "NetError";
  }
}

export async function httpRequest(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ status: number; text: string; headers: Headers }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.timeoutMs ?? 30_000);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { "user-agent": USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
      signal: ctl.signal,
    });
    return { status: res.status, text: await res.text(), headers: res.headers };
  } catch (err) {
    const msg = ctl.signal.aborted ? `timed out after ${(init.timeoutMs ?? 30_000) / 1000}s` : err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    throw new NetError(`${new URL(url).host}: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function httpBuffer(url: string, timeoutMs = 60_000): Promise<{ status: number; body: Buffer }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: ctl.signal });
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
  } catch (err) {
    throw new NetError(`${new URL(url).host}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The outcome of sending one contact (or one batch) to a service.
 *  - sent / duplicate: done.
 *  - rejected: the service refused THIS record; retrying will not help.
 *  - retry: transport or server trouble; try again later.
 *  - auth: credentials or configuration are wrong; pause the whole service.
 */
export type UploadOutcome =
  | { status: "sent"; detail?: string; remoteId?: string }
  | { status: "duplicate"; detail?: string; remoteId?: string }
  | { status: "rejected"; detail: string }
  | { status: "retry"; detail: string }
  | { status: "auth"; detail: string };
