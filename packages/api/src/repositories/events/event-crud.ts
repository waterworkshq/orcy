import { getDb } from '../../db/index.js';
import { taskEvents } from '../../db/schema.js';
import { eq, and, count, asc, desc } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { TaskEvent, ActorType, EventAction, TaskStatus } from '../../models/index.js';

export interface CreateEventInput {
  taskId: string;
  actorType: ActorType;
  actorId: string;
  action: EventAction;
  fromColumnId?: string | null;
  toColumnId?: string | null;
  fromStatus?: TaskStatus | null;
  toStatus?: TaskStatus | null;
  metadata?: Record<string, unknown>;
}

export function createEvent(input: CreateEventInput): TaskEvent {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(taskEvents)
    .values({
      id,
      taskId: input.taskId,
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      fromColumnId: input.fromColumnId ?? null,
      toColumnId: input.toColumnId ?? null,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      metadata: input.metadata ?? {},
      timestamp: now,
    })
    .run();

  return getEventById(id)!;
}

export function getEventById(id: string): TaskEvent | null {
  const db = getDb();
  const row = db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.id, id))
    .get();
  return (row as TaskEvent) ?? null;
}

export function getEventsByTaskId(
  taskId: string,
  limit = 50,
  offset = 0,
): { events: TaskEvent[]; total: number } {
  const db = getDb();
  const events = db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(asc(taskEvents.timestamp))
    .limit(limit)
    .offset(offset)
    .all() as TaskEvent[];

  const totalResult = db
    .select({ count: count() })
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .get();

  return { events, total: totalResult?.count ?? 0 };
}

export function getEventsByActor(
  actorType: ActorType,
  actorId: string,
  limit = 50,
): TaskEvent[] {
  const db = getDb();
  return db
    .select()
    .from(taskEvents)
    .where(
      and(eq(taskEvents.actorType, actorType), eq(taskEvents.actorId, actorId)),
    )
    .orderBy(desc(taskEvents.timestamp))
    .limit(limit)
    .all() as TaskEvent[];
}
