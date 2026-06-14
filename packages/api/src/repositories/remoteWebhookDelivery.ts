import { getDb } from "../db/index.js";
import { remoteWebhookDeliveries } from "../db/schema/index.js";
import { eq, desc } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { repositoryCreateError, repositoryUpdateError } from "../errors/repository.js";

export interface CreateRemoteWebhookDeliveryInput {
  endpointId: string;
  habitatId: string;
  eventType: string;
  payload: string;
  signature: string;
}

export interface RemoteWebhookDeliveryRow {
  id: string;
  endpointId: string;
  habitatId: string;
  eventType: string;
  payload: string;
  signature: string;
  status: "pending" | "success" | "failed";
  statusCode: number | null;
  responseBody: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  createdAt: string;
}

export function createRemoteWebhookDelivery(
  input: CreateRemoteWebhookDeliveryInput,
): RemoteWebhookDeliveryRow {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();
  try {
    db.insert(remoteWebhookDeliveries)
      .values({
        id,
        endpointId: input.endpointId,
        habitatId: input.habitatId,
        eventType: input.eventType,
        payload: input.payload,
        signature: input.signature,
        status: "pending",
        attempts: 0,
        createdAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("remoteWebhookDelivery", err as Error, id);
  }
  return {
    id,
    endpointId: input.endpointId,
    habitatId: input.habitatId,
    eventType: input.eventType,
    payload: input.payload,
    signature: input.signature,
    status: "pending",
    statusCode: null,
    responseBody: null,
    attempts: 0,
    lastAttemptAt: null,
    nextRetryAt: null,
    createdAt: now,
  };
}

export function updateRemoteWebhookDeliveryStatus(
  id: string,
  status: "success" | "failed",
  statusCode: number | null,
  responseBody: string | null,
  attempts: number,
  nextRetryAt: string | null = null,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remoteWebhookDeliveries)
      .set({
        status,
        statusCode,
        responseBody,
        attempts,
        lastAttemptAt: now,
        nextRetryAt,
      })
      .where(eq(remoteWebhookDeliveries.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remoteWebhookDelivery", err as Error, id);
  }
}

export function listRemoteWebhookDeliveriesForEndpoint(
  endpointId: string,
  limit: number = 25,
): Omit<RemoteWebhookDeliveryRow, "signature">[] {
  const db = getDb();
  const rows = db
    .select()
    .from(remoteWebhookDeliveries)
    .where(eq(remoteWebhookDeliveries.endpointId, endpointId))
    .orderBy(desc(remoteWebhookDeliveries.createdAt))
    .limit(limit)
    .all();
  return (rows as unknown as RemoteWebhookDeliveryRow[]).map(
    ({ signature: _signature, ...rest }) => rest,
  );
}
