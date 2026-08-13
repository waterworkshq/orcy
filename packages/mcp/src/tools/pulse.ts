import type { KanbanApiClient } from "../api.js";
import type { Agent, ExperienceCategory } from "@orcy/shared";
import { findingMetadataSchema, SIGNAL_TYPES } from "@orcy/shared";

/** Categories accepted by the `experience` param when `signalType === "experience"`. */
export const EXPERIENCE_CATEGORIES = [
  "stuck",
  "confused",
  "backtrack",
  "surprised",
  "ambiguous",
  "sidetracked",
  "smooth",
] as const satisfies readonly ExperienceCategory[];

/**
 * Resolves the `metadata.timing` stamp for an experience signal by inspecting the linked task's status.
 * Returns `"mid_task"` for `in_progress` (and any non-completion state), `"completion"` for `submitted`.
 * Falls back to `"mid_task"` when the task cannot be loaded or no `taskId` is provided.
 */
async function resolveExperienceTiming(
  client: KanbanApiClient,
  taskId?: string,
): Promise<"mid_task" | "completion"> {
  if (!taskId) return "mid_task";
  try {
    const { task } = await client.getTask(taskId);
    return task.status === "submitted" ? "completion" : "mid_task";
  } catch {
    return "mid_task";
  }
}

/**
 * @requires PulseClient
 * @requires AgentClient
 */
export async function pulsePost(
  client: KanbanApiClient,
  args: {
    missionId?: string;
    habitatId?: string;
    boardId?: string;
    scope?: "mission" | "habitat";
    signalType: (typeof SIGNAL_TYPES)[number];
    subject: string;
    body?: string;
    taskId?: string;
    toAgentName?: string;
    replyToId?: string;
    metadata?: Record<string, unknown>;
    experience?: ExperienceCategory;
  },
) {
  if (args.signalType === "detected") {
    throw new Error(
      "signalType 'detected' is reserved for plugin detector output and cannot be posted by agents",
    );
  }
  if (args.signalType === "experience" && !args.experience) {
    throw new Error("experience is required when signalType='experience'");
  }

  let toAgentId: string | undefined;
  if (args.toAgentName) {
    const agentsResp = await client.listAgents();
    const agents = Array.isArray(agentsResp.agents)
      ? (agentsResp.agents as Agent[])
      : (agentsResp.agents as { agent: Agent }[]).map((a) => a.agent);
    const found = agents.find((a) => a.name === args.toAgentName);
    if (!found) {
      throw new Error(`Agent with name "${args.toAgentName}" not found`);
    }
    toAgentId = found.id;
  }

  let metadata = args.metadata;
  if (args.signalType === "experience" && args.experience) {
    const timing = await resolveExperienceTiming(client, args.taskId);
    metadata = {
      ...metadata,
      implicit: true,
      experience: args.experience,
      timing,
    };
  }

  if (args.signalType === "finding") {
    const result = findingMetadataSchema.safeParse(metadata ?? {});
    if (!result.success) {
      const message = result.error.errors.map((issue) => issue.message).join("; ");
      throw new Error(`Invalid finding metadata: ${message}`);
    }
  }

  const isHabitat = args.scope === "habitat";

  if (isHabitat) {
    const habitatId = args.habitatId ?? args.boardId;
    if (!habitatId) {
      throw new Error("habitatId is required for habitat-scoped signals");
    }
    return client.postHabitatPulse(habitatId, {
      signalType: args.signalType,
      subject: args.subject,
      body: args.body,
      taskId: args.taskId,
      toAgentName: args.toAgentName,
      toAgentId,
      replyToId: args.replyToId,
      metadata,
    });
  }

  if (!args.missionId) {
    throw new Error(
      'missionId is required for mission-scoped signals (or use scope="habitat" with habitatId)',
    );
  }

  return client.postPulse(args.missionId, {
    signalType: args.signalType,
    subject: args.subject,
    body: args.body,
    taskId: args.taskId,
    toAgentName: args.toAgentName,
    toAgentId,
    replyToId: args.replyToId,
    metadata,
  });
}

/**
 * @requires PulseClient
 * @requires AgentClient
 */
export async function pulseCheck(
  client: KanbanApiClient,
  args: {
    missionId?: string;
    habitatId?: string;
    boardId?: string;
    scope?: "mission" | "habitat";
    signalType?: (typeof SIGNAL_TYPES)[number];
    limit?: number;
    offset?: number;
  },
) {
  const habitatId = args.habitatId ?? args.boardId;
  if (args.scope === "habitat" && habitatId) {
    return client.getHabitatPulses(habitatId, {
      signalType: args.signalType,
      scope: "habitat",
      limit: args.limit,
      offset: args.offset,
    });
  }

  if (args.missionId) {
    return client.getPulses(args.missionId, {
      signalType: args.signalType,
      limit: args.limit,
      offset: args.offset,
    });
  }

  return client.getPulseInbox({
    signalType: args.signalType,
    limit: args.limit,
    offset: args.offset,
  });
}
