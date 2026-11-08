"use client";
/** JSON fetch for the web tier's own API. Throws ApiError with the server's message. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues?: Record<string, string>,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(path, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers: opts.body !== undefined && !(opts.body instanceof FormData) ? { "content-type": "application/json" } : undefined,
    body: opts.body === undefined ? undefined : opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body),
    cache: "no-store",
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string; issues?: Record<string, string> };
  if (!r.ok) throw new ApiError(j.error ?? `HTTP ${r.status}`, r.status, j.issues);
  return j as T;
}
