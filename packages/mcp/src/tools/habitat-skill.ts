import type { SkillClient } from "../api/interfaces.js";
import { SKILL_CATEGORIES } from "@orcy/shared";

/**
 * @requires SkillClient
 */
export async function habitatSkillGet(client: SkillClient, args: Record<string, any>) {
  const habitatId = args.habitatId ?? args.boardId;
  if (!habitatId) return { error: "Missing required parameter: habitatId" };
  return client.getHabitatSkill(habitatId);
}

/**
 * @requires SkillClient
 */
export async function habitatSkillRefresh(client: SkillClient, args: Record<string, any>) {
  const habitatId = args.habitatId ?? args.boardId;
  if (!habitatId) return { error: "Missing required parameter: habitatId" };
  return client.refreshHabitatSkill(habitatId);
}

const VALID_CATEGORIES = SKILL_CATEGORIES;

/**
 * @requires SkillClient
 */
export async function habitatSkillContribute(client: SkillClient, args: Record<string, any>) {
  const habitatId = args.habitatId ?? args.boardId;
  const insight = args.insight;
  const skillCategory = args.skillCategory;

  if (!habitatId) return { error: "Missing required parameter: habitatId" };
  if (!insight) return { error: "Missing required parameter: insight" };
  if (skillCategory && !VALID_CATEGORIES.includes(skillCategory)) {
    return { error: `Invalid skillCategory. Must be one of: ${VALID_CATEGORIES.join(", ")}` };
  }

  return client.contributeHabitatSkill(habitatId, { insight, skillCategory });
}
