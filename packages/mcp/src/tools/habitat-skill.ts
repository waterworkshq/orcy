import type { KanbanApiClient } from "../api.js";
import type { SkillClient } from "../api/interfaces.js";

export async function habitatSkillGet(client: KanbanApiClient, args: Record<string, any>) {
  const boardId = args.boardId;
  if (!boardId) return { error: "Missing required parameter: boardId" };
  return client.getHabitatSkill(boardId);
}

export async function habitatSkillRefresh(client: KanbanApiClient, args: Record<string, any>) {
  const boardId = args.boardId;
  if (!boardId) return { error: "Missing required parameter: boardId" };
  return client.refreshHabitatSkill(boardId);
}

const VALID_CATEGORIES = ["convention", "pattern", "pitfall", "domain_knowledge", "agent_insight"];

export async function habitatSkillContribute(client: KanbanApiClient, args: Record<string, any>) {
  const boardId = args.boardId;
  const insight = args.insight;
  const skillCategory = args.skillCategory;

  if (!boardId) return { error: "Missing required parameter: boardId" };
  if (!insight) return { error: "Missing required parameter: insight" };
  if (skillCategory && !VALID_CATEGORIES.includes(skillCategory)) {
    return { error: `Invalid skillCategory. Must be one of: ${VALID_CATEGORIES.join(", ")}` };
  }

  return client.contributeHabitatSkill(boardId, { insight, skillCategory });
}
