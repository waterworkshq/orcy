import { getDb } from "../../db/index.js";
import { taskEvents } from "../../db/schema/index.js";
import { eq, and, count, asc, desc } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { TaskEvent, ActorType, EventAction, TaskStatus } from "../../models/index.js";
import { repositoryCreateError, repositoryNotFoundError } from "../../errors/repository.js";
import { withAuditProvenanceMetadata } from "../../services/auditProvenanceContext.js";

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

  try {
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
        metadata: withAuditProvenanceMetadata(input.metadata),
        timestamp: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("taskEvent", err as Error, id);
  }

  const event = getEventById(id);
  if (!event) throw repositoryNotFoundError("taskEvent", id);
  return event;
}

export function getEventById(id: string): TaskEvent | null {
  const db = getDb();
  const row = db.select().from(taskEvents).where(eq(taskEvents.id, id)).get();
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

export function getEventsByActor(actorType: ActorType, actorId: string, limit = 50): TaskEvent[] {
  const db = getDb();
  return db
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.actorType, actorType), eq(taskEvents.actorId, actorId)))
    .orderBy(desc(taskEvents.timestamp))
    .limit(limit)
    .all() as TaskEvent[];
}

/** Input for {@link createEventWithClient}, including an optional preallocated audit ID. */
export interface CreateEventWithClientInput extends CreateEventInput {
  id?: string;
}

/**
 * Drizzle client accepted by {@link createEventWithClient}. Both the default
 * client and a transaction client from `db.transaction(cb)` satisfy this
 * shape; callers pass the latter when the audit row must commit atomically
 * with another domain mutation.
 */
export type EventDbClient = ReturnType<typeof getDb>;

/**
 * Transaction-aware sibling of {@link createEvent}. The caller owns the
 * transaction and supplies the client used for both the INSERT and read-back.
 * Any INSERT failure is wrapped consistently with {@link createEvent} and
 * propagates to the caller so the surrounding transaction can roll back.
 */
export function createEventWithClient(
  db: EventDbClient,
  input: CreateEventWithClientInput,
): TaskEvent {
  const id = input.id ?? uuid();
  const now = new Date().toISOString();

  try {
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
        metadata: withAuditProvenanceMetadata(input.metadata),
        timestamp: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("taskEvent", err as Error, id);
  }

  const row = db.select().from(taskEvents).where(eq(taskEvents.id, id)).get();
  if (!row) throw repositoryNotFoundError("taskEvent", id);
  return row as TaskEvent;
}
