import { getDb } from '../db/index.js';
import { integrationConnections } from '../db/schema/index.js';
import { eq, and } from 'drizzle-orm';
import type { IntegrationConnection, IntegrationConnectionView, IntegrationProvider, IntegrationAuthMethod, IntegrationSyncStatus } from '@orcy/shared';
import { v4 as uuid } from 'uuid';

export function create(input: {
  habitatId: string;
  provider: IntegrationProvider;
  name: string;
  authMethod: IntegrationAuthMethod;
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenExpiresAt?: string | null;
  externalAccountId?: string | null;
  externalAccountName?: string | null;
  externalTenantId?: string | null;
  externalTenantName?: string | null;
  externalBaseUrl?: string | null;
  repositoryOwner?: string | null;
  repositoryName?: string | null;
  projectKey?: string | null;
  teamId?: string | null;
  providerConfig?: Record<string, unknown>;
  enabled?: boolean;
  pullEnabled?: boolean;
  autoImport?: boolean;
  webhookSecret?: string | null;
  webhookExternalId?: string | null;
  createdBy: string;
}): IntegrationConnection {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(integrationConnections).values({
    id,
    habitatId: input.habitatId,
    provider: input.provider,
    name: input.name,
    authMethod: input.authMethod,
    accessToken: input.accessToken ?? null,
    refreshToken: input.refreshToken ?? null,
    tokenExpiresAt: input.tokenExpiresAt ?? null,
    externalAccountId: input.externalAccountId ?? null,
    externalAccountName: input.externalAccountName ?? null,
    externalTenantId: input.externalTenantId ?? null,
    externalTenantName: input.externalTenantName ?? null,
    externalBaseUrl: input.externalBaseUrl ?? null,
    repositoryOwner: input.repositoryOwner ?? null,
    repositoryName: input.repositoryName ?? null,
    projectKey: input.projectKey ?? null,
    teamId: input.teamId ?? null,
    providerConfig: input.providerConfig ?? {},
    enabled: input.enabled ?? true,
    pullEnabled: input.pullEnabled ?? true,
    autoImport: input.autoImport ?? false,
    webhookSecret: input.webhookSecret ?? null,
    webhookExternalId: input.webhookExternalId ?? null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  }).run();

  const result = getById(id);
  if (!result) throw new Error('Failed to create integration connection');
  return result;
}

export function getById(id: string): IntegrationConnection | null {
  const db = getDb();
  return db.select().from(integrationConnections).where(eq(integrationConnections.id, id)).get() as IntegrationConnection | null;
}

export function listByHabitat(habitatId: string): IntegrationConnection[] {
  const db = getDb();
  return db.select().from(integrationConnections).where(eq(integrationConnections.habitatId, habitatId)).all() as IntegrationConnection[];
}

export function listEnabledByProvider(provider: IntegrationProvider): IntegrationConnection[] {
  const db = getDb();
  return db.select().from(integrationConnections)
    .where(and(eq(integrationConnections.provider, provider), eq(integrationConnections.enabled, true)))
    .all() as IntegrationConnection[];
}

export function listEnabledByProviderAndRepo(provider: IntegrationProvider, owner: string, repo: string): IntegrationConnection[] {
  const db = getDb();
  return db.select().from(integrationConnections)
    .where(and(
      eq(integrationConnections.provider, provider),
      eq(integrationConnections.enabled, true),
      eq(integrationConnections.repositoryOwner, owner),
      eq(integrationConnections.repositoryName, repo),
    ))
    .all() as IntegrationConnection[];
}

export function update(id: string, input: {
  name?: string;
  enabled?: boolean;
  pullEnabled?: boolean;
  autoImport?: boolean;
  webhookSecret?: string | null;
  webhookExternalId?: string | null;
  lastSyncAt?: string | null;
  lastSyncStatus?: IntegrationSyncStatus;
  lastSyncError?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenExpiresAt?: string | null;
  externalAccountId?: string | null;
  externalAccountName?: string | null;
}): IntegrationConnection | null {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = getById(id);
  if (!existing) return null;

  const values: Partial<typeof integrationConnections.$inferInsert> = { updatedAt: now };
  if (input.name !== undefined) values.name = input.name;
  if (input.enabled !== undefined) values.enabled = input.enabled;
  if (input.pullEnabled !== undefined) values.pullEnabled = input.pullEnabled;
  if (input.autoImport !== undefined) values.autoImport = input.autoImport;
  if (input.webhookSecret !== undefined) values.webhookSecret = input.webhookSecret;
  if (input.webhookExternalId !== undefined) values.webhookExternalId = input.webhookExternalId;
  if (input.lastSyncAt !== undefined) values.lastSyncAt = input.lastSyncAt;
  if (input.lastSyncStatus !== undefined) values.lastSyncStatus = input.lastSyncStatus;
  if (input.lastSyncError !== undefined) values.lastSyncError = input.lastSyncError;
  if (input.accessToken !== undefined) values.accessToken = input.accessToken;
  if (input.refreshToken !== undefined) values.refreshToken = input.refreshToken;
  if (input.tokenExpiresAt !== undefined) values.tokenExpiresAt = input.tokenExpiresAt;
  if (input.externalAccountId !== undefined) values.externalAccountId = input.externalAccountId;
  if (input.externalAccountName !== undefined) values.externalAccountName = input.externalAccountName;

  db.update(integrationConnections).set(values).where(eq(integrationConnections.id, id)).run();
  return getById(id);
}

export function disable(id: string): IntegrationConnection | null {
  return update(id, { enabled: false });
}

export function toView(connection: IntegrationConnection): IntegrationConnectionView {
  return {
    id: connection.id,
    habitatId: connection.habitatId,
    provider: connection.provider,
    name: connection.name,
    authMethod: connection.authMethod,
    hasAccessToken: connection.accessToken !== null && connection.accessToken !== '',
    hasRefreshToken: connection.refreshToken !== null && connection.refreshToken !== '',
    hasWebhookSecret: connection.webhookSecret !== null && connection.webhookSecret !== '',
    externalAccountId: connection.externalAccountId,
    externalAccountName: connection.externalAccountName,
    externalTenantId: connection.externalTenantId,
    externalTenantName: connection.externalTenantName,
    externalBaseUrl: connection.externalBaseUrl,
    repositoryOwner: connection.repositoryOwner,
    repositoryName: connection.repositoryName,
    projectKey: connection.projectKey,
    teamId: connection.teamId,
    providerConfig: connection.providerConfig,
    enabled: connection.enabled,
    pullEnabled: connection.pullEnabled,
    autoImport: connection.autoImport,
    webhookExternalId: connection.webhookExternalId,
    lastSyncAt: connection.lastSyncAt,
    lastSyncStatus: connection.lastSyncStatus,
    lastSyncError: connection.lastSyncError,
    createdBy: connection.createdBy,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    tokenExpiresAt: connection.tokenExpiresAt,
  };
}
