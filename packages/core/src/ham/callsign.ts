/** Callsign shape checks and normalisation shared by the log, the decoder and the lookups. */

/** Loose: 3–12 chars of A-Z 0-9 and at most two slashes. Not a licensing judgement. */
const CALL_RE = /^[A-Z0-9]{1,4}(?:\/[A-Z0-9]{1,8}){0,2}$|^[A-Z0-9]{3,8}(?:\/[A-Z0-9]{1,4}){0,2}$/;

export function normaliseCallsign(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, "");
}

export function looksLikeCallsign(s: string): boolean {
  const c = normaliseCallsign(s);
  if (c.length < 3 || c.length > 14) return false;
  if (!/\d/.test(c)) return false;
  if (!/^[A-Z0-9/]+$/.test(c)) return false;
  if (c.startsWith("/") || c.endsWith("/")) return false;
  return CALL_RE.test(c) || /^[A-Z0-9]+(?:\/[A-Z0-9]+){1,2}$/.test(c);
}

/** Portable/rover/etc. suffixes that do not change the licensing entity. */
const PLAIN_SUFFIXES = new Set(["P", "M", "MM", "AM", "QRP", "R", "A", "B", "LH", "J", "T"]);

/**
 * Split `PJ4/K1ABC/P` into its parts for DXCC resolution.
 * Returns the base call and the prefix that decides the entity (a leading country
 * prefix, a trailing non-plain suffix such as `/VE3`, or the base call itself).
 */
export function splitCallsign(call: string): { base: string; entityPrefixPart: string; parts: string[] } {
  const c = normaliseCallsign(call);
  const parts = c.split("/");
  if (parts.length === 1) return { base: c, entityPrefixPart: c, parts };

  // Drop plain suffixes from the right.
  const kept = [...parts];
  while (kept.length > 1 && PLAIN_SUFFIXES.has(kept[kept.length - 1]!)) kept.pop();
  // A trailing single digit is a call-area override (W1ABC/7).
  const last = kept[kept.length - 1]!;
  if (kept.length > 1 && /^\d$/.test(last)) {
    kept.pop();
    const base = kept.reduce((a, b) => (b.length > a.length ? b : a));
    return { base, entityPrefixPart: base.replace(/\d/, last), parts };
  }
  if (kept.length === 1) return { base: kept[0]!, entityPrefixPart: kept[0]!, parts };

  // Two meaningful parts: the shorter is the prefix (PJ4/K1ABC, K1ABC/VE3).
  const [a, b] = [kept[0]!, kept[1]!];
  const base = a.length >= b.length ? a : b;
  const prefix = a.length >= b.length ? b : a;
  // A prefix with no digit gets one appended (ADIF/cty convention: "PJ4" is fine, "VE" → "VE0").
  return { base, entityPrefixPart: /\d/.test(prefix) ? prefix : prefix + "0", parts };
}
