import * as taskRepo from "../repositories/task.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as sprintRepo from "../repositories/sprint.js";
import type {
  AutomationTriggerContext,
  AutomationTargetType,
  Task,
  Mission,
  Agent,
  Habitat,
  Sprint,
} from "@orcy/shared";

/** Resolved automation evaluation context holding the entities and diagnostics needed to evaluate rule conditions. */
export interface AutomationEvaluationContext {
  habitat: Habitat | null;
  task: Task | null;
  mission: Mission | null;
  agent: Agent | null;
  sprint: Sprint | null;
  warnings: string[];
  missingFields: string[];
  raw: Record<string, unknown>;
}

/** Loads all entities referenced by an automation trigger into an evaluation context, recording missing references as warnings. */
export function buildEvaluationContext(
  trigger: AutomationTriggerContext,
): AutomationEvaluationContext {
  const warnings: string[] = [];
  const missingFields: string[] = [];

  const habitat = habitatRepo.getHabitatById(trigger.habitatId);
  if (!habitat) {
    missingFields.push("habitat");
  }

  let task: Task | null = null;
  let mission: Mission | null = null;
  let agent: Agent | null = null;
  let sprint: Sprint | null = null;

  if (trigger.targetType === "task" && trigger.targetId) {
    task = taskRepo.getTaskById(trigger.targetId);
    if (!task) {
      missingFields.push("task");
    } else {
      mission = missionRepo.getMissionById(task.missionId);
      if (!mission) {
        missingFields.push("mission");
      } else {
        if (mission.sprintId) {
          sprint = sprintRepo.getById(mission.sprintId);
          if (!sprint) warnings.push("Sprint not found for task mission");
        }
      }
      if (task.assignedAgentId) {
        const foundAgent = agentRepo.getAgentById(task.assignedAgentId);
        agent = foundAgent ? (foundAgent as unknown as Agent) : null;
        if (!agent) warnings.push("Assigned agent not found");
      }
    }
  } else if (trigger.targetType === "mission" && trigger.targetId) {
    mission = missionRepo.getMissionById(trigger.targetId);
    if (!mission) {
      missingFields.push("mission");
    } else {
      if (mission.sprintId) {
        sprint = sprintRepo.getById(mission.sprintId);
      }
    }
  } else if (trigger.targetType === "agent" && trigger.targetId) {
    const foundAgent = agentRepo.getAgentById(trigger.targetId);
    agent = foundAgent ? (foundAgent as unknown as Agent) : null;
    if (!agent) {
      missingFields.push("agent");
    }
  } else if (trigger.targetType === "sprint" && trigger.targetId) {
    sprint = sprintRepo.getById(trigger.targetId);
    if (!sprint) {
      missingFields.push("sprint");
    }
  } else if (trigger.targetType === "habitat" && trigger.targetId) {
    // habitat already loaded
  }

  return {
    habitat,
    task,
    mission,
    agent,
    sprint,
    warnings,
    missingFields,
    raw: trigger.payload,
  };
}

/** Constructs an automation trigger context from individual arguments, applying defaults for optional fields. */
export function buildTriggerContext(args: {
  triggerType: string;
  triggerEventId: string | null;
  habitatId: string;
  targetType?: AutomationTargetType | null;
  targetId?: string | null;
  payload?: Record<string, unknown>;
  causalContext?: AutomationTriggerContext["causalContext"];
}): AutomationTriggerContext {
  return {
    triggerType: args.triggerType as AutomationTriggerContext["triggerType"],
    triggerEventId: args.triggerEventId ?? null,
    habitatId: args.habitatId,
    targetType: args.targetType ?? "none",
    targetId: args.targetId ?? null,
    payload: args.payload ?? {},
    causalContext: args.causalContext,
  };
}
