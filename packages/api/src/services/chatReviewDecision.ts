import { findDecisionIntegration, type ChatIntegration } from "../repositories/chatIntegration.js";
import { getMapping, type ChatSpeakerMapping } from "../repositories/chatSpeakerMapping.js";
import { getUserById } from "../repositories/user.js";
import { getHabitatById } from "../repositories/habitat.js";
import { isTeamMemberByHabitatId } from "../repositories/teamMember.js";
import { authorizeTaskAction } from "../middleware/taskAuth.js";
import { setAuditActor } from "./auditProvenanceContext.js";
import { findTask } from "./chatService.js";
import * as taskService from "./tasks/task-lifecycle.js";
import { InterceptorVetoError } from "../errors.js";
import type { ChatReviewProvenance } from "./tasks/task-lifecycle.js";
import { logger } from "../lib/logger.js";

/** A chat review decision's provider-visible outcome. `applied` distinguishes a recorded (possibly partial) decision from a final one. */
export interface ChatDecisionResult {
  status: "refused" | "recorded" | "final";
  message: string;
}

/** Verified-ingress identity fields taken from the SIGNED provider body — never from config guesswork or the request channel. */
export interface ChatIngressIdentity {
  provider: "slack" | "discord";
  providerWorkspaceId?: string;
  channelId?: string;
  providerSpeakerId?: string;
}

function refuse(message: string): ChatDecisionResult {
  return { status: "refused", message };
}

interface ResolvedDecisionContext {
  integration: ChatIntegration;
  mapping: ChatSpeakerMapping;
  user: { id: string; username: string; displayName: string; role: string };
  habitatId: string;
}

/**
 * Authenticate-time-gated resolution of a chat speaker to a REAL local human:
 * exact (provider, signed workspace, non-null channel) tuple over enabled
 * integrations (ambiguous/unresolvable refuses — there is never an env
 * fallback), then an explicit speaker mapping, then the mapped user's
 * CURRENT role and habitat membership (never a snapshot). Any failure is a
 * refusal with zero writes.
 */
export function resolveChatDecisionContext(
  identity: ChatIngressIdentity,
): ResolvedDecisionContext | { refusal: string } {
  const workspaceId = identity.providerWorkspaceId?.trim();
  const channelId = identity.channelId?.trim();
  if (!workspaceId) {
    return {
      refusal:
        "This command must come from a workspace (team/guild) the Orcy integration is configured for.",
    };
  }
  if (!channelId) {
    return { refusal: "No channel in the request; review decisions require a configured channel." };
  }

  const integration = findDecisionIntegration(identity.provider, workspaceId, channelId);
  if (!integration) {
    return {
      refusal:
        "No chat integration is configured for this workspace and channel with review commands enabled. An Orcy admin must configure the workspace on the integration.",
    };
  }

  const speakerId = identity.providerSpeakerId?.trim();
  if (!speakerId) {
    return { refusal: "No speaker identity in the request; cannot attribute a review decision." };
  }

  const mapping = getMapping(integration.id, workspaceId, speakerId);
  if (!mapping) {
    return {
      refusal:
        "You are not mapped to an Orcy user for this workspace. Ask an Orcy admin to create a speaker mapping for you.",
    };
  }

  const user = getUserById(mapping.localUserId);
  if (!user) {
    return { refusal: "Your mapped Orcy user no longer exists; decision refused." };
  }
  if (user.role !== "admin" && user.role !== "editor") {
    return {
      refusal: `Your mapped Orcy user (${user.username}) does not currently hold reviewer authority (admin/editor); decision refused.`,
    };
  }

  const habitat = getHabitatById(integration.habitatId);
  if (!habitat) {
    return { refusal: "The integration's Orcy habitat no longer exists; decision refused." };
  }
  if (habitat.teamId && !isTeamMemberByHabitatId(integration.habitatId, user.id)) {
    return {
      refusal: `Your mapped Orcy user (${user.username}) is not a member of this habitat's team; decision refused.`,
    };
  }

  return { integration, mapping, user, habitatId: integration.habitatId };
}

function provenanceFor(
  integration: ChatIntegration,
  identity: ChatIngressIdentity,
): ChatReviewProvenance {
  return {
    chatIntegrationId: integration.id,
    provider: identity.provider,
    providerWorkspaceId: identity.providerWorkspaceId!.trim(),
    providerSpeakerId: identity.providerSpeakerId!.trim(),
  };
}

/**
 * Executes an `approve`/`reject` chat review decision as the MAPPED local
 * human through the canonical lifecycle service: same `authorizeTaskAction`
 * admission as the HTTP route, same reviewer-assignment and finality
 * semantics, human actor (ADR-0051 meter-exempt). Typed failures — veto,
 * state refusal, unresolved identity — surface as provider-visible refusal
 * text with zero mutation; never a 500, never a false success. A partial
 * multi-reviewer approval reports `recorded`, never final approval.
 */
export async function executeChatReviewDecision(
  identity: ChatIngressIdentity,
  action: "approve" | "reject",
  args: string[],
): Promise<ChatDecisionResult> {
  const resolved = resolveChatDecisionContext(identity);
  if ("refusal" in resolved) return refuse(resolved.refusal);
  const { integration, user, habitatId } = resolved;

  const taskIdOrShort = args[0];
  if (!taskIdOrShort) {
    return refuse(`Usage: /orcy ${action} <task-id>${action === "reject" ? " [reason]" : ""}`);
  }
  const reason = action === "reject" ? args.slice(1).join(" ") || "Rejected via chat command" : "";

  const task = findTask(habitatId, taskIdOrShort);
  if (!task) {
    return refuse(`Task not found: ${taskIdOrShort}`);
  }

  // Same principal gate as the HTTP route — the mapped human, with the role
  // read at decision time.
  const auth = authorizeTaskAction(
    task,
    { type: "human", id: user.id, role: user.role as "admin" | "editor" },
    action,
  );
  if (!auth.allowed) {
    return refuse(auth.reason ?? `You may not ${action} this task.`);
  }

  // The audit actor is the real local human; the speaker identifiers ride
  // the transition metadata (persisted on the task_events row).
  setAuditActor("human", user.id);
  const chatProvenance = provenanceFor(integration, identity);

  try {
    if (action === "approve") {
      const approved = taskService.approveTask(task.id, user.id, "human", chatProvenance);
      if (!approved) {
        return refuse(
          `Task "${task.title}" was not approved — it is not in review, or you are not an assigned reviewer for it.`,
        );
      }
      if (approved.status === "approved") {
        return { status: "final", message: `Task "${task.title}" approved` };
      }
      // Partial: the approval was recorded but other reviewers are still
      // pending — never claim final approval.
      return {
        status: "recorded",
        message: `Approval recorded for task "${task.title}" — the task is still in review (other reviewer approvals are pending).`,
      };
    }

    const rejected = taskService.rejectTask(task.id, user.id, reason, "human", chatProvenance);
    if (!rejected) {
      return refuse(
        `Task "${task.title}" was not rejected — it is not in review, or you are not an assigned reviewer for it.`,
      );
    }
    return { status: "final", message: `Task "${task.title}" rejected: ${reason}` };
  } catch (err) {
    if (err instanceof InterceptorVetoError) {
      return refuse(
        `Decision blocked by a lifecycle interceptor: ${err.veto.reason}. Nothing was recorded.`,
      );
    }
    logger.error({ err, taskId: task.id, action }, "Chat review decision failed");
    return refuse(
      `An internal error occurred while recording the decision on "${task.title}". The decision status is unknown — check the task in Orcy before retrying.`,
    );
  }
}
