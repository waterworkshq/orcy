import { getDb } from "../db/index.js";
import { habitatSkills, habitatSkillSignals } from "../db/schema/index.js";
import { eq, and, count, desc, gt, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

export type SkillCategory =
  | "convention"
  | "pattern"
  | "pitfall"
  | "domain_knowledge"
  | "agent_insight";

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

  return getSkillById(id)!;
}

export function getSkillById(id: string): HabitatSkill | null {
  const db = getDb();
  const rows = db.select().from(habitatSkills).where(eq(habitatSkills.id, id)).all();
  return rows.length > 0 ? rowToSkill(rows[0]) : null;
}

export function getSkillByHabitatId(habitatId: string): HabitatSkill | null {
  const db = getDb();
  const rows = db.select().from(habitatSkills).where(eq(habitatSkills.habitatId, habitatId)).all();
  return rows.length > 0 ? rowToSkill(rows[0]) : null;
}

export function getOrCreateSkill(habitatId: string): HabitatSkill {
  const existing = getSkillByHabitatId(habitatId);
  if (existing) return existing;
  try {
    return createSkill(habitatId);
  } catch {
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
}

export function createSignal(input: CreateSignalInput): HabitatSkillSignal {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  const sourcePulseIds = input.sourcePulseId ? JSON.stringify([input.sourcePulseId]) : null;
  const sourceTaskIds = input.sourceTaskId ? JSON.stringify([input.sourceTaskId]) : null;
  const sourceCommentIds = input.sourceCommentId ? JSON.stringify([input.sourceCommentId]) : null;
  const corroboratingAgentIds = input.agentId ? JSON.stringify([input.agentId]) : null;

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

  return getSignalById(id)!;
}

export function getSignalById(id: string): HabitatSkillSignal | null {
  const db = getDb();
  const rows = db.select().from(habitatSkillSignals).where(eq(habitatSkillSignals.id, id)).all();
  return rows.length > 0 ? rowToSignal(rows[0]) : null;
}

export function findSignalByClusterKey(
  habitatId: string,
  clusterKey: string,
): HabitatSkillSignal | null {
  const db = getDb();
  const rows = db
    .select()
    .from(habitatSkillSignals)
    .where(
      and(
        eq(habitatSkillSignals.habitatId, habitatId),
        eq(habitatSkillSignals.clusterKey, clusterKey),
      ),
    )
    .all();
  return rows.length > 0 ? rowToSignal(rows[0]) : null;
}

export function updateSignal(
  id: string,
  updates: Partial<Omit<HabitatSkillSignal, "id" | "createdAt">>,
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

  db.update(habitatSkillSignals).set(set).where(eq(habitatSkillSignals.id, id)).run();
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

export function deleteSignal(id: string): boolean {
  const db = getDb();
  const signal = getSignalById(id);
  if (!signal) return false;
  db.delete(habitatSkillSignals).where(eq(habitatSkillSignals.id, id)).run();
  return true;
}
