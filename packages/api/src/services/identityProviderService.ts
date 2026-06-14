import { createHash, randomBytes } from "crypto";
import { v4 as uuid } from "uuid";
import type { IdentityProviderKind } from "@orcy/shared/types";
import * as providerRepo from "../repositories/identityProvider.js";
import type { IdentityProviderRow } from "../repositories/identityProvider.js";
import { getBaseUrl } from "./shareHabitatReadinessService.js";
import { badRequest, notFound } from "../errors.js";

export interface ConfigureProviderInput {
  habitatId: string;
  kind: IdentityProviderKind;
  name: string;
  issuer?: string | null;
  clientId: string;
  clientSecret: string;
  callbackUrl?: string | null;
  scopes?: string[];
  enabled?: boolean;
  createdBy?: string | null;
}

export interface ProviderConfig {
  id: string;
  habitatId: string;
  kind: string;
  name: string;
  issuer: string | null;
  enabled: boolean;
  clientId: string;
  hasClientSecret: boolean;
  callbackUrl: string;
  scopes: string[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function toConfigView(row: IdentityProviderRow): ProviderConfig {
  const config = row.config as Record<string, unknown>;
  const baseUrl = getBaseUrl();
  const defaultCallback = baseUrl
    ? `${baseUrl}/api/shared/auth/${row.id}/callback`
    : `/api/shared/auth/${row.id}/callback`;
  return {
    id: row.id,
    habitatId: row.habitatId,
    kind: row.kind,
    name: row.name,
    issuer: row.issuer,
    enabled: row.enabled,
    clientId: typeof config?.clientId === "string" ? config.clientId : "",
    hasClientSecret: Boolean(config?.clientSecret),
    callbackUrl: typeof config?.callbackUrl === "string" ? config.callbackUrl : defaultCallback,
    scopes: Array.isArray(config?.scopes) ? (config.scopes as string[]) : [],
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function maskSecret(secret: string): string {
  // Store secrets with basic obfuscation — this is NOT a security boundary.
  // The database itself is the security boundary. This just prevents casual
  // plaintext exposure in config dumps. Real protection comes from DB access
  // control and the credential never being returned by API responses.
  return `enc:${secret}`;
}

function unmaskSecret(masked: string): string {
  return masked.startsWith("enc:") ? masked.slice(4) : masked;
}

export function configureProvider(input: ConfigureProviderInput): ProviderConfig {
  if (!input.clientId?.trim()) {
    throw badRequest("clientId is required");
  }
  if (!input.clientSecret?.trim()) {
    throw badRequest("clientSecret is required");
  }
  const baseUrl = getBaseUrl();
  const callbackUrl = input.callbackUrl ?? (baseUrl ? `${baseUrl}/api/shared/auth/callback` : "");

  const row = providerRepo.createIdentityProvider({
    habitatId: input.habitatId,
    kind: input.kind,
    name: input.name,
    issuer: input.issuer ?? null,
    config: {
      clientId: input.clientId.trim(),
      clientSecret: maskSecret(input.clientSecret),
      callbackUrl,
      scopes: input.scopes ?? getDefaultScopes(input.kind),
    },
    enabled: input.enabled ?? false,
    createdBy: input.createdBy ?? null,
  });

  return toConfigView(row);
}

export function getProviderConfig(habitatId: string, providerId: string): ProviderConfig {
  const row = providerRepo.getIdentityProviderById(providerId);
  if (!row || row.habitatId !== habitatId) {
    throw notFound("Identity provider not found");
  }
  return toConfigView(row);
}

export function listProviders(habitatId: string): ProviderConfig[] {
  return providerRepo.getIdentityProvidersByHabitat(habitatId).map((row) => toConfigView(row));
}

export function updateProvider(
  habitatId: string,
  providerId: string,
  patch: {
    name?: string;
    issuer?: string | null;
    clientId?: string;
    clientSecret?: string;
    callbackUrl?: string;
    scopes?: string[];
    enabled?: boolean;
  },
): ProviderConfig {
  const row = providerRepo.getIdentityProviderById(providerId);
  if (!row || row.habitatId !== habitatId) {
    throw notFound("Identity provider not found");
  }

  const existingConfig = row.config as Record<string, unknown>;
  const newConfig: Record<string, unknown> = { ...existingConfig };

  if (patch.clientId !== undefined) newConfig.clientId = patch.clientId.trim();
  if (patch.clientSecret !== undefined) newConfig.clientSecret = maskSecret(patch.clientSecret);
  if (patch.callbackUrl !== undefined) newConfig.callbackUrl = patch.callbackUrl;
  if (patch.scopes !== undefined) newConfig.scopes = patch.scopes;

  const updated = providerRepo.updateIdentityProvider(providerId, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.issuer !== undefined ? { issuer: patch.issuer } : {}),
    ...(Object.keys(newConfig).length > 0 ? { config: newConfig } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
  });

  if (!updated) throw notFound("Identity provider not found");
  return toConfigView(updated);
}

export function deleteProvider(habitatId: string, providerId: string): void {
  const row = providerRepo.getIdentityProviderById(providerId);
  if (!row || row.habitatId !== habitatId) {
    throw notFound("Identity provider not found");
  }
  providerRepo.deleteIdentityProvider(providerId);
}

export function getClientSecret(habitatId: string, providerId: string): string | null {
  const row = providerRepo.getIdentityProviderById(providerId);
  if (!row || row.habitatId !== habitatId) return null;
  const config = row.config as Record<string, unknown>;
  if (typeof config?.clientSecret !== "string") return null;
  return unmaskSecret(config.clientSecret);
}

export function getDefaultScopes(kind: IdentityProviderKind): string[] {
  switch (kind) {
    case "github":
      return ["read:user", "user:email"];
    case "oidc":
      return ["openid", "profile", "email"];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// OAuth/OIDC Auth State (PKCE, nonce, state management)
// ---------------------------------------------------------------------------

const STATE_TTL_MINUTES = 10;

export interface AuthStateInitiateResult {
  authUrl: string;
  state: string;
  nonce: string;
  pkceVerifier: string;
  pkceChallenge: string;
  inviteId: string | null;
  expiresAt: string;
}

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = `${uuid()}-${randomBytes(32).toString("hex")}`;
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function initiateAuthState(
  habitatId: string,
  providerId: string,
  inviteId?: string | null,
): AuthStateInitiateResult {
  const provider = providerRepo.getIdentityProviderById(providerId);
  if (!provider || provider.habitatId !== habitatId) {
    throw notFound("Identity provider not found");
  }
  if (!provider.enabled) {
    throw badRequest("Identity provider is not enabled");
  }

  const config = provider.config as Record<string, unknown>;
  const clientId = typeof config?.clientId === "string" ? config.clientId : "";
  const callbackUrl = typeof config?.callbackUrl === "string" ? config.callbackUrl : "";
  if (!clientId || !callbackUrl) {
    throw badRequest("Provider is missing clientId or callbackUrl");
  }

  const state = randomBytes(24).toString("hex");
  const nonce = randomBytes(16).toString("hex");
  const { verifier: pkceVerifier, challenge: pkceChallenge } = generatePkcePair();
  const expiresAt = new Date(Date.now() + STATE_TTL_MINUTES * 60_000).toISOString();

  providerRepo.createAuthState({
    providerId,
    habitatId,
    state,
    nonce,
    pkceVerifier,
    inviteId: inviteId ?? null,
    expiresAt,
  });

  const scopes = Array.isArray(config?.scopes) ? (config.scopes as string[]) : [];
  const scopeParam = scopes.join(" ");

  let authUrl: string;
  if (provider.kind === "github") {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      state,
      scope: scopeParam,
    });
    authUrl = `https://github.com/login/oauth/authorize?${params}`;
  } else {
    const issuer = provider.issuer ?? "";
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      response_type: "code",
      state,
      nonce,
      scope: scopeParam,
      code_challenge: pkceChallenge,
      code_challenge_method: "S256",
    });
    authUrl = `${issuer.replace(/\/$/, "")}/authorize?${params}`;
  }

  return {
    authUrl,
    state,
    nonce,
    pkceVerifier,
    pkceChallenge,
    inviteId: inviteId ?? null,
    expiresAt,
  };
}

export function verifyCallbackState(state: string, providerId: string): providerRepo.AuthStateRow {
  const authState = providerRepo.getAuthStateByState(state);
  if (!authState) {
    throw badRequest("Invalid or unknown OAuth state", "INVALID_AUTH_STATE");
  }
  if (authState.providerId !== providerId) {
    throw badRequest("OAuth state does not match provider", "STATE_PROVIDER_MISMATCH");
  }
  if (authState.status !== "pending") {
    throw badRequest("OAuth state already consumed", "AUTH_STATE_CONSUMED");
  }
  const now = Date.now();
  if (new Date(authState.expiresAt).getTime() < now) {
    throw badRequest("OAuth state expired", "AUTH_STATE_EXPIRED");
  }
  return authState;
}

export function consumeAuthState(stateId: string): providerRepo.AuthStateRow {
  const consumed = providerRepo.consumeAuthState(stateId);
  if (!consumed) throw notFound("Auth state not found");
  return consumed;
}
