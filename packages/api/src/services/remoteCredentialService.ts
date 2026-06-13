import { createHash, randomBytes } from "crypto";
import { v4 as uuid } from "uuid";
import type { RemoteCredentialType } from "@orcy/shared/types";
import * as credentialRepo from "../repositories/remoteCredential.js";
import type { RemoteCredentialRow } from "../repositories/remoteCredential.js";

export interface CreateCredentialWithSecretInput {
  remoteParticipantId: string;
  habitatId: string;
  credentialType: RemoteCredentialType;
  label?: string;
  expiresAt?: string | null;
  createdBy?: string | null;
}

export interface CredentialWithSecret {
  credential: RemoteCredentialRow;
  plaintextSecret: string;
}

export interface VerifiedRemoteCredential {
  credential: RemoteCredentialRow;
}

const SECRET_PREFIX = "orcy_remote_";

export function hashRemoteSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function generateRemoteSecret(): { plaintextSecret: string; secretHash: string } {
  const plaintextSecret = `${SECRET_PREFIX}${uuid()}-${randomBytes(24).toString("hex")}`;
  const secretHash = hashRemoteSecret(plaintextSecret);
  return { plaintextSecret, secretHash };
}

export function createCredentialWithSecret(
  input: CreateCredentialWithSecretInput,
): CredentialWithSecret {
  const { plaintextSecret, secretHash } = generateRemoteSecret();
  const credential = credentialRepo.createRemoteCredential({
    remoteParticipantId: input.remoteParticipantId,
    habitatId: input.habitatId,
    credentialType: input.credentialType,
    secretHash,
    label: input.label,
    expiresAt: input.expiresAt,
    createdBy: input.createdBy,
  });
  return { credential, plaintextSecret };
}

export function verifyRemoteKey(rawKey: string): VerifiedRemoteCredential | null {
  if (!rawKey || !rawKey.startsWith(SECRET_PREFIX)) return null;

  const secretHash = hashRemoteSecret(rawKey);
  const credential = credentialRepo.getRemoteCredentialByHash(secretHash);
  if (!credential) return null;
  if (credential.status !== "active") return null;

  return { credential };
}

export function verifyRemoteKeyById(credentialId: string): RemoteCredentialRow | null {
  const credential = credentialRepo.getRemoteCredentialById(credentialId);
  if (!credential) return null;
  if (credential.status !== "active") return null;
  return credential;
}

export function rotateCredential(
  credentialId: string,
  rotatedBy?: string | null,
): {
  oldCredential: RemoteCredentialRow | null;
  newCredential: RemoteCredentialRow | null;
  plaintextSecret: string;
} {
  const { plaintextSecret, secretHash } = generateRemoteSecret();
  const result = credentialRepo.rotateRemoteCredential(credentialId, secretHash, rotatedBy);
  return { ...result, plaintextSecret };
}

export function revokeCredential(
  credentialId: string,
  revokedBy?: string | null,
  revokeReason?: string | null,
): RemoteCredentialRow | null {
  return credentialRepo.revokeRemoteCredential(credentialId, revokedBy, revokeReason);
}

export function touchLastUsed(credentialId: string): void {
  credentialRepo.touchCredentialLastUsed(credentialId);
}

export function expireCredentials(): number {
  return credentialRepo.expireCredentials();
}
