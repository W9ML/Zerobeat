/** Callsigns in copied text: one or two letters, digits, letters, with an optional /suffix. */
const CALL_RE = /\b(?:[A-Z]{1,2}\d{1,4}[A-Z]{1,4}|\d[A-Z]\d{1,4}[A-Z]{1,4})(?:\/[A-Z0-9]{1,4})?\b/g;

/**
 * The station a copied line is from, for click-to-call in the keyboard modes. "CQ CQ
 * TEST DE PY2TF PY2TF" is PY2TF: repeated CQs, modifiers (DX, TEST, POTA) and DE are
 * skipped, and a callsign has a digit in it.
 */
export function senderOf(text: string, me: string | null): string | null {
  const cq = /^CQ(?: [A-Z]{2,4})*? ([A-Z0-9]{1,3}\d[A-Z0-9]+(?:\/[A-Z0-9]+)?)\b/.exec(text);
  if (cq) return cq[1]!;
  for (const m of text.match(CALL_RE) ?? []) if (m !== me) return m;
  return null;
}
