import { getDb } from "../db/index.js";
import { identityProviders, identityProviderAuthStates } from "../db/schema/index.js";
import { eq, and, lt } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";
import type { IdentityProviderKind, IdentityProviderAuthStateStatus } from "@orcy/shared/types";

// ---------------------------------------------------------------------------
// Identity Providers
// ---------------------------------------------------------------------------

export interface CreateIdentityProviderInput {
  habitatId: string;
  kind: IdentityProviderKind;
  name: string;
  issuer?: string | null;
  config?: Record<string, unknown>;
  enabled?: boolean;
  createdBy?: string | null;
}

export interface IdentityProviderRow {
  id: string;
  habitatId: string;
  kind: string;
  name: string;
  issuer: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const providerFields = {
  id: identityProviders.id,
  habitatId: identityProviders.habitatId,
  kind: identityProviders.kind,
  name: identityProviders.name,
  issuer: identityProviders.issuer,
  config: identityProviders.config,
  enabled: identityProviders.enabled,
  createdBy: identityProviders.createdBy,
  createdAt: identityProviders.createdAt,
  updatedAt: identityProviders.updatedAt,
} as const;

export function createIdentityProvider(input: CreateIdentityProviderInput): IdentityProviderRow {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(identityProviders)
      .values({
        id,
        habitatId: input.habitatId,
        kind: input.kind,
        name: input.name,
        issuer: input.issuer ?? null,
        config: input.config ?? {},
        enabled: input.enabled ?? false,
        createdBy: input.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("identityProvider", err as Error, id);
  }

  const row = getIdentityProviderById(id);
  if (!row) throw repositoryNotFoundError("identityProvider", id);
  return row;
}

export function getIdentityProviderById(id: string): IdentityProviderRow | null {
  const db = getDb();
  const rows = db
    .select(providerFields)
    .from(identityProviders)
    .where(eq(identityProviders.id, id))
    .all();
  return rows.length > 0 ? rows[0] : null;
}

export function getIdentityProvidersByHabitat(habitatId: string): IdentityProviderRow[] {
  const db = getDb();
  return db
    .select(providerFields)
    .from(identityProviders)
    .where(eq(identityProviders.habitatId, habitatId))
    .all();
}

export function getEnabledIdentityProviders(habitatId: string): IdentityProviderRow[] {
  const db = getDb();
  return db
    .select(providerFields)
    .from(identityProviders)
    .where(and(eq(identityProviders.habitatId, habitatId), eq(identityProviders.enabled, true)))
    .all();
}

export function updateIdentityProvider(
  id: string,
  patch: Partial<Pick<IdentityProviderRow, "name" | "issuer" | "config" | "enabled">>,
): IdentityProviderRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(identityProviders)
      .set({ ...patch, updatedAt: now })
      .where(eq(identityProviders.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("identityProvider", err as Error, id);
  }
  return getIdentityProviderById(id);
}

export function deleteIdentityProvider(id: string): void {
  const db = getDb();
  db.delete(identityProviders).where(eq(identityProviders.id, id)).run();
}

// ---------------------------------------------------------------------------
// Identity Provider Auth States
// ---------------------------------------------------------------------------

export interface CreateAuthStateInput {
  providerId: string;
  habitatId: string;
  state: string;
  nonce?: string | null;
  pkceVerifier?: string | null;
  inviteId?: string | null;
  context?: Record<string, unknown>;
  expiresAt: string;
}

export interface AuthStateRow {
  id: string;
  providerId: string;
  habitatId: string;
  state: string;
  nonce: string | null;
  pkceVerifier: string | null;
  inviteId: string | null;
  context: Record<string, unknown>;
  status: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

const authStateFields = {
  id: identityProviderAuthStates.id,
  providerId: identityProviderAuthStates.providerId,
  habitatId: identityProviderAuthStates.habitatId,
  state: identityProviderAuthStates.state,
  nonce: identityProviderAuthStates.nonce,
  pkceVerifier: identityProviderAuthStates.pkceVerifier,
  inviteId: identityProviderAuthStates.inviteId,
  context: identityProviderAuthStates.context,
  status: identityProviderAuthStates.status,
  expiresAt: identityProviderAuthStates.expiresAt,
  consumedAt: identityProviderAuthStates.consumedAt,
  createdAt: identityProviderAuthStates.createdAt,
} as const;

export function createAuthState(input: CreateAuthStateInput): AuthStateRow {
  const db = getDb();
  const id = uuid();

  try {
    db.insert(identityProviderAuthStates)
      .values({
        id,
        providerId: input.providerId,
        habitatId: input.habitatId,
        state: input.state,
        nonce: input.nonce ?? null,
        pkceVerifier: input.pkceVerifier ?? null,
        inviteId: input.inviteId ?? null,
        context: input.context ?? {},
        status: "pending",
        expiresAt: input.expiresAt,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("authState", err as Error, id);
  }

  const row = getAuthStateById(id);
  if (!row) throw repositoryNotFoundError("authState", id);
  return row;
}

export function getAuthStateById(id: string): AuthStateRow | null {
  const db = getDb();
  const rows = db
    .select(authStateFields)
    .from(identityProviderAuthStates)
    .where(eq(identityProviderAuthStates.id, id))
    .all();
  return rows.length > 0 ? rows[0] : null;
}

export function getAuthStateByState(state: string): AuthStateRow | null {
  const db = getDb();
  const rows = db
    .select(authStateFields)
    .from(identityProviderAuthStates)
    .where(eq(identityProviderAuthStates.state, state))
    .all();
  return rows.length > 0 ? rows[0] : null;
}

export function consumeAuthState(id: string): AuthStateRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(identityProviderAuthStates)
      .set({ status: "consumed", consumedAt: now })
      .where(eq(identityProviderAuthStates.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("authState", err as Error, id);
  }
  return getAuthStateById(id);
}

export function deleteExpiredAuthStates(): number {
  const db = getDb();
  const now = new Date().toISOString();
  const before = db
    .select({ id: identityProviderAuthStates.id })
    .from(identityProviderAuthStates)
    .where(
      and(
        eq(identityProviderAuthStates.status, "pending"),
        lt(identityProviderAuthStates.expiresAt, now),
      ),
    )
    .all();
  for (const row of before) {
    db.delete(identityProviderAuthStates).where(eq(identityProviderAuthStates.id, row.id)).run();
  }
  return before.length;
}

export function getPendingAuthStatesByProvider(providerId: string): AuthStateRow[] {
  const db = getDb();
  return db
    .select(authStateFields)
    .from(identityProviderAuthStates)
    .where(
      and(
        eq(identityProviderAuthStates.providerId, providerId),
        eq(identityProviderAuthStates.status, "pending"),
      ),
    )
    .all();
}
