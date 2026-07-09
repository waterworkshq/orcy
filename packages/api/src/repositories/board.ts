import { getDb } from "../db/index.js";
import { habitats, columns } from "../db/schema/index.js";
import { eq, and, like, or, isNull, inArray, sql, desc } from "drizzle-orm";
import type {
  Habitat,
  Column,
  RetryPolicy,
  AnomalySettings,
  AutoAssignSettings,
  AutomationSettings,
  GitWorktreeSettings,
  PrioritizationSettings,
  WikiSettings,
  TriageSettings,
  ReleaseSettings,
  RoadmapSettings,
  CodeReviewSettings,
  CiCdSettings,
} from "../models/index.js";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
  repositoryDeleteError,
} from "../errors/repository.js";

export interface CreateHabitatInput {
  name: string;
  description?: string;
  teamId?: string | null;
}

export interface UpdateHabitatInput {
  name?: string;
  description?: string;
  retrySettings?: RetryPolicy | null;
  anomalySettings?: AnomalySettings | null;
  autoAssignSettings?: AutoAssignSettings | null;
  gitWorktreeSettings?: GitWorktreeSettings | null;
  eventRetentionDays?: number;
  prioritizationSettings?: PrioritizationSettings | null;
  automationSettings?: AutomationSettings | null;
  wikiSettings?: WikiSettings | null;
  triageSettings?: TriageSettings | null;
  releaseSettings?: ReleaseSettings | null;
  roadmapSettings?: RoadmapSettings | null;
  codeReviewSettings?: CodeReviewSettings | null;
  ciCdSettings?: CiCdSettings | null;
}

export function createHabitat(input: CreateHabitatInput): Habitat {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(habitats)
      .values({
        id,
        name: input.name,
        description: input.description ?? "",
        createdAt: now,
        updatedAt: now,
        teamId: input.teamId ?? null,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("habitat", err as Error, id);
  }

  const habitat = getHabitatById(id);
  if (!habitat) throw repositoryNotFoundError("habitat", id);
  return habitat;
}

export function getHabitatById(id: string): Habitat | null {
  const db = getDb();
  const row = db.select().from(habitats).where(eq(habitats.id, id)).get();
  return row ?? null;
}

export function listHabitats(name?: string, teamIds?: string[]): Habitat[] {
  const db = getDb();

  const conditions = [];

  if (teamIds && teamIds.length > 0) {
    conditions.push(or(inArray(habitats.teamId, teamIds), isNull(habitats.teamId)));
  }
  if (name) {
    conditions.push(like(sql`LOWER(${habitats.name})`, `%${name.toLowerCase()}%`));
  }

  if (conditions.length === 0) {
    return db.select().from(habitats).orderBy(desc(habitats.createdAt)).all();
  }

  return db
    .select()
    .from(habitats)
    .where(and(...conditions))
    .orderBy(desc(habitats.createdAt))
    .all();
}

export function updateHabitat(id: string, input: UpdateHabitatInput): Habitat | null {
  const db = getDb();
  const values: Partial<typeof habitats.$inferInsert> = {};
  values.updatedAt = new Date().toISOString();

  if (input.name !== undefined) values.name = input.name;
  if (input.description !== undefined) values.description = input.description;
  if (input.retrySettings !== undefined) values.retrySettings = input.retrySettings;
  if (input.anomalySettings !== undefined) values.anomalySettings = input.anomalySettings;
  if (input.autoAssignSettings !== undefined) values.autoAssignSettings = input.autoAssignSettings;
  if (input.gitWorktreeSettings !== undefined)
    values.gitWorktreeSettings = input.gitWorktreeSettings;
  if (input.eventRetentionDays !== undefined) values.eventRetentionDays = input.eventRetentionDays;
  if (input.prioritizationSettings !== undefined)
    values.prioritizationSettings = input.prioritizationSettings;
  if (input.automationSettings !== undefined) values.automationSettings = input.automationSettings;
  if (input.wikiSettings !== undefined) values.wikiSettings = input.wikiSettings;
  if (input.triageSettings !== undefined) values.triageSettings = input.triageSettings;
  if (input.releaseSettings !== undefined) values.releaseSettings = input.releaseSettings;
  if (input.roadmapSettings !== undefined) values.roadmapSettings = input.roadmapSettings;
  if (input.codeReviewSettings !== undefined) values.codeReviewSettings = input.codeReviewSettings;
  if (input.ciCdSettings !== undefined) values.ciCdSettings = input.ciCdSettings;

  try {
    db.update(habitats).set(values).where(eq(habitats.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("habitat", err as Error, id);
  }
  return getHabitatById(id);
}

export function deleteHabitat(id: string): void {
  const db = getDb();
  try {
    db.delete(habitats).where(eq(habitats.id, id)).run();
  } catch (err) {
    throw repositoryDeleteError("habitat", err as Error, id);
  }
}

export function getHabitatWithColumnsAndTasks(
  habitatId: string,
): { habitat: Habitat; columns: Column[] } | null {
  const db = getDb();
  // Use two plain select queries rather than the relational `db.query.*.findFirst({ with })`
  // API: under the sql.js driver used by the test DB, the relational query path returns
  // habitat fields in snake_case and serializes the `columns` relation as a JSON string
  // rather than an array, breaking `result.columns.map(...)` and the camelCase
  // expectations of the {@link Habitat} type. Plain selects decode JSON columns and
  // camelCase the row identically across both drivers used in this package.
  const habitat = db
    .select()
    .from(habitats)
    .where(eq(habitats.id, habitatId))
    .get();
  if (!habitat) return null;

  const cols = db
    .select()
    .from(columns)
    .where(eq(columns.habitatId, habitatId))
    .orderBy(columns.order)
    .all();

  return { habitat: habitat as Habitat, columns: cols as Column[] };
}
