/**
 * Human task metadata editing — the one owner of the permission predicate,
 * the identity digest, the connection-taking atomic save core, and the
 * route-facing wrapper (DESIGN §1). The agent PATCH path, lifecycle writers,
 * and the prioritization writer are untouched.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Task } from "@orcy/shared";
import { getDb } from "../../db/index.js";
import { habitats, missions, taskCreationEnvelopes, tasks, teamMembers, users } from "../../db/schema/index.js";
import { createEventWithClient } from "../../repositories/events/event-crud.js";
import { logger } from "../../lib/logger.js";
import { emitTransition } from "./transition-emitter.js";

type MetadataDbClient = ReturnType<typeof getDb>;

export const METADATA_PRIORITY_VALUES = ["low", "medium", "high", "critical"] as const;
export type MetadataPriority = (typeof METADATA_PRIORITY_VALUES)[number];

// ---------------------------------------------------------------------------
// Identity fence
// ---------------------------------------------------------------------------

export interface MetadataIdentityRef {
  taskId: string;
  missionId: string;
  habitatId: string;
  createdAt: string;
}

/**
 * SHA-256 over canonical `[taskId, missionId, habitatId, createdAt,
 * sortedEnvelopeEventIds]`. The sorted set makes an equal-timestamp
 * same-lineage restore change the digest (a new envelope event id appears),
 * while audit-event retention and latest-row choices are never hashed.
 */
export function computeMetadataEditIdentityWithClient(
  client: MetadataDbClient,
  ref: MetadataIdentityRef,
): string {
  const ids = client
    .select({ eventId: taskCreationEnvelopes.eventId })
    .from(taskCreationEnvelopes)
    .where(eq(taskCreationEnvelopes.taskId, ref.taskId))
    .all()
    .map((row) => row.eventId)
    .sort();
  return createHash("sha256")
    .update(JSON.stringify([ref.taskId, ref.missionId, ref.habitatId, ref.createdAt, ids]))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Permission predicate (PRD E2)
// ---------------------------------------------------------------------------

/**
 * Current persisted authority, read on the supplied client so the in-tx
 * re-check observes post-reservation state. JWT roles and prior hints never
 * grant the write. Stricter than habitat write access: un-teamed-open and
 * any-member semantics do not apply.
 */
export function humanMetadataWriteAllowedWithClient(
  client: MetadataDbClient,
  userId: string,
  habitatId: string,
): boolean {
  const user = client.select({ role: users.role }).from(users).where(eq(users.id, userId)).get();
  if (!user || user.role === "viewer") return false;
  const habitat = client
    .select({ teamId: habitats.teamId, ownerUserId: habitats.ownerUserId })
    .from(habitats)
    .where(eq(habitats.id, habitatId))
    .get();
  if (!habitat) return false;
  if (habitat.teamId) {
    const member = client
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, habitat.teamId), eq(teamMembers.userId, userId)))
      .get();
    return member !== undefined && (user.role === "editor" || user.role === "admin");
  }
  if (habitat.ownerUserId === userId) return user.role === "editor" || user.role === "admin";
  return user.role === "admin"; // persisted global admin; legacy ownerless personal habitats land here
}

// ---------------------------------------------------------------------------
// Eligibility + ancestry (PRD E3)
// ---------------------------------------------------------------------------

interface TaskMetadataRow {
  taskId: string;
  missionId: string;
  habitatId: string;
  createdAt: string;
  version: number;
  status: string;
  priority: string;
  title: string;
  description: string;
  assignedAgentId: string | null;
  remoteAssignedParticipantId: string | null;
  missionArchived: boolean | null;
}

export function resolveTaskMetadataRowWithClient(
  client: MetadataDbClient,
  taskId: string,
): TaskMetadataRow | null {
  return (
    client
      .select({
        taskId: tasks.id,
        missionId: tasks.missionId,
        habitatId: habitats.id,
        createdAt: tasks.createdAt,
        version: tasks.version,
        status: tasks.status,
        priority: tasks.priority,
        title: tasks.title,
        description: tasks.description,
        assignedAgentId: tasks.assignedAgentId,
        remoteAssignedParticipantId: tasks.remoteAssignedParticipantId,
        missionArchived: missions.isArchived,
      })
      .from(tasks)
      .innerJoin(missions, eq(missions.id, tasks.missionId))
      .innerJoin(habitats, eq(habitats.id, missions.habitatId))
      .where(eq(tasks.id, taskId))
      .get() ?? null
  );
}

export interface MetadataEditSnapshot {
  identity: string;
  missionId: string;
  habitatId: string;
  version: number;
  priority: string;
  title: string;
  description: string;
  allowed: boolean;
}

/** Coherent pre-assembly snapshot for the detail-route hint bracket. */
export function metadataEditSnapshotWithClient(
  client: MetadataDbClient,
  taskId: string,
  userId: string,
): MetadataEditSnapshot | null {
  const row = resolveTaskMetadataRowWithClient(client, taskId);
  if (!row) return null;
  const eligible =
    row.status === "pending" &&
    row.assignedAgentId === null &&
    row.remoteAssignedParticipantId === null &&
    !row.missionArchived;
  return {
    identity: computeMetadataEditIdentityWithClient(client, row),
    missionId: row.missionId,
    habitatId: row.habitatId,
    version: row.version,
    priority: row.priority,
    title: row.title,
    description: row.description,
    allowed: eligible && humanMetadataWriteAllowedWithClient(client, userId, row.habitatId),
  };
}

// ---------------------------------------------------------------------------
// Atomic save (PRD E6/E7) — pattern: updatePriorityForPlugin (pluginTaskOperations.ts)
// ---------------------------------------------------------------------------

export interface MetadataSaveInput {
  taskId: string;
  userId: string;
  expectedVersion: number;
  expectedTaskIdentity: string;
  title?: string;
  description?: string;
  priority?: MetadataPriority;
  expectedPriority?: MetadataPriority;
}

export type MetadataSaveOutcome =
  | { ok: true; task: Task; habitatId: string; changed: boolean }
  | { ok: false; code: "NOT_FOUND"; message: string }
  | { ok: false; code: "FORBIDDEN"; message: string }
  | { ok: false; code: "NOT_EDITABLE"; message: string }
  | { ok: false; code: "VERSION_CONFLICT"; message: string; currentVersion: number }
  | { ok: false; code: "CONTENTION"; message: string };

function busyLike(error: unknown): boolean {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  for (let current: unknown = error; current && typeof current === "object" && !seen.has(current);) {
    seen.add(current);
    const entry = current as { message?: unknown; code?: unknown; cause?: unknown };
    messages.push(String(entry.message ?? ""), String(entry.code ?? ""));
    current = entry.cause;
  }
  return /SQLITE_(?:BUSY|LOCKED)(?:_\w+)?|database (?:table |schema )?is locked/i.test(messages.join(" | "));
}

export function saveTaskMetadataWithClient(
  client: MetadataDbClient,
  input: MetadataSaveInput,
): MetadataSaveOutcome {
  try {
    client.run(sql`BEGIN IMMEDIATE`);
  } catch (error) {
    if (busyLike(error)) return { ok: false, code: "CONTENTION", message: "Task metadata writer could not acquire the database" };
    throw error;
  }
  let committed: { task: Task; habitatId: string; changedFields: string[]; eventId: string } | null = null;
  try {
    const row = resolveTaskMetadataRowWithClient(client, input.taskId);
    if (!row) {
      client.run(sql`ROLLBACK`);
      return { ok: false, code: "NOT_FOUND", message: "Task not found" };
    }
    if (!humanMetadataWriteAllowedWithClient(client, input.userId, row.habitatId)) {
      client.run(sql`ROLLBACK`);
      return { ok: false, code: "FORBIDDEN", message: "Cannot edit this task's metadata" };
    }
    if (
      row.status !== "pending" ||
      row.assignedAgentId !== null ||
      row.remoteAssignedParticipantId !== null ||
      row.missionArchived
    ) {
      client.run(sql`ROLLBACK`);
      return { ok: false, code: "NOT_EDITABLE", message: "Only unassigned pending tasks in non-archived missions can be edited" };
    }
    const identity = computeMetadataEditIdentityWithClient(client, row);
    if (identity !== input.expectedTaskIdentity) {
      client.run(sql`ROLLBACK`);
      return { ok: false, code: "VERSION_CONFLICT", message: "Task identity changed; reload the task", currentVersion: row.version };
    }
    if (row.version !== input.expectedVersion) {
      client.run(sql`ROLLBACK`);
      return { ok: false, code: "VERSION_CONFLICT", message: "Version conflict", currentVersion: row.version };
    }
    if (input.priority !== undefined && row.priority !== input.expectedPriority) {
      client.run(sql`ROLLBACK`);
      return { ok: false, code: "VERSION_CONFLICT", message: "Priority changed since the task was read", currentVersion: row.version };
    }

    const diff: { title?: string; description?: string; priority?: MetadataPriority } = {};
    if (input.title !== undefined && input.title !== row.title) diff.title = input.title;
    if (input.description !== undefined && input.description !== row.description) diff.description = input.description;
    if (input.priority !== undefined && input.priority !== row.priority) diff.priority = input.priority;

    if (Object.keys(diff).length === 0) {
      const unchanged = client.select().from(tasks).where(eq(tasks.id, input.taskId)).get() as Task;
      client.run(sql`ROLLBACK`);
      return { ok: true, task: unchanged, habitatId: row.habitatId, changed: false };
    }

    const preimage = client.select().from(tasks).where(eq(tasks.id, input.taskId)).get();
    if (!preimage) throw new Error("Task metadata preimage missing after successful prechecks");
    const now = new Date().toISOString();
    const conditions = [
      eq(tasks.id, input.taskId),
      eq(tasks.missionId, row.missionId),
      eq(tasks.version, input.expectedVersion),
      eq(tasks.status, "pending"),
      isNull(tasks.assignedAgentId),
      isNull(tasks.remoteAssignedParticipantId),
    ];
    if (input.priority !== undefined) conditions.push(eq(tasks.priority, input.expectedPriority!));
    const updated = client
      .update(tasks)
      .set({ ...diff, updatedAt: now, version: sql`${tasks.version} + 1` })
      .where(and(...conditions))
      .returning()
      .get();
    if (!updated) {
      // Unreachable after successful prechecks inside this reservation — a
      // trigger-forced miss is an infrastructure failure, never a fabricated
      // conflict (DESIGN §5). The outer catch rolls back and rethrows.
      throw new Error("Task metadata update produced no row after successful prechecks");
    }
    const postimage = client.select().from(tasks).where(eq(tasks.id, input.taskId)).get();
    const expected = { ...preimage, ...diff, updatedAt: now, version: row.version + 1 };
    if (!postimage || !isDeepStrictEqual(postimage, expected)) {
      throw new Error("Task metadata postimage mismatch");
    }
    const changedFields = Object.keys(diff);
    const event = createEventWithClient(client, {
      taskId: input.taskId,
      actorType: "human",
      actorId: input.userId,
      action: "updated",
      fromStatus: "pending",
      toStatus: "pending",
      metadata: { changedFields },
    });
    committed = { task: postimage, habitatId: row.habitatId, changedFields, eventId: event.id };
    client.run(sql`COMMIT`);
  } catch (error) {
    try {
      client.run(sql`ROLLBACK`);
    } catch {
      // already rolled back
    }
    throw error;
  }

  try {
    emitTransition(input.taskId, "updated", committed.habitatId, {
      actorType: "human",
      actorId: input.userId,
      oldStatus: "pending",
      newStatus: "pending",
      changedFields: committed.changedFields,
      metadata: { changedFields: committed.changedFields },
      task: committed.task,
      existingEventId: committed.eventId,
    });
  } catch (error) {
    logger.error({ err: error, taskId: input.taskId, eventId: committed.eventId, errorCode: "task_metadata_postlude_failed" },
      "Task metadata postlude failed after commit; committed state stands");
  }
  return { ok: true, task: committed.task, habitatId: committed.habitatId, changed: true };
}

/** Route-facing entry: the singleton connection. Workers call the core with their own client. */
export function saveTaskMetadata(input: MetadataSaveInput): MetadataSaveOutcome {
  return saveTaskMetadataWithClient(getDb(), input);
}
