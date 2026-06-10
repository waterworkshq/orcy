import { getDb } from "../db/index.js";
import { automationRules } from "../db/schema/index.js";
import { eq, and, asc, desc, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
  repositoryDeleteError,
} from "../errors/repository.js";
import type {
  AutomationRule,
  AutomationTrigger,
  AutomationCondition,
  AutomationAction,
  CreateAutomationRuleInput,
  UpdateAutomationRuleInput,
  AutomationTriggerType,
} from "@orcy/shared";

export function createAutomationRule(input: CreateAutomationRuleInput): AutomationRule {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(automationRules)
      .values({
        id,
        habitatId: input.habitatId,
        name: input.name,
        description: input.description ?? "",
        enabled: input.enabled ?? false,
        priority: input.priority ?? 0,
        trigger: input.trigger as unknown as Record<string, unknown>,
        condition: (input.condition ?? { type: "always" }) as unknown as Record<string, unknown>,
        actions: input.actions as unknown as Record<string, unknown>[],
        cooldownSeconds: input.cooldownSeconds ?? 300,
        maxRunsPerHour: input.maxRunsPerHour ?? 30,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
        lastRunAt: null,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("automationRule", err as Error, id);
  }

  const created = getAutomationRuleById(id);
  if (!created) throw repositoryNotFoundError("automationRule", id);
  return created;
}

export function getAutomationRuleById(id: string): AutomationRule | null {
  const db = getDb();
  const row = db.select().from(automationRules).where(eq(automationRules.id, id)).get();
  return row ? (row as unknown as AutomationRule) : null;
}

export function listAutomationRulesByHabitat(habitatId: string): AutomationRule[] {
  const db = getDb();
  return db
    .select()
    .from(automationRules)
    .where(eq(automationRules.habitatId, habitatId))
    .orderBy(asc(automationRules.priority))
    .all() as unknown as AutomationRule[];
}

export function getEnabledRulesByHabitat(habitatId: string): AutomationRule[] {
  const db = getDb();
  return db
    .select()
    .from(automationRules)
    .where(and(eq(automationRules.habitatId, habitatId), eq(automationRules.enabled, true)))
    .orderBy(asc(automationRules.priority))
    .all() as unknown as AutomationRule[];
}

export function getEnabledRulesByHabitatAndTrigger(
  habitatId: string,
  triggerType: AutomationTriggerType,
): AutomationRule[] {
  const db = getDb();
  return db
    .select()
    .from(automationRules)
    .where(and(eq(automationRules.habitatId, habitatId), eq(automationRules.enabled, true)))
    .orderBy(asc(automationRules.priority))
    .all()
    .filter((rule) =>
      matchesTriggerType(rule as unknown as AutomationRule, triggerType),
    ) as unknown as AutomationRule[];
}

function matchesTriggerType(rule: AutomationRule, triggerType: AutomationTriggerType): boolean {
  const trigger = rule.trigger;
  if (trigger.type === "event" && trigger.eventType === triggerType) return true;
  if (trigger.type === "scan" && trigger.scanType === triggerType) return true;
  return false;
}

export function updateAutomationRule(
  id: string,
  updates: UpdateAutomationRuleInput,
): AutomationRule {
  const db = getDb();
  const now = new Date().toISOString();

  const set: Record<string, unknown> = { updatedAt: now };
  if (updates.name !== undefined) set.name = updates.name;
  if (updates.description !== undefined) set.description = updates.description;
  if (updates.enabled !== undefined) set.enabled = updates.enabled;
  if (updates.priority !== undefined) set.priority = updates.priority;
  if (updates.trigger !== undefined)
    set.trigger = updates.trigger as unknown as Record<string, unknown>;
  if (updates.condition !== undefined)
    set.condition = updates.condition as unknown as Record<string, unknown>;
  if (updates.actions !== undefined)
    set.actions = updates.actions as unknown as Record<string, unknown>[];
  if (updates.cooldownSeconds !== undefined) set.cooldownSeconds = updates.cooldownSeconds;
  if (updates.maxRunsPerHour !== undefined) set.maxRunsPerHour = updates.maxRunsPerHour;

  try {
    db.update(automationRules).set(set).where(eq(automationRules.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("automationRule", err as Error, id);
  }

  const updated = getAutomationRuleById(id);
  if (!updated) throw repositoryNotFoundError("automationRule", id);
  return updated;
}

export function setRuleEnabled(id: string, enabled: boolean): AutomationRule {
  return updateAutomationRule(id, { enabled });
}

export function recordRuleLastRun(id: string, lastRunAt: string): AutomationRule {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(automationRules)
      .set({ lastRunAt, updatedAt: now })
      .where(eq(automationRules.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("automationRule", err as Error, id);
  }
  const updated = getAutomationRuleById(id);
  if (!updated) throw repositoryNotFoundError("automationRule", id);
  return updated;
}

export function deleteAutomationRule(id: string): boolean {
  const db = getDb();
  try {
    const result = db.delete(automationRules).where(eq(automationRules.id, id)).run();
    return result.changes === undefined || result.changes > 0;
  } catch (err) {
    throw repositoryDeleteError("automationRule", err as Error, id);
  }
}

export function getMostRecentEnabledRuleByTrigger(
  habitatId: string,
  triggerType: AutomationTriggerType,
): AutomationRule | null {
  const rules = getEnabledRulesByHabitatAndTrigger(habitatId, triggerType);
  return rules.length > 0 ? rules[0] : null;
}

export function countRulesByHabitat(habitatId: string): number {
  const db = getDb();
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(automationRules)
    .where(eq(automationRules.habitatId, habitatId))
    .get();
  return result?.count ?? 0;
}

export function listAllRulesForHabitatDescending(habitatId: string): AutomationRule[] {
  const db = getDb();
  return db
    .select()
    .from(automationRules)
    .where(eq(automationRules.habitatId, habitatId))
    .orderBy(desc(automationRules.priority))
    .all() as unknown as AutomationRule[];
}
