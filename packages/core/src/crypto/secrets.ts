/**
 * AES-256-GCM for settings secrets at rest.
 *
 * Stored format: `v1:<iv-b64>:<tag-b64>:<ciphertext-b64>`.
 *
 * The key comes from ZEROBEAT_SECRET_KEY (64 hex chars or 44-char base64 = 32 bytes).
 * It is never stored in the database; losing it makes every stored credential unreadable.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class SecretKeyError extends Error {
  override readonly name = "SecretKeyError";
}

export function parseSecretKey(raw: string | undefined): Buffer {
  const value = (raw ?? "").trim();
  if (!value) {
    throw new SecretKeyError(
      "ZEROBEAT_SECRET_KEY is not set. Generate one with `openssl rand -hex 32`.",
    );
  }
  const key = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.length !== KEY_BYTES) {
    throw new SecretKeyError(`ZEROBEAT_SECRET_KEY must decode to ${KEY_BYTES} bytes; got ${key.length}.`);
  }
  if (timingSafeEqual(key, Buffer.alloc(KEY_BYTES))) {
    throw new SecretKeyError("ZEROBEAT_SECRET_KEY is all zeroes, which is a placeholder, not a key.");
  }
  return key;
}

export class SecretBox {
  constructor(private readonly key: Buffer) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SecretBox {
    return new SecretBox(parseSecretKey(env.ZEROBEAT_SECRET_KEY));
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(":");
  }

  /** Null on anything unreadable: wrong key, tampered row, foreign format. */
  decrypt(stored: string): string | null {
    const parts = stored.split(":");
    if (parts.length !== 4 || parts[0] !== VERSION) return null;
    try {
      const iv = Buffer.from(parts[1]!, "base64");
      const tag = Buffer.from(parts[2]!, "base64");
      const data = Buffer.from(parts[3]!, "base64");
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
      const decipher = createDecipheriv(ALGO, this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }
}

export function isEncryptedValue(value: string): boolean {
  return value.startsWith(`${VERSION}:`) && value.split(":").length === 4;
}

/** `••••••1234` — enough to confirm which credential is stored, no more. */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 4) return "••••";
  return `••••••${plaintext.slice(-4)}`;
}
