import { getDb } from "../../db/index.js";
import { missionEvents, missions } from "../../db/schema/index.js";
import { eq, count, desc, inArray } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type {
  MissionEvent,
  ActorType,
  MissionEventAction,
  MissionStatus,
} from "../../models/index.js";
import { repositoryCreateError, repositoryNotFoundError } from "../../errors/repository.js";
import { withAuditProvenanceMetadata } from "../../services/auditProvenanceContext.js";

export interface CreateMissionEventInput {
  missionId: string;
  actorType: ActorType;
  actorId: string;
  action: MissionEventAction;
  fromColumnId?: string | null;
  toColumnId?: string | null;
  fromStatus?: MissionStatus | null;
  toStatus?: MissionStatus | null;
  metadata?: Record<string, unknown>;
}

export function createMissionEvent(input: CreateMissionEventInput): MissionEvent {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(missionEvents)
      .values({
        id,
        missionId: input.missionId,
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
    throw repositoryCreateError("missionEvent", err as Error, id);
  }

  const event = getMissionEventById(id);
  if (!event) throw repositoryNotFoundError("missionEvent", id);
  return event;
}

export function getMissionEventById(id: string): MissionEvent | null {
  const db = getDb();
  const row = db.select().from(missionEvents).where(eq(missionEvents.id, id)).get();
  return (row as MissionEvent) ?? null;
}

export function getMissionEventsByMissionId(
  missionId: string,
  limit = 50,
  offset = 0,
): { events: MissionEvent[]; total: number } {
  const db = getDb();
  const result = db
    .select()
    .from(missionEvents)
    .where(eq(missionEvents.missionId, missionId))
    .orderBy(desc(missionEvents.timestamp))
    .limit(limit)
    .offset(offset)
    .all() as MissionEvent[];

  const totalResult = db
    .select({ count: count() })
    .from(missionEvents)
    .where(eq(missionEvents.missionId, missionId))
    .get();

  return { events: result, total: totalResult?.count ?? 0 };
}

export function getMissionEventsByHabitatId(
  habitatId: string,
  limit = 50,
  offset = 0,
): { events: MissionEvent[]; total: number } {
  const db = getDb();

  const missionIds = db
    .select({ id: missions.id })
    .from(missions)
    .where(eq(missions.habitatId, habitatId))
    .all()
    .map((r) => r.id);

  if (missionIds.length === 0) return { events: [], total: 0 };

  const result = db
    .select()
    .from(missionEvents)
    .where(inArray(missionEvents.missionId, missionIds))
    .orderBy(desc(missionEvents.timestamp))
    .limit(limit)
    .offset(offset)
    .all() as MissionEvent[];

  const totalResult = db
    .select({ count: count() })
    .from(missionEvents)
    .where(inArray(missionEvents.missionId, missionIds))
    .get();

  return { events: result, total: totalResult?.count ?? 0 };
}
