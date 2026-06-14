import { createHmac } from "crypto";

/**
 * v0.19 Phase E — Compact remote webhook payload formatter.
 *
 * Per the Phase E spec (docs/plans/v19/phases/PHASE-E-visibility-audit.md):
 *
 * Compact payload fields:
 * - event type
 * - timestamp
 * - habitat/mission/task IDs where scoped
 * - actor summary with standing and affiliation
 * - grant/trust context ID
 * - follow-up API URL or route hint
 *
 * Full details require follow-up scoped API reads through /api/shared/*.
 *
 * The host attaches a HMAC-SHA256 signature header using the endpoint's
 * secret. The remote pod can verify authenticity without sharing a key
 * with anything but the host.
 */

export interface CompactRemoteWebhookPayload {
  schemaVersion: 1;
  eventType: string;
  occurredAt: string;
  habitatId: string;
  scope: {
    missionId?: string;
    taskId?: string;
    pulseId?: string;
  };
  actor: {
    type: "remote_human" | "remote_orcy";
    id: string;
    displayName: string;
    podId: string;
    podName: string;
  };
  grantContext: {
    grantId?: string;
    standing: "remote_observer" | "remote_contributor" | "remote_reviewer" | "trusted_remote_pod";
    actionKind: "advisory" | "execution" | "administrative";
  };
  summary: {
    title: string;
    body?: string;
  };
  followUp: {
    apiBase: string;
    path: string;
    description: string;
  };
  metadata?: Record<string, unknown>;
}

export interface CompactRemoteWebhookEventInput {
  eventType: string;
  occurredAt: string;
  habitatId: string;
  missionId?: string;
  taskId?: string;
  pulseId?: string;
  actor: CompactRemoteWebhookPayload["actor"];
  standing: CompactRemoteWebhookPayload["grantContext"]["standing"];
  actionKind: CompactRemoteWebhookPayload["grantContext"]["actionKind"];
  grantId?: string;
  title: string;
  body?: string;
  apiBase: string;
  followUpPath: string;
  followUpDescription: string;
  metadata?: Record<string, unknown>;
}

export function buildCompactRemoteWebhookPayload(
  input: CompactRemoteWebhookEventInput,
): CompactRemoteWebhookPayload {
  return {
    schemaVersion: 1,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    habitatId: input.habitatId,
    scope: {
      ...(input.missionId ? { missionId: input.missionId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.pulseId ? { pulseId: input.pulseId } : {}),
    },
    actor: input.actor,
    grantContext: {
      ...(input.grantId ? { grantId: input.grantId } : {}),
      standing: input.standing,
      actionKind: input.actionKind,
    },
    summary: {
      title: input.title,
      ...(input.body ? { body: input.body } : {}),
    },
    followUp: {
      apiBase: input.apiBase,
      path: input.followUpPath,
      description: input.followUpDescription,
    },
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

/**
 * Compute the HMAC-SHA256 signature for a compact payload using the
 * endpoint's signing secret. The remote pod verifies with the same
 * algorithm. The signature is hex-encoded and included as a header.
 */
export function signCompactRemoteWebhookPayload(
  payload: CompactRemoteWebhookPayload,
  secret: string,
): string {
  // Canonical string: JSON.stringify of the payload (sorted keys via
  // stable serialization). The signature input MUST match what the
  // remote pod re-computes.
  const stable = stableStringify(payload);
  return createHmac("sha256", secret).update(stable).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]));
  return "{" + parts.join(",") + "}";
}
