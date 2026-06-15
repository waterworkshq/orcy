import { createHash, randomBytes } from "crypto";
import { v4 as uuid } from "uuid";
import type { RemoteCredentialType } from "@orcy/shared/types";
import * as credentialRepo from "../repositories/remoteCredential.js";
import type { RemoteCredentialRow } from "../repositories/remoteCredential.js";

/** Input payload for {@link createCredentialWithSecret} describing the participant, habitat, credential type, and optional expiry/label. */
export interface CreateCredentialWithSecretInput {
  remoteParticipantId: string;
  habitatId: string;
  credentialType: RemoteCredentialType;
  label?: string;
  expiresAt?: string | null;
  createdBy?: string | null;
}

/** Result of {@link createCredentialWithSecret}: the persisted credential row and the one-time plaintext secret returned to the caller. */
export interface CredentialWithSecret {
  credential: RemoteCredentialRow;
  plaintextSecret: string;
}

/** Wrapper returned by {@link verifyRemoteKey} when a presented secret matches an active, unexpired credential. */
export interface VerifiedRemoteCredential {
  credential: RemoteCredentialRow;
}

const SECRET_PREFIX = "orcy_remote_";

/**
 * Computes the SHA-256 hex digest of a remote secret, used as the stored
 * lookup key on a {@link RemoteCredentialRow} (the plaintext is never persisted).
 */
export function hashRemoteSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Generates a fresh, prefixed random secret and its corresponding
 * {@link RemoteCredentialRow} hash in a single call.
 */
export function generateRemoteSecret(): { plaintextSecret: string; secretHash: string } {
  const plaintextSecret = `${SECRET_PREFIX}${uuid()}-${randomBytes(24).toString("hex")}`;
  const secretHash = hashRemoteSecret(plaintextSecret);
  return { plaintextSecret, secretHash };
}

/**
 * Persists a new {@link CredentialWithSecret} and returns the plaintext secret
 * exactly once for the caller to distribute to the remote participant.
 */
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

/**
 * Validates a raw presented secret and returns the matching
 * {@link VerifiedRemoteCredential} when it is active and not yet expired,
 * otherwise `null`.
 */
export function verifyRemoteKey(rawKey: string): VerifiedRemoteCredential | null {
  if (!rawKey || !rawKey.startsWith(SECRET_PREFIX)) return null;

  const secretHash = hashRemoteSecret(rawKey);
  const credential = credentialRepo.getRemoteCredentialByHash(secretHash);
  if (!credential) return null;
  if (credential.status !== "active") return null;
  // Inline expiry check — don't rely solely on batch sweep
  if (credential.expiresAt && new Date(credential.expiresAt).getTime() < Date.now()) return null;

  return { credential };
}

/**
 * Resolves a credential by id and returns the {@link RemoteCredentialRow} only
 * when it is active and not yet expired, otherwise `null`.
 */
export function verifyRemoteKeyById(credentialId: string): RemoteCredentialRow | null {
  const credential = credentialRepo.getRemoteCredentialById(credentialId);
  if (!credential) return null;
  if (credential.status !== "active") return null;
  // Inline expiry check — don't rely solely on batch sweep
  if (credential.expiresAt && new Date(credential.expiresAt).getTime() < Date.now()) return null;
  return credential;
}

/**
 * Revokes the previous credential and issues a fresh one atomically, returning
 * the new plaintext secret for the caller to redistribute.
 */
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

/**
 * Marks a {@link RemoteCredentialRow} as revoked (recording the actor and
 * reason) and returns the updated row, or `null` if no such credential exists.
 */
export function revokeCredential(
  credentialId: string,
  revokedBy?: string | null,
  revokeReason?: string | null,
): RemoteCredentialRow | null {
  return credentialRepo.revokeRemoteCredential(credentialId, revokedBy, revokeReason);
}

/**
 * Updates the `lastUsedAt` timestamp on a credential as a side effect, used to
 * record successful authentications.
 */
export function touchLastUsed(credentialId: string): void {
  credentialRepo.touchCredentialLastUsed(credentialId);
}

/**
 * Sweeps the repository, marking any past-expiry active credentials as expired,
 * and returns the number of rows that were updated.
 */
export function expireCredentials(): number {
  return credentialRepo.expireCredentials();
}
