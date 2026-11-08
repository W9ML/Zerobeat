import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** 20-char base36 id, time-prefixed so rows sort roughly by creation. */
export function newId(): string {
  const t = Date.now().toString(36).padStart(9, "0");
  const bytes = randomBytes(11);
  let r = "";
  for (const b of bytes) r += ALPHABET[b % 36];
  return t + r;
}

/** URL-safe random token, `bytes` of entropy. */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
