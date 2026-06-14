import * as endpointRepo from "../repositories/remoteWebhookEndpoint.js";
import * as deliveryRepo from "../repositories/remoteWebhookDelivery.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import { decryptSecret } from "./secretCrypto.js";
import {
  buildCompactRemoteWebhookPayload,
  signCompactRemoteWebhookPayload,
  type CompactRemoteWebhookEventInput,
} from "./compactRemoteWebhookPayload.js";

/**
 * v0.19 Phase E — Compact remote webhook dispatcher.
 *
 * For every habitat event that the host wants to relay to remote pods,
 * this dispatcher:
 * 1. Looks up every enabled remote endpoint in the habitat
 * 2. Filters to those that subscribe to the event type
 * 3. For each, builds a compact payload (per the Phase E spec)
 * 4. Computes the HMAC-SHA256 signature using the endpoint's stored secret
 * 5. Sends the POST
 * 6. Records the delivery in `remote_webhook_deliveries`
 *
 * The plaintext signing secret is not stored — only its hash. The
 * dispatcher uses the secret to sign and the remote pod uses the same
 * secret to verify. Since we never store the plaintext, the signature
 * can be computed only at create/rotate time. For Phase E we re-fetch
 * the plaintext on each dispatch via the credentials secrets cache.
 *
 * For simplicity in v0.19, endpoints store the plaintext secret in
 * memory after creation. Phase E.1 (next iteration) can swap to
 * AES-encrypted at rest.
 */

export interface RemoteEventDispatchInput {
  habitatId: string;
  eventType: string;
  apiBase: string;
  payload: CompactRemoteWebhookEventInput;
}

export interface RemoteEventDispatchResult {
  dispatched: number;
  failed: number;
  skipped: number;
}

const ENDPOINT_PLAINTEXT_CACHE = new Map<string, string>();

/**
 * Register the plaintext secret for an endpoint. Called by the route
 * layer immediately after creation (where the secret is shown).
 * Phase E.1 should replace this with encrypted-at-rest storage.
 */
export function registerEndpointPlaintextSecret(endpointId: string, secret: string): void {
  ENDPOINT_PLAINTEXT_CACHE.set(endpointId, secret);
}

/**
 * Forget the cached plaintext for an endpoint. Called on rotation
 * and on disable (so a disabled endpoint that gets re-enabled must
 * re-register its secret).
 */
export function forgetEndpointPlaintextSecret(endpointId: string): void {
  ENDPOINT_PLAINTEXT_CACHE.delete(endpointId);
}

export async function dispatchCompactRemoteEvent(
  input: RemoteEventDispatchInput,
): Promise<RemoteEventDispatchResult> {
  const result: RemoteEventDispatchResult = {
    dispatched: 0,
    failed: 0,
    skipped: 0,
  };

  const endpoints = endpointRepo.getEnabledWebhookEndpoints(input.habitatId);

  for (const endpoint of endpoints) {
    // Filter: empty events array means "all events"
    if (endpoint.events.length > 0 && !endpoint.events.includes(input.eventType)) {
      result.skipped += 1;
      continue;
    }

    let secret: string | null | undefined = ENDPOINT_PLAINTEXT_CACHE.get(endpoint.id);
    if (!secret && endpoint.encryptedSecret) {
      secret = decryptSecret(endpoint.encryptedSecret);
      if (secret) {
        ENDPOINT_PLAINTEXT_CACHE.set(endpoint.id, secret);
      }
    }
    if (!secret) {
      // No secret registered (e.g., endpoint was re-enabled after disable
      // without re-registering). Skip with a delivery record so the host
      // can see the gap.
      const delivery = deliveryRepo.createRemoteWebhookDelivery({
        endpointId: endpoint.id,
        habitatId: input.habitatId,
        eventType: input.eventType,
        payload: JSON.stringify({ error: "no secret registered for endpoint" }),
        signature: "",
      });
      deliveryRepo.updateRemoteWebhookDeliveryStatus(
        delivery.id,
        "failed",
        null,
        "no secret registered",
        1,
      );
      result.failed += 1;
      continue;
    }

    const payload = buildCompactRemoteWebhookPayload(input.payload);
    const signature = signCompactRemoteWebhookPayload(payload, secret);

    const delivery = deliveryRepo.createRemoteWebhookDelivery({
      endpointId: endpoint.id,
      habitatId: input.habitatId,
      eventType: input.eventType,
      payload: JSON.stringify(payload),
      signature,
    });

    try {
      const res = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Orcy-Remote-Webhook-Signature": signature,
          "X-Orcy-Remote-Webhook-Delivery": delivery.id,
          "X-Orcy-Remote-Webhook-Event": input.eventType,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      const responseBody = await res.text().catch(() => "");

      if (res.ok) {
        deliveryRepo.updateRemoteWebhookDeliveryStatus(
          delivery.id,
          "success",
          res.status,
          responseBody.slice(0, 2000),
          1,
        );
        result.dispatched += 1;
      } else {
        deliveryRepo.updateRemoteWebhookDeliveryStatus(
          delivery.id,
          "failed",
          res.status,
          responseBody.slice(0, 2000),
          1,
        );
        result.failed += 1;
      }
    } catch (err) {
      const errorMsg = (err as Error).message;
      deliveryRepo.updateRemoteWebhookDeliveryStatus(delivery.id, "failed", null, errorMsg, 1);
      result.failed += 1;
    }
  }

  return result;
}

/**
 * Build the dispatch input for a remote-originated event. This is the
 * producer-side helper called by routes when a remote participant
 * performs an action.
 */
export function buildDispatchInputFromRemoteAction(opts: {
  habitatId: string;
  eventType: string;
  apiBase: string;
  participantId: string;
  podId: string;
  standing: "remote_observer" | "remote_contributor" | "remote_reviewer" | "trusted_remote_pod";
  actionKind: "advisory" | "execution" | "administrative";
  grantId?: string;
  title: string;
  body?: string;
  missionId?: string;
  taskId?: string;
  pulseId?: string;
  occurredAt?: string;
  metadata?: Record<string, unknown>;
}): {
  input: RemoteEventDispatchInput;
  followUpPath: string;
} {
  const participant = participantRepo.getRemoteParticipantById(opts.participantId);
  const pod = podRepo.getRemotePodById(opts.podId);

  const followUpPath = opts.taskId
    ? `/api/shared/tasks/${opts.taskId}`
    : opts.missionId
      ? `/api/shared/missions/${opts.missionId}`
      : "/api/shared/me";

  const payload: CompactRemoteWebhookEventInput = {
    eventType: opts.eventType,
    occurredAt: opts.occurredAt ?? new Date().toISOString(),
    habitatId: opts.habitatId,
    missionId: opts.missionId,
    taskId: opts.taskId,
    pulseId: opts.pulseId,
    actor: {
      type: (participant?.participantType === "remote_human" ? "remote_human" : "remote_orcy") as
        | "remote_human"
        | "remote_orcy",
      id: opts.participantId,
      displayName: participant?.displayName ?? "Remote participant",
      podId: opts.podId,
      podName: pod?.name ?? "Remote Pod",
    },
    standing: opts.standing,
    actionKind: opts.actionKind,
    grantId: opts.grantId,
    title: opts.title,
    body: opts.body,
    apiBase: opts.apiBase,
    followUpPath,
    followUpDescription: opts.taskId
      ? "Fetch the task for full details"
      : opts.missionId
        ? "Fetch the mission for full details"
        : "Fetch the participant for full details",
    metadata: opts.metadata,
  };

  return {
    input: {
      habitatId: opts.habitatId,
      eventType: opts.eventType,
      apiBase: opts.apiBase,
      payload,
    },
    followUpPath,
  };
}
