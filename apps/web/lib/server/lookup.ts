/**
 * Callbook lookups (the user's own QRZ login when they have one, HamDB otherwise), cached
 * for an hour per login, shared by the lookup API and the photo proxy.
 */
import "server-only";

import { hamdbLookup, QrzLookup, type CallsignInfo } from "@zerobeat/core/integrations/qrz";

import { settingsStore } from "./ctx";

const clients = new Map<string, QrzLookup>();
const cache = new Map<string, { at: number; info: CallsignInfo | null }>();
const TTL = 3_600_000;

/** The base call a callbook knows: the longest part of PJ4/K1ABC/P. */
const baseCall = (call: string) => call.split("/").sort((a, b) => b.length - a.length)[0]!;

/** `userId`: whose QRZ login to use (their subscription, their results). */
export async function lookupCall(call: string, userId: string | null): Promise<CallsignInfo | null> {
  const s = settingsStore().snapshot(userId);
  const login = s["qrz.username"] && s["qrz.password"] ? `${s["qrz.username"]}|${s["qrz.password"]}` : "";
  const ck = `${login ? s["qrz.username"] : "hamdb"}|${call}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL) return hit.info;
  let info: CallsignInfo | null = null;
  try {
    if (login) {
      let client = clients.get(login);
      if (!client) clients.set(login, (client = new QrzLookup(s["qrz.username"], s["qrz.password"])));
      info = await client.lookup(baseCall(call));
    } else {
      info = await hamdbLookup(baseCall(call));
    }
  } catch {
    info = null;
  }
  cache.set(ck, { at: Date.now(), info });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return info;
}

const photos = new Map<string, { at: number; photo: { type: string; body: Uint8Array } | null }>();

/**
 * The station's callbook photo, fetched by this server (the browser never talks to QRZ)
 * from QRZ's own image hosts only, at most 3 MB, cached for an hour.
 */
export async function lookupPhoto(call: string, userId: string | null): Promise<{ type: string; body: Uint8Array } | null> {
  const hit = photos.get(call);
  if (hit && Date.now() - hit.at < TTL) return hit.photo;
  const info = await lookupCall(call, userId);
  let out: { type: string; body: Uint8Array } | null = null;
  try {
    const u = info?.imageUrl ? new URL(info.imageUrl) : null;
    if (u && u.protocol === "https:" && (u.hostname === "qrz.com" || u.hostname.endsWith(".qrz.com"))) {
      const r = await fetch(u, { redirect: "error", signal: AbortSignal.timeout(10_000) });
      const type = r.headers.get("content-type") ?? "";
      const len = Number(r.headers.get("content-length") ?? 0);
      if (r.ok && /^image\/(jpeg|png|gif|webp)$/.test(type) && len <= 3_000_000) {
        const body = new Uint8Array(await r.arrayBuffer());
        if (body.length <= 3_000_000) out = { type, body };
      }
    }
  } catch {
    out = null;
  }
  photos.set(call, { at: Date.now(), photo: out });
  if (photos.size > 300) photos.delete(photos.keys().next().value!);
  return out;
}
