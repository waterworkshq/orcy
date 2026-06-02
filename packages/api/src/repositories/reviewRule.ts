import { getDb } from "../db/index.js";
import { reviewRules } from "../db/schema/index.js";
import { eq, and, asc } from "drizzle-orm";
import type { ReviewRule, ReviewRuleCreateInput, ReviewRuleUpdateInput } from "@orcy/shared";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  assertFound,
  repositoryUpdateError,
  repositoryDeleteError,
} from "../errors/repository.js";

export function getByHabitatId(habitatId: string): ReviewRule[] {
  const db = getDb();
  return db
    .select()
    .from(reviewRules)
    .where(eq(reviewRules.habitatId, habitatId))
    .orderBy(asc(reviewRules.priority))
    .all() as ReviewRule[];
}

export function getById(id: string): ReviewRule | null {
  const db = getDb();
  return db.select().from(reviewRules).where(eq(reviewRules.id, id)).get() as ReviewRule | null;
}

export function getEnabledRulesForHabitat(habitatId: string): ReviewRule[] {
  const db = getDb();
  return db
    .select()
    .from(reviewRules)
    .where(and(eq(reviewRules.habitatId, habitatId), eq(reviewRules.enabled, 1)))
    .orderBy(asc(reviewRules.priority))
    .all() as ReviewRule[];
}

export function create(habitatId: string, input: ReviewRuleCreateInput): ReviewRule {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(reviewRules)
      .values({
        id,
        habitatId,
        name: input.name,
        enabled: input.enabled ?? 1,
        priority: input.priority ?? 0,
        matchDomain: input.matchDomain ?? null,
        matchLabels: input.matchLabels ?? [],
        matchPriority: input.matchPriority ?? null,
        assignmentStrategy: input.assignmentStrategy ?? "domain_expert",
        requiredReviews: input.requiredReviews ?? 1,
        antiSelfReview: input.antiSelfReview ?? 1,
        fixedReviewerIds: input.fixedReviewerIds ?? [],
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("reviewRule", err as Error, id);
  }

  return assertFound(getById(id), "reviewRule", id);
}

export function update(id: string, input: ReviewRuleUpdateInput): ReviewRule | null {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = getById(id);
  if (!existing) return null;

  const values: Partial<typeof reviewRules.$inferInsert> = { updatedAt: now };
  if (input.name !== undefined) values.name = input.name;
  if (input.enabled !== undefined) values.enabled = input.enabled;
  if (input.priority !== undefined) values.priority = input.priority;
  if (input.matchDomain !== undefined) values.matchDomain = input.matchDomain;
  if (input.matchLabels !== undefined) values.matchLabels = input.matchLabels;
  if (input.matchPriority !== undefined) values.matchPriority = input.matchPriority;
  if (input.assignmentStrategy !== undefined) values.assignmentStrategy = input.assignmentStrategy;
  if (input.requiredReviews !== undefined) values.requiredReviews = input.requiredReviews;
  if (input.antiSelfReview !== undefined) values.antiSelfReview = input.antiSelfReview;
  if (input.fixedReviewerIds !== undefined) values.fixedReviewerIds = input.fixedReviewerIds;

  try {
    db.update(reviewRules).set(values).where(eq(reviewRules.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("reviewRule", err as Error, id);
  }
  return getById(id);
}

export function remove(id: string): boolean {
  const db = getDb();
  try {
    const result = db.delete(reviewRules).where(eq(reviewRules.id, id)).run();
    return result.changes > 0;
  } catch (err) {
    throw repositoryDeleteError("reviewRule", err as Error, id);
  }
}
