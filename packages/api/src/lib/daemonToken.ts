import { createHash, randomBytes } from "crypto";

export function generateDaemonToken(): string {
  return `daemon-${randomBytes(24).toString("hex")}`;
}

export function hashDaemonToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function verifyDaemonToken(token: string, hash: string): boolean {
  return hashDaemonToken(token) === hash;
}
