import { getDb } from "../db/index.js";
import { habitatSkills, habitatSkillSignals } from "../db/schema/index.js";
import { eq, and, count, desc, gt, inArray, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { SkillCategory } from "@orcy/shared";
import { SKILL_CATEGORIES } from "@orcy/shared";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
  repositoryDeleteError,
} from "../errors/repository.js";
import { isSqliteError } from "../errors/sqlite.js";

export type { SkillCategory };

export interface HabitatSkill {
  id: string;
  habitatId: string;
  content: string;
  signalCount: number;
  avgStrength: number;
  lastGeneratedAt: string;
  generationCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface HabitatSkillSignal {
  id: string;
  habitatId: string;
  clusterKey: string;
  skillCategory: SkillCategory;
  sourceSignalType: string;
  sourceType: string;
  subject: string;
  summary: string | null;
  strength: number;
  frequency: number;
  corroboratingAgents: number;
  crossMissionCount: number;
  successfulTasks: number;
  failedTasks: number;
  lastSeenAt: string;
  firstSeenAt: string;
  sourcePulseIds: string | null;
  sourceTaskIds: string | null;
  sourceCommentIds: string | null;
  corroboratingAgentIds: string | null;
  promotedToSkill: number;
  createdAt: string;
  updatedAt: string;
}

export const VALID_SKILL_CATEGORIES = new Set<SkillCategory>(SKILL_CATEGORIES);

export interface CreateSignalInput {
  habitatId: string;
  clusterKey: string;
  skillCategory: SkillCategory;
  sourceSignalType: string;
  sourceType?: string;
  subject: string;
  summary?: string;
  strength?: number;
  sourcePulseId?: string;
  sourceTaskId?: string;
  sourceCommentId?: string;
  agentId?: string;
  initialFailedTasks?: number;
}

export interface SignalFilters {
  skillCategory?: SkillCategory;
  minStrength?: number;
  promotedOnly?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Aggregated experience-signal cluster projected for reader-facing surfaces. Same shape across
 * `wikiSignalSurfaceService.getExperienceSurface` and the `get_signal_surface` MCP action.
 *
 * **Privacy boundary (ARCHITECTURE.md §11.7):** individual-level fields (`sourcePulseIds`,
 * `sourceTaskIds`, `sourceCommentIds`, `corroboratingAgentIds`) are stripped — readers see
 * aggregate counts (`frequency`, `successfulTasks`, `failedTasks`, `corroboratingAgents`) and
 * first/last-seen timestamps only. The raw `HabitatSkillSignal` row is the source of truth;
 * the projection is constructed in {@link listExperienceAggregates}.
 */
export interface ExperienceAggregate {
  id: string;
  subject: string;
  summary: string | null;
  skillCategory: SkillCategory;
  sourceSignalType: string;
  strength: number;
  frequency: number;
  corroboratingAgents: number;
  successfulTasks: number;
  failedTasks: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * Filters for {@link listExperienceAggregates}. `category` narrows within the experience-derived
 * subset; `timeWindow` is a human-readable duration string (e.g. `'7 days'`, `'30 days'`,
 * `'90 days'`) parsed into an ISO timestamp by the repo. `domain` is accepted but not yet
 * implemented — the join through `source_task_ids` JSON is deferred to a later release (see
 * MEMORY.md).
 */
export interface ExperienceAggregateFilters {
  domain?: string;
  timeWindow?: string;
  category?: SkillCategory;
  limit?: number;
  offset?: number;
}

/** Experience-derived skill categories — the union of `EXPERIENCE_CATEGORY_TO_SKILL` values. */
const EXPERIENCE_SKILL_CATEGORIES: readonly SkillCategory[] = [
  "pitfall",
  "domain_knowledge",
  "anti_patterns",
  "pattern",
] as const;

/**
 * Parses a duration string (e.g. `'7 days'`, `'30 days'`, `'90 days'`) into an ISO timestamp
 * representing `now - duration`. Returns `null` for unparseable input so the caller can choose
 * to skip the filter rather than silently widen the window.
 */
export function parseDurationWindow(
  timeWindow: string | undefined,
  now: Date = new Date(),
): string | null {
  if (!timeWindow) return null;
  const match = timeWindow
    .trim()
    .match(/^(\d+)\s*(s|sec|seconds?|m|min|mins?|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)$/i);
  if (!match) return null;
  const n = parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  let ms: number;
  if (unit.startsWith("s")) ms = n * 1000;
  else if (unit.startsWith("m") && !unit.startsWith("ms")) ms = n * 60 * 1000;
  else if (unit.startsWith("h")) ms = n * 60 * 60 * 1000;
  else if (unit.startsWith("d")) ms = n * 24 * 60 * 60 * 1000;
  else if (unit.startsWith("w")) ms = n * 7 * 24 * 60 * 60 * 1000;
  else return null;
  return new Date(now.getTime() - ms).toISOString();
}

function rowToExperienceAggregate(row: Record<string, unknown>): ExperienceAggregate {
  return {
    id: row.id as string,
    subject: row.subject as string,
    summary: (row.summary as string | null) ?? null,
    skillCategory: row.skillCategory as SkillCategory,
    sourceSignalType: row.sourceSignalType as string,
    strength: row.strength as number,
    frequency: row.frequency as number,
    corroboratingAgents: row.corroboratingAgents as number,
    successfulTasks: row.successfulTasks as number,
    failedTasks: row.failedTasks as number,
    firstSeenAt: row.firstSeenAt as string,
    lastSeenAt: row.lastSeenAt as string,
  };
}

function rowToSkill(row: Record<string, unknown>): HabitatSkill {
  return {
    id: row.id as string,
    habitatId: row.habitatId as string,
    content: row.content as string,
    signalCount: row.signalCount as number,
    avgStrength: row.avgStrength as number,
    lastGeneratedAt: row.lastGeneratedAt as string,
    generationCount: row.generationCount as number,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

function rowToSignal(row: Record<string, unknown>): HabitatSkillSignal {
  return {
    id: row.id as string,
    habitatId: row.habitatId as string,
    clusterKey: row.clusterKey as string,
    skillCategory: row.skillCategory as SkillCategory,
    sourceSignalType: row.sourceSignalType as string,
    sourceType: row.sourceType as string,
    subject: row.subject as string,
    summary: (row.summary as string | null) ?? null,
    strength: row.strength as number,
    frequency: row.frequency as number,
    corroboratingAgents: row.corroboratingAgents as number,
    crossMissionCount: row.crossMissionCount as number,
    successfulTasks: row.successfulTasks as number,
    failedTasks: row.failedTasks as number,
    lastSeenAt: row.lastSeenAt as string,
    firstSeenAt: row.firstSeenAt as string,
    sourcePulseIds: (row.sourcePulseIds as string | null) ?? null,
    sourceTaskIds: (row.sourceTaskIds as string | null) ?? null,
    sourceCommentIds: (row.sourceCommentIds as string | null) ?? null,
    corroboratingAgentIds: (row.corroboratingAgentIds as string | null) ?? null,
    promotedToSkill: row.promotedToSkill as number,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

export function createSkill(habitatId: string): HabitatSkill {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(habitatSkills)
      .values({
        id,
        habitatId,
        content: "",
        signalCount: 0,
        avgStrength: 0,
        lastGeneratedAt: now,
        generationCount: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("habitatSkill", err as Error, id);
  }

  const skill = getSkillById(id);
  if (!skill) throw repositoryNotFoundError("habitatSkill", id);
  return skill;
}

export function getSkillById(id: string): HabitatSkill | null {
  const db = getDb();
  const row = db.select().from(habitatSkills).where(eq(habitatSkills.id, id)).get();
  return row ? rowToSkill(row) : null;
}

export function getSkillByHabitatId(habitatId: string): HabitatSkill | null {
  const db = getDb();
  const row = db.select().from(habitatSkills).where(eq(habitatSkills.habitatId, habitatId)).get();
  return row ? rowToSkill(row) : null;
}

export function getOrCreateSkill(habitatId: string): HabitatSkill {
  const existing = getSkillByHabitatId(habitatId);
  if (existing) return existing;
  try {
    return createSkill(habitatId);
  } catch (err) {
    if (isSqliteError(err) && err.code === "SQLITE_CONSTRAINT_FOREIGNKEY") throw err;
    // If the create failed for a non-FK reason (race or transient DB error), the existing
    // row will satisfy getSkillByHabitatId. If the re-read returns null, the recursive
    // createSkill() call will surface the real error (e.g., disk full) as a RepositoryError.
    return getSkillByHabitatId(habitatId) ?? createSkill(habitatId);
  }
}

export function updateSkillContent(
  habitatId: string,
  content: string,
  signalCount: number,
  avgStrength: number,
): void {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    db.update(habitatSkills)
      .set({
        content,
        signalCount,
        avgStrength,
        lastGeneratedAt: now,
        generationCount: sql`${habitatSkills.generationCount} + 1`,
        updatedAt: now,
      })
      .where(eq(habitatSkills.habitatId, habitatId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("habitatSkill", err as Error, habitatId);
  }
}

export function createSignal(input: CreateSignalInput): HabitatSkillSignal {
  if (!VALID_SKILL_CATEGORIES.has(input.skillCategory)) {
    throw new Error(`Invalid skillCategory: ${input.skillCategory}`);
  }
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  const sourcePulseIds = input.sourcePulseId ? JSON.stringify([input.sourcePulseId]) : null;
  const sourceTaskIds = input.sourceTaskId ? JSON.stringify([input.sourceTaskId]) : null;
  const sourceCommentIds = input.sourceCommentId ? JSON.stringify([input.sourceCommentId]) : null;
  const corroboratingAgentIds = input.agentId ? JSON.stringify([input.agentId]) : null;

  try {
    db.insert(habitatSkillSignals)
      .values({
        id,
        habitatId: input.habitatId,
        clusterKey: input.clusterKey,
        skillCategory: input.skillCategory,
        sourceSignalType: input.sourceSignalType,
        sourceType: input.sourceType ?? "pulse",
        subject: input.subject,
        summary: input.summary ?? null,
        strength: input.strength ?? 0.1,
        frequency: 1,
        corroboratingAgents: 1,
        crossMissionCount: 0,
        successfulTasks: 0,
        failedTasks: input.initialFailedTasks ?? 0,
        lastSeenAt: now,
        firstSeenAt: now,
        sourcePulseIds,
        sourceTaskIds,
        sourceCommentIds,
        corroboratingAgentIds,
        promotedToSkill: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("habitatSkillSignal", err as Error, id);
  }

  const signal = getSignalById(id);
  if (!signal) throw repositoryNotFoundError("habitatSkillSignal", id);
  return signal;
}

export function getSignalById(id: string): HabitatSkillSignal | null {
  const db = getDb();
  const row = db.select().from(habitatSkillSignals).where(eq(habitatSkillSignals.id, id)).get();
  return row ? rowToSignal(row) : null;
}

export function findSignalByClusterKey(
  habitatId: string,
  clusterKey: string,
): HabitatSkillSignal | null {
  const db = getDb();
  const row = db
    .select()
    .from(habitatSkillSignals)
    .where(
      and(
        eq(habitatSkillSignals.habitatId, habitatId),
        eq(habitatSkillSignals.clusterKey, clusterKey),
      ),
    )
    .get();
  return row ? rowToSignal(row) : null;
}

export function updateSignal(
  id: string,
  updates: Partial<Omit<HabitatSkillSignal, "id" | "createdAt" | "habitatId">>,
): void {
  const db = getDb();
  const now = new Date().toISOString();

  type SignalUpdate = Partial<typeof habitatSkillSignals.$inferInsert>;
  const set: SignalUpdate = { updatedAt: now };

  if (updates.clusterKey !== undefined) set.clusterKey = updates.clusterKey;
  if (updates.skillCategory !== undefined) set.skillCategory = updates.skillCategory;
  if (updates.sourceSignalType !== undefined) set.sourceSignalType = updates.sourceSignalType;
  if (updates.subject !== undefined) set.subject = updates.subject;
  if (updates.summary !== undefined) set.summary = updates.summary;
  if (updates.strength !== undefined) set.strength = updates.strength;
  if (updates.frequency !== undefined) set.frequency = updates.frequency;
  if (updates.corroboratingAgents !== undefined)
    set.corroboratingAgents = updates.corroboratingAgents;
  if (updates.crossMissionCount !== undefined) set.crossMissionCount = updates.crossMissionCount;
  if (updates.successfulTasks !== undefined) set.successfulTasks = updates.successfulTasks;
  if (updates.failedTasks !== undefined) set.failedTasks = updates.failedTasks;
  if (updates.lastSeenAt !== undefined) set.lastSeenAt = updates.lastSeenAt;
  if (updates.sourcePulseIds !== undefined) set.sourcePulseIds = updates.sourcePulseIds;
  if (updates.sourceTaskIds !== undefined) set.sourceTaskIds = updates.sourceTaskIds;
  if (updates.sourceCommentIds !== undefined) set.sourceCommentIds = updates.sourceCommentIds;
  if (updates.corroboratingAgentIds !== undefined)
    set.corroboratingAgentIds = updates.corroboratingAgentIds;
  if (updates.promotedToSkill !== undefined) set.promotedToSkill = updates.promotedToSkill;

  try {
    db.update(habitatSkillSignals).set(set).where(eq(habitatSkillSignals.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("habitatSkillSignal", err as Error, id);
  }
}

export function getPromotedSignals(habitatId: string): HabitatSkillSignal[] {
  const db = getDb();
  return db
    .select()
    .from(habitatSkillSignals)
    .where(
      and(eq(habitatSkillSignals.habitatId, habitatId), eq(habitatSkillSignals.promotedToSkill, 1)),
    )
    .orderBy(desc(habitatSkillSignals.strength))
    .all()
    .map(rowToSignal);
}

export function getSignalsByHabitat(
  habitatId: string,
  filters?: SignalFilters,
): { signals: HabitatSkillSignal[]; total: number } {
  const db = getDb();
  const conditions = [eq(habitatSkillSignals.habitatId, habitatId)];

  if (filters?.skillCategory) {
    conditions.push(eq(habitatSkillSignals.skillCategory, filters.skillCategory));
  }
  if (filters?.minStrength !== undefined) {
    conditions.push(gt(habitatSkillSignals.strength, filters.minStrength));
  }
  if (filters?.promotedOnly) {
    conditions.push(eq(habitatSkillSignals.promotedToSkill, 1));
  }

  const where = and(...conditions);

  const totalRows = db.select({ total: count() }).from(habitatSkillSignals).where(where).all();
  const total = totalRows[0]?.total ?? 0;

  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;

  const rows = db
    .select()
    .from(habitatSkillSignals)
    .where(where)
    .orderBy(desc(habitatSkillSignals.strength))
    .limit(limit)
    .offset(offset)
    .all();

  return { signals: rows.map(rowToSignal), total };
}

export function getAllSignalHabitatIds(): string[] {
  const db = getDb();
  const rows = db
    .selectDistinct({ habitatId: habitatSkillSignals.habitatId })
    .from(habitatSkillSignals)
    .all();
  return rows.map((r) => r.habitatId);
}

export function getAllSignalsByHabitat(habitatId: string): HabitatSkillSignal[] {
  const db = getDb();
  return db
    .select()
    .from(habitatSkillSignals)
    .where(eq(habitatSkillSignals.habitatId, habitatId))
    .all()
    .map(rowToSignal);
}

/**
 * Returns the latest habitat skill signals in a habitat with `updated_at > since`, scoped to
 * the habitat, ordered by `updated_at DESC` then `strength DESC`. Backs the
 * `wikiAugmentationService.getAuthoringContextForEdit` and `getAuthoringContextForChunk` flows.
 * `limit` defaults to 100. No side effects.
 */
export function listByHabitatSince(
  habitatId: string,
  since: string,
  limit = 100,
): HabitatSkillSignal[] {
  const db = getDb();
  return db
    .select()
    .from(habitatSkillSignals)
    .where(
      and(eq(habitatSkillSignals.habitatId, habitatId), gt(habitatSkillSignals.updatedAt, since)),
    )
    .orderBy(desc(habitatSkillSignals.updatedAt), desc(habitatSkillSignals.strength))
    .limit(limit)
    .all()
    .map(rowToSignal);
}

export function deleteSignal(id: string): boolean {
  const db = getDb();
  try {
    const result = db.delete(habitatSkillSignals).where(eq(habitatSkillSignals.id, id)).run();
    return result.changes > 0;
  } catch (err) {
    throw repositoryDeleteError("habitatSkillSignal", err as Error, id);
  }
}

/**
 * Returns aggregated experience clusters for a habitat, filtered to the experience-derived skill
 * categories (`pitfall`, `domain_knowledge`, `anti_patterns`, `pattern` — the union of
 * `EXPERIENCE_CATEGORY_TO_SKILL` values). Each row is projected to {@link ExperienceAggregate}:
 * aggregate counts + timestamps are kept; individual-level fields (`sourcePulseIds`,
 * `sourceTaskIds`, `sourceCommentIds`, `corroboratingAgentIds`) are intentionally stripped —
 * see ARCHITECTURE.md §11.7 (privacy boundary).
 *
 * Filters: `category` narrows within the experience subset; `timeWindow` accepts a duration
 * string (`'7 days'` etc.) parsed via {@link parseDurationWindow}; `domain` is accepted for API
 * stability but is currently a no-op (the JSON `source_task_ids` → `tasks.requiredDomain` join
 * is deferred to a later release — see MEMORY.md).
 *
 * Ordered by `strength DESC, lastSeenAt DESC` — strongest + most recent first.
 */
export function listExperienceAggregates(
  habitatId: string,
  filters: ExperienceAggregateFilters = {},
): ExperienceAggregate[] {
  const db = getDb();
  const conditions = [
    eq(habitatSkillSignals.habitatId, habitatId),
    inArray(habitatSkillSignals.skillCategory, EXPERIENCE_SKILL_CATEGORIES as SkillCategory[]),
  ];

  if (filters.category) {
    if (!EXPERIENCE_SKILL_CATEGORIES.includes(filters.category)) {
      throw new Error(
        `Invalid experience category: ${filters.category} — must be one of ${EXPERIENCE_SKILL_CATEGORIES.join(", ")}`,
      );
    }
    conditions.push(eq(habitatSkillSignals.skillCategory, filters.category));
  }

  const sinceIso = parseDurationWindow(filters.timeWindow);
  if (sinceIso) {
    conditions.push(gt(habitatSkillSignals.lastSeenAt, sinceIso));
  }

  const where = and(...conditions);

  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;

  const rows = db
    .select()
    .from(habitatSkillSignals)
    .where(where)
    .orderBy(desc(habitatSkillSignals.strength), desc(habitatSkillSignals.lastSeenAt))
    .limit(limit)
    .offset(offset)
    .all();

  return rows.map(rowToExperienceAggregate);
}
