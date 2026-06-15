import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

/**
 * AES-256-GCM symmetric encryption for secrets that need to survive restarts.
 * The key is derived from JWT_SECRET (already required for server startup).
 */

function getEncryptionKey(): Buffer {
  const secret = process.env.JWT_SECRET || "dev-secret-change-in-production";
  return createHash("sha256").update(secret).digest();
}

/** Encrypts a plaintext value with AES-256-GCM, returning a self-describing `aes:` envelope holding the IV, auth tag, and ciphertext. */
export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `aes:${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/** Decrypts a value produced by {@link encryptSecret}, returning `null` for missing, malformed, or tampered input. */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored || !stored.startsWith("aes:")) return null;
  const parts = stored.split(":");
  if (parts.length !== 4) return null;
  const iv = Buffer.from(parts[1], "hex");
  const authTag = Buffer.from(parts[2], "hex");
  const encrypted = Buffer.from(parts[3], "hex");
  const key = getEncryptionKey();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
