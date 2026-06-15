import { v4 as uuid } from "uuid";
import { generateSecret } from "../../utils/webhookSigning.js";
import {
  createWebhookSubscriptionRecord,
  deleteWebhookSubscriptionRecord,
  getWebhookSubscriptionRecordById,
  listWebhookSubscriptionRecords,
  updateWebhookSubscriptionRecord,
  updateWebhookSubscriptionSecret,
} from "../../repositories/webhookSubscription.js";

/** Represents a configured webhook subscription managed by the API service layer. */
export interface WebhookSubscription {
  id: string;
  habitatId: string | null;
  name: string;
  url: string;
  secret: string | null;
  events: string[];
  headers: Record<string, string>;
  format: "standard" | "slack" | "discord";
  enabled: number;
}

/** Creates a new webhook subscription with a generated signing secret and persists it. */
export function createWebhookSubscription(
  habitatId: string | null,
  name: string,
  url: string,
  format: "standard" | "slack" | "discord",
  events: string[],
  headers: Record<string, string>,
): WebhookSubscription {
  const id = uuid();
  const secret = generateSecret();

  return createWebhookSubscriptionRecord({
    id,
    habitatId,
    name,
    url,
    secret,
    events,
    headers,
    format,
  });
}

/** Returns all webhook subscriptions for the given habitat, or every subscription when none is specified. */
export function getWebhookSubscriptions(habitatId?: string | null): WebhookSubscription[] {
  return listWebhookSubscriptionRecords(habitatId);
}

/** Finds a single webhook subscription by its ID. */
export function getWebhookSubscriptionById(id: string): WebhookSubscription | null {
  return getWebhookSubscriptionRecordById(id);
}

/** Applies partial updates to an existing webhook subscription and persists the changes. */
export function updateWebhookSubscription(
  id: string,
  updates: {
    name?: string;
    url?: string;
    format?: "standard" | "slack" | "discord";
    events?: string[];
    headers?: Record<string, string>;
    enabled?: boolean;
  },
): boolean {
  const existing = getWebhookSubscriptionById(id);
  if (!existing) return false;

  const name = updates.name ?? existing.name;
  const url = updates.url ?? existing.url;
  const format = updates.format ?? existing.format;
  const events = updates.events !== undefined ? updates.events : existing.events;
  const headers = updates.headers !== undefined ? updates.headers : existing.headers;
  const enabled = updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : existing.enabled;

  updateWebhookSubscriptionRecord(id, { name, url, format, events, headers, enabled });

  return true;
}

/** Deletes a webhook subscription by ID if it exists. */
export function deleteWebhookSubscription(id: string): boolean {
  const existing = getWebhookSubscriptionById(id);
  if (!existing) return false;

  deleteWebhookSubscriptionRecord(id);

  return true;
}

/** Generates and stores a new signing secret for an existing webhook subscription. */
export function rotateWebhookSecret(id: string): string | null {
  const existing = getWebhookSubscriptionById(id);
  if (!existing) return null;

  const newSecret = generateSecret();
  updateWebhookSubscriptionSecret(id, newSecret);

  return newSecret;
}
