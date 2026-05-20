import { getDb } from '../db/index.js';
import { sprints, missions } from '../db/schema/index.js';
import { eq, and, sql } from 'drizzle-orm';
import type { Sprint, SprintStatus } from '@orcy/shared';
import { v4 as uuid } from 'uuid';

export function getByHabitatId(habitatId: string): Sprint[] {
  const db = getDb();
  return db.select().from(sprints).where(eq(sprints.habitatId, habitatId)).all() as Sprint[];
}

export function getById(id: string): Sprint | null {
  const db = getDb();
  const row = db.select().from(sprints).where(eq(sprints.id, id)).get();
  return (row as Sprint) ?? null;
}

export function getActiveForHabitat(habitatId: string): Sprint | null {
  const db = getDb();
  return db.select().from(sprints)
    .where(and(eq(sprints.habitatId, habitatId), eq(sprints.status, 'active')))
    .get() as Sprint | null;
}

export function create(habitatId: string, data: {
  name: string;
  goal?: string;
  startDate: string;
  endDate: string;
  capacityMinutes?: number | null;
  notes?: string;
  createdBy: string;
}): Sprint {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(sprints).values({
    id,
    habitatId,
    name: data.name,
    goal: data.goal ?? '',
    startDate: data.startDate,
    endDate: data.endDate,
    status: 'planning',
    committedMissionIds: [],
    completedMissionIds: [],
    capacityMinutes: data.capacityMinutes ?? null,
    notes: data.notes ?? '',
    createdBy: data.createdBy,
    createdAt: now,
    updatedAt: now,
  }).run();

  return getById(id)!;
}

export function update(id: string, data: {
  name?: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
  status?: SprintStatus;
  capacityMinutes?: number | null;
  notes?: string;
}): Sprint | null {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = getById(id);
  if (!existing) return null;

  const values: Record<string, unknown> = { updatedAt: now };
  if (data.name !== undefined) values.name = data.name;
  if (data.goal !== undefined) values.goal = data.goal;
  if (data.startDate !== undefined) values.startDate = data.startDate;
  if (data.endDate !== undefined) values.endDate = data.endDate;
  if (data.status !== undefined) values.status = data.status;
  if (data.capacityMinutes !== undefined) values.capacityMinutes = data.capacityMinutes;
  if (data.notes !== undefined) values.notes = data.notes;

  db.update(sprints).set(values as any).where(eq(sprints.id, id)).run();
  return getById(id);
}

export function remove(id: string): boolean {
  const db = getDb();
  const result = db.delete(sprints).where(eq(sprints.id, id)).run();
  return result.changes > 0;
}

export function addMission(sprintId: string, missionId: string): Sprint | null {
  const db = getDb();
  const sprint = getById(sprintId);
  if (!sprint) return null;

  const committed = [...sprint.committedMissionIds];
  if (!committed.includes(missionId)) {
    committed.push(missionId);
  }

  const now = new Date().toISOString();
  db.transaction((tx) => {
    tx.update(sprints).set({ committedMissionIds: committed, updatedAt: now }).where(eq(sprints.id, sprintId)).run();
    tx.update(missions).set({ sprintId }).where(eq(missions.id, missionId)).run();
  });

  return getById(sprintId);
}

export function removeMission(sprintId: string, missionId: string): Sprint | null {
  const db = getDb();
  const sprint = getById(sprintId);
  if (!sprint) return null;

  const committed = sprint.committedMissionIds.filter(id => id !== missionId);
  const now = new Date().toISOString();

  db.transaction((tx) => {
    tx.update(sprints).set({ committedMissionIds: committed, updatedAt: now }).where(eq(sprints.id, sprintId)).run();
    tx.update(missions).set({ sprintId: null }).where(and(eq(missions.id, missionId), eq(missions.sprintId, sprintId))).run();
  });

  return getById(sprintId);
}

export function getExpiredActiveSprints(): Sprint[] {
  const db = getDb();
  const nowSql = sql`(datetime('now'))`;
  return db.select().from(sprints)
    .where(and(eq(sprints.status, 'active'), sql`${sprints.endDate} < ${nowSql}`))
    .all() as Sprint[];
}

export function markMissionsCompleted(sprintId: string, missionIds: string[]): void {
  const db = getDb();
  const sprint = getById(sprintId);
  if (!sprint) return;

  const completed = [...new Set([...sprint.completedMissionIds, ...missionIds])];
  const now = new Date().toISOString();

  db.transaction((tx) => {
    tx.update(sprints).set({ completedMissionIds: completed, updatedAt: now }).where(eq(sprints.id, sprintId)).run();
  });
}
