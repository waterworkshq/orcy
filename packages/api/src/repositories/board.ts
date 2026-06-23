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
  const result = db.query.habitats
    .findFirst({
      where: eq(habitats.id, habitatId),
      with: {
        columns: {
          orderBy: columns.order,
          with: {
            missions: true,
          },
        },
      },
    })
    .prepare()
    .get();

  if (!result) return null;

  const cols = result.columns.map((c: Record<string, unknown>) => {
    const { missions: _, ...col } = c;
    return col as unknown as Column;
  });
  const { columns: _, ...habitatData } = result;
  return { habitat: habitatData as unknown as Habitat, columns: cols };
}
