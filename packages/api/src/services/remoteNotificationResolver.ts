import * as grantRepo from "../repositories/remoteGrant.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import { isTargetVisibleToParticipant } from "./sharedGrantVisibilityService.js";
import type { NotificationEventType } from "@orcy/shared";
import type { RemoteParticipantContext } from "../middleware/remoteAuth.js";

/**
 * v0.19 Phase E — Remote notification resolver.
 *
 * Discovers which remote participants should receive a notification for a
 * given habitat event. The dispatch logic is:
 *
 * 1. Find all active grants in the habitat
 * 2. For each grant, check if the event's target (mission/task) is visible
 *    to the grantee via `isTargetVisibleToParticipant`
 * 3. If visible, the grant's participants are eligible recipients
 * 4. Return the deduplicated list of remote recipient descriptors
 *
 * The downstream notification pipeline (subscription resolution, delivery
 * creation) works unchanged — this function only adds the *source* of
 * remote participants. The caller (`notificationCommandService`) merges
 * these into the `explicitRecipients` argument before invoking
 * `resolveRecipients`.
 */

export interface RemoteEventContext {
  habitatId: string;
  eventType: NotificationEventType;
  targetType?: "task" | "mission" | "habitat";
  targetId?: string;
}

export interface DiscoveredRemoteRecipient {
  recipientType: "remote_human" | "remote_orcy";
  recipientId: string;
}

/**
 * Find all remote participants whose grants cover the event's target.
 * Returns deduplicated recipient descriptors.
 */
export function findRemoteRecipientsForEvent(ctx: RemoteEventContext): DiscoveredRemoteRecipient[] {
  const result: DiscoveredRemoteRecipient[] = [];
  const seen = new Set<string>();

  const grants = grantRepo.getActiveGrantsByHabitat(ctx.habitatId);

  for (const grant of grants) {
    // Build a synthetic context for visibility check
    const participant = grant.remoteParticipantId
      ? participantRepo.getRemoteParticipantById(grant.remoteParticipantId)
      : null;
    if (participant && participant.status !== "active") continue;

    if (ctx.targetType && ctx.targetId) {
      if (!isVisibleForGrant(grant, ctx.targetType, ctx.targetId)) continue;
    }

    // Pod-wide baseline grant (no specific participant) — every active
    // participant on the pod is eligible
    if (grant.remoteParticipantId === null) {
      const podParticipants = participantRepo.getRemoteParticipantsByPod(grant.remotePodId);
      for (const p of podParticipants) {
        if (p.status !== "active") continue;
        const key = `${p.participantType}:${p.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({
          recipientType: p.participantType === "remote_human" ? "remote_human" : "remote_orcy",
          recipientId: p.id,
        });
      }
    } else {
      // Per-participant grant
      if (!participant) continue;
      const key = `${participant.participantType}:${participant.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        recipientType:
          participant.participantType === "remote_human" ? "remote_human" : "remote_orcy",
        recipientId: participant.id,
      });
    }
  }

  return result;
}

/**
 * Visibility check that uses the grant's pod+participant instead of the
 * context's. We synthesize a minimal context for `isTargetVisibleToParticipant`
 * by pulling the pod+participant from the grant.
 */
function isVisibleForGrant(
  grant: grantRepo.RemoteGrantRow,
  targetType: "task" | "mission" | "habitat" | "label" | "domain" | "column",
  targetId: string,
): boolean {
  const pod = podRepo.getRemotePodById(grant.remotePodId);
  if (!pod) return false;

  let participant = grant.remoteParticipantId
    ? (participantRepo.getRemoteParticipantById(grant.remoteParticipantId) ?? null)
    : null;

  if (!participant) {
    // Pod-wide grant: pick any active participant on the pod for the
    // visibility check (the visibility logic is the same for all
    // participants of the pod anyway — they share the grants list).
    const podParticipants = participantRepo.getRemoteParticipantsByPod(grant.remotePodId);
    participant = podParticipants.find((p) => p.status === "active") ?? null;
  }
  if (!participant) return false;

  const syntheticCtx: RemoteParticipantContext = {
    participant,
    pod,
    credentialId: "",
    habitatId: grant.habitatId,
    grants: [grant],
  };
  return isTargetVisibleToParticipant(syntheticCtx, targetType, targetId).visible;
}
