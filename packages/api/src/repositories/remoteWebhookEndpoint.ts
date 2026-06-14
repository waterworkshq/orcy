import { getDb } from "../db/index.js";
import { remoteWebhookEndpoints } from "../db/schema/index.js";
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";
import type { RemoteWebhookEndpointStatus } from "@orcy/shared/types";

export interface CreateRemoteWebhookEndpointInput {
  remotePodId: string;
  habitatId: string;
  url: string;
  description?: string;
  events?: string[];
  secretHash?: string | null;
  encryptedSecret?: string | null;
}

export interface RemoteWebhookEndpointRow {
  id: string;
  remotePodId: string;
  habitatId: string;
  url: string;
  description: string;
  events: string[];
  status: string;
  secretHash: string | null;
  encryptedSecret: string | null;
  lastTestAt: string | null;
  lastTestStatus: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  enabledBy: string | null;
  enabledAt: string | null;
  rejectedAt: string | null;
  rejectedBy: string | null;
  rejectReason: string | null;
  createdAt: string;
  updatedAt: string;
}

const fields = {
  id: remoteWebhookEndpoints.id,
  remotePodId: remoteWebhookEndpoints.remotePodId,
  habitatId: remoteWebhookEndpoints.habitatId,
  url: remoteWebhookEndpoints.url,
  description: remoteWebhookEndpoints.description,
  events: remoteWebhookEndpoints.events,
  status: remoteWebhookEndpoints.status,
  secretHash: remoteWebhookEndpoints.secretHash,
  encryptedSecret: remoteWebhookEndpoints.encryptedSecret,
  lastTestAt: remoteWebhookEndpoints.lastTestAt,
  lastTestStatus: remoteWebhookEndpoints.lastTestStatus,
  approvedBy: remoteWebhookEndpoints.approvedBy,
  approvedAt: remoteWebhookEndpoints.approvedAt,
  enabledBy: remoteWebhookEndpoints.enabledBy,
  enabledAt: remoteWebhookEndpoints.enabledAt,
  rejectedAt: remoteWebhookEndpoints.rejectedAt,
  rejectedBy: remoteWebhookEndpoints.rejectedBy,
  rejectReason: remoteWebhookEndpoints.rejectReason,
  createdAt: remoteWebhookEndpoints.createdAt,
  updatedAt: remoteWebhookEndpoints.updatedAt,
} as const;

export function createRemoteWebhookEndpoint(
  input: CreateRemoteWebhookEndpointInput,
): RemoteWebhookEndpointRow {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(remoteWebhookEndpoints)
      .values({
        id,
        remotePodId: input.remotePodId,
        habitatId: input.habitatId,
        url: input.url,
        description: input.description ?? "",
        events: input.events ?? [],
        status: "pending",
        secretHash: input.secretHash ?? null,
        encryptedSecret: input.encryptedSecret ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("remoteWebhookEndpoint", err as Error, id);
  }

  const row = getRemoteWebhookEndpointById(id);
  if (!row) throw repositoryNotFoundError("remoteWebhookEndpoint", id);
  return row;
}

export function getRemoteWebhookEndpointById(id: string): RemoteWebhookEndpointRow | null {
  const db = getDb();
  const rows = db
    .select(fields)
    .from(remoteWebhookEndpoints)
    .where(eq(remoteWebhookEndpoints.id, id))
    .all();
  return rows.length > 0 ? rows[0] : null;
}

export function getRemoteWebhookEndpointsByPod(
  remotePodId: string,
  status?: RemoteWebhookEndpointStatus,
): RemoteWebhookEndpointRow[] {
  const db = getDb();
  const condition = status
    ? and(
        eq(remoteWebhookEndpoints.remotePodId, remotePodId),
        eq(remoteWebhookEndpoints.status, status),
      )
    : eq(remoteWebhookEndpoints.remotePodId, remotePodId);
  return db.select(fields).from(remoteWebhookEndpoints).where(condition).all();
}

export function getEnabledWebhookEndpoints(habitatId: string): RemoteWebhookEndpointRow[] {
  const db = getDb();
  return db
    .select(fields)
    .from(remoteWebhookEndpoints)
    .where(
      and(
        eq(remoteWebhookEndpoints.habitatId, habitatId),
        eq(remoteWebhookEndpoints.status, "enabled"),
      ),
    )
    .all();
}

export function approveRemoteWebhookEndpoint(
  id: string,
  approvedBy: string,
): RemoteWebhookEndpointRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remoteWebhookEndpoints)
      .set({ status: "approved", approvedBy, approvedAt: now, updatedAt: now })
      .where(eq(remoteWebhookEndpoints.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remoteWebhookEndpoint", err as Error, id);
  }
  return getRemoteWebhookEndpointById(id);
}

export function enableRemoteWebhookEndpoint(
  id: string,
  enabledBy: string,
): RemoteWebhookEndpointRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remoteWebhookEndpoints)
      .set({ status: "enabled", enabledBy, enabledAt: now, updatedAt: now })
      .where(eq(remoteWebhookEndpoints.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remoteWebhookEndpoint", err as Error, id);
  }
  return getRemoteWebhookEndpointById(id);
}

export function disableRemoteWebhookEndpoint(id: string): RemoteWebhookEndpointRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remoteWebhookEndpoints)
      .set({ status: "disabled", updatedAt: now })
      .where(eq(remoteWebhookEndpoints.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remoteWebhookEndpoint", err as Error, id);
  }
  return getRemoteWebhookEndpointById(id);
}

export function rejectRemoteWebhookEndpoint(
  id: string,
  rejectedBy: string,
  rejectReason?: string,
): RemoteWebhookEndpointRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remoteWebhookEndpoints)
      .set({
        status: "rejected",
        rejectedAt: now,
        rejectedBy,
        rejectReason: rejectReason ?? null,
        updatedAt: now,
      })
      .where(eq(remoteWebhookEndpoints.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remoteWebhookEndpoint", err as Error, id);
  }
  return getRemoteWebhookEndpointById(id);
}

export function updateWebhookTestResult(
  id: string,
  lastTestStatus: string,
): RemoteWebhookEndpointRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remoteWebhookEndpoints)
      .set({ lastTestAt: now, lastTestStatus, updatedAt: now })
      .where(eq(remoteWebhookEndpoints.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remoteWebhookEndpoint", err as Error, id);
  }
  return getRemoteWebhookEndpointById(id);
}

export interface UpdateRemoteWebhookEndpointInput {
  url?: string;
  description?: string;
  events?: string[];
}

export function updateRemoteWebhookEndpoint(
  id: string,
  input: UpdateRemoteWebhookEndpointInput,
): RemoteWebhookEndpointRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  const patch: Partial<typeof remoteWebhookEndpoints.$inferInsert> = {
    updatedAt: now,
  };
  if (input.url !== undefined) patch.url = input.url;
  if (input.description !== undefined) patch.description = input.description;
  if (input.events !== undefined) patch.events = input.events;
  try {
    db.update(remoteWebhookEndpoints).set(patch).where(eq(remoteWebhookEndpoints.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("remoteWebhookEndpoint", err as Error, id);
  }
  return getRemoteWebhookEndpointById(id);
}

export function deleteRemoteWebhookEndpoint(id: string): boolean {
  const db = getDb();
  try {
    db.delete(remoteWebhookEndpoints).where(eq(remoteWebhookEndpoints.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("remoteWebhookEndpoint", err as Error, id);
  }
  return true;
}
