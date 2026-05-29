import type { KanbanApiClient } from "../api.js";

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

export async function habitatSkillContribute(client: KanbanApiClient, args: Record<string, any>) {
  const boardId = args.boardId;
  const insight = args.insight;
  const skillCategory = args.skillCategory;

  if (!boardId) return { error: "Missing required parameter: boardId" };
  if (!insight) return { error: "Missing required parameter: insight" };

  return client.contributeHabitatSkill(boardId, { insight, skillCategory });
}
