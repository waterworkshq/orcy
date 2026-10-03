import { getDb } from "../db/index.js";
import { tasks, missions } from "../db/schema/index.js";
import { eq, and, max, sql } from "drizzle-orm";
import type { Task, TaskStatus, TaskPriority, Artifact, RetryPolicy } from "../models/index.js";
import { v4 as uuid } from "uuid";
import { normalizeTaskId } from "@orcy/shared";
import { insertUncapturedRequirementWithClient } from "./reviewSafety.js";

export interface CreateTaskInput {
  missionId: string;
  title: string;
  description?: string;
  labels?: string[];
  priority?: TaskPriority;
  requiredDomain?: string | null;
  requiredCapabilities?: string[];
  createdBy: string;
  order?: number;
  estimatedMinutes?: number | null;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  requiredDomain?: string | null;
  requiredCapabilities?: string[];
  result?: string | null;
  artifacts?: Artifact[];
  rejectedCount?: number;
  rejectionReason?: string | null;
  delegatedToAgentId?: string | null;
  estimatedMinutes?: number | null;
  retryPolicy?: RetryPolicy | null;
  retryCount?: number;
  nextRetryAt?: string | null;
  actualMinutes?: number | null;
  cycleTimeMinutes?: number | null;
  leadTimeMinutes?: number | null;
  estimationAccuracy?: number | null;
  /** Claim-epoch identity. System writers ONLY (clears to NULL) — excluded from the route zod schema. */
  /** Failure-provenance pointer (T2 §B.0). System writers ONLY (clears to NULL at the next epoch/terminal write) — excluded from the route zod schema. */
  /** Release-provenance pointer (migration 0080). System writers ONLY (clears to NULL whenever the task leaves the unclaimed pending shape) — excluded from the route zod schema. */
}

export function createTask(input: CreateTaskInput): Task {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  let order = input.order;
  if (order === undefined) {
    const result = db
      .select({ maxOrder: max(tasks.order) })
      .from(tasks)
      .where(eq(tasks.missionId, input.missionId))
      .get();
    order = (result?.maxOrder ?? -1) + 1;
  }

  // One immediate writer reservation owns BOTH writes: the Task row and its
  // birth-state `uncaptured` review requirement row commit atomically (a
  // Task must never exist without a legal requirement row).
  db.transaction(
    (tx) => {
      tx.insert(tasks)
        .values({
          id,
          missionId: input.missionId,
          title: input.title,
          description: input.description ?? "",
          priority: input.priority ?? "medium",
          requiredDomain: input.requiredDomain ?? null,
          requiredCapabilities: input.requiredCapabilities ?? [],
          status: "pending",
          labels: input.labels ?? [],
          order,
          createdBy: input.createdBy,
          estimatedMinutes: input.estimatedMinutes ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      insertUncapturedRequirementWithClient(tx, id);
    },
    { behavior: "immediate" },
  );

  return getTaskById(id)!;
}

export function getTaskByTitle(missionId: string, title: string): Task | null {
  const db = getDb();
  return (
    db
      .select()
      .from(tasks)
      .where(and(eq(tasks.missionId, missionId), eq(tasks.title, title)))
      .get() ?? null
  );
}

export function getTaskById(id: string): Task | null {
  const db = getDb();
  const normalized = normalizeTaskId(id);
  return db.select().from(tasks).where(eq(tasks.id, normalized)).get() ?? null;
}

/**
 * EXACT persisted-id Task read — no `feat-` normalization at all.
 *
 * URL/MCP alias semantics are a property of `getTaskById` and stay there; this
 * is the repository-owned seam for callers that must confirm the literal
 * persisted row they were handed. A normalized lookup is not sufficient for
 * that: it can resolve an alias spelling to a DIFFERENT row, or resolve nothing
 * and silently suppress the row that actually exists, so an authorization
 * decision built on it would answer about the wrong identity.
 */
export function getTaskByIdExact(id: string): Task | null {
  const db = getDb();
  return db.select().from(tasks).where(eq(tasks.id, id)).get() ?? null;
}

export type UpdateTaskResult =
  | { success: true; task: Task }
  | { success: false; notFound: true }
  | { success: false; versionMismatch: true; currentVersion: number };

// Review-safety authority fence: these authority-bearing fields can NEVER
// pass the exported generic update — neither statically (removed from
// UpdateTaskInput) nor at runtime (an input carrying one THROWS; `as any`
// callers fail loudly instead of silently stripping). Status/assignee/token
// writes belong to the guarded lifecycle/effects/retry writers only.
const FENCED_UPDATE_FIELDS = [
  "status",
  "assignedAgentId",
  "executionToken",
  "claimedAt",
  "startedAt",
  "submittedAt",
  "completedAt",
  "lastFailureEventId",
  "lastReleaseEventId",
] as const;

function assertNoFencedUpdateFields(id: string, input: UpdateTaskInput): void {
  const record = input as Record<string, unknown>;
  for (const field of FENCED_UPDATE_FIELDS) {
    if (field in record && record[field] !== undefined) {
      throw new Error(
        `updateTask refuses authority-bearing field "${field}" on task ${id} — use the guarded lifecycle/effects/retry writer`,
      );
    }
  }
}

export function updateTask(
  id: string,
  input: UpdateTaskInput,
  expectedVersion?: number,
): UpdateTaskResult {
  assertNoFencedUpdateFields(id, input);
  const db = getDb();
  const now = new Date().toISOString();

  if (expectedVersion !== undefined) {
    const existing = db
      .select({ id: tasks.id, version: tasks.version })
      .from(tasks)
      .where(eq(tasks.id, id))
      .get();
    if (!existing) return { success: false, notFound: true };
    if (existing.version !== expectedVersion) {
      return { success: false, versionMismatch: true, currentVersion: existing.version };
    }
  } else {
    const existing = db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)).get();
    if (!existing) return { success: false, notFound: true };
  }

  const set: Partial<typeof tasks.$inferInsert> = { updatedAt: now };

  if (input.title !== undefined) set.title = input.title;
  if (input.description !== undefined) set.description = input.description;
  if (input.priority !== undefined) set.priority = input.priority;
  if (input.requiredDomain !== undefined) set.requiredDomain = input.requiredDomain;
  if (input.requiredCapabilities !== undefined)
    set.requiredCapabilities = input.requiredCapabilities;
  if (input.result !== undefined) set.result = input.result;
  if (input.artifacts !== undefined) set.artifacts = input.artifacts;
  if (input.rejectedCount !== undefined) set.rejectedCount = input.rejectedCount;
  if (input.rejectionReason !== undefined) set.rejectionReason = input.rejectionReason;
  if (input.delegatedToAgentId !== undefined) set.delegatedToAgentId = input.delegatedToAgentId;
  if (input.estimatedMinutes !== undefined) set.estimatedMinutes = input.estimatedMinutes;
  if (input.retryPolicy !== undefined) set.retryPolicy = input.retryPolicy;
  if (input.retryCount !== undefined) set.retryCount = input.retryCount;
  if (input.nextRetryAt !== undefined) set.nextRetryAt = input.nextRetryAt;
  if (input.actualMinutes !== undefined) set.actualMinutes = input.actualMinutes;
  if (input.cycleTimeMinutes !== undefined) set.cycleTimeMinutes = input.cycleTimeMinutes;
  if (input.leadTimeMinutes !== undefined) set.leadTimeMinutes = input.leadTimeMinutes;
  if (input.estimationAccuracy !== undefined) set.estimationAccuracy = input.estimationAccuracy;
  // Execution token (claim-epoch identity): system writers (retry ladder)
  // clear it to NULL on ownership-ending transitions. NOT part of the zod
  // UpdateTaskInput surface — routes can never write it.
  // Failure-provenance pointer: same system-writer-only discipline as the
  // token above (never reachable through any route zod schema).

  db.update(tasks)
    .set({ ...set, version: sql`${tasks.version} + 1` })
    .where(eq(tasks.id, id))
    .run();
  const task = getTaskById(id);
  return { success: true, task: task! };
}

export function touchLastActivity(id: string):
  | { success: true; task: Task }
  | { success: false; notFound: true } {
  const db = getDb();

  const existing = db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)).get();
  if (!existing) return { success: false, notFound: true };

  db.update(tasks)
    .set({ lastActivityAt: new Date().toISOString() })
    .where(eq(tasks.id, id))
    .run();

  const task = getTaskById(id);
  return { success: true, task: task! };
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  requiredDomain?: string | null;
  requiredCapabilities?: string[];
  result?: string | null;
  artifacts?: Artifact[];
  rejectedCount?: number;
  rejectionReason?: string | null;
  delegatedToAgentId?: string | null;
  estimatedMinutes?: number | null;
  retryPolicy?: RetryPolicy | null;
  retryCount?: number;
  nextRetryAt?: string | null;
  actualMinutes?: number | null;
  cycleTimeMinutes?: number | null;
  leadTimeMinutes?: number | null;
  estimationAccuracy?: number | null;
}

export function deleteTask(id: string): void {
  const db = getDb();
  db.delete(tasks).where(eq(tasks.id, id)).run();
}

export function addArtifact(
  taskId: string,
  artifact: { type: string; url: string; description: string; createdAt?: string },
): boolean {
  const task = getTaskById(taskId);
  if (!task) return false;
  const now = new Date().toISOString();
  const newArtifact = { ...artifact, createdAt: artifact.createdAt ?? now } as Artifact;
  const updated = [...task.artifacts, newArtifact];
  const db = getDb();
  db.update(tasks).set({ artifacts: updated, updatedAt: now }).where(eq(tasks.id, taskId)).run();
  return true;
}

export function getMissionIdForTask(taskId: string): string | null {
  const task = getTaskById(taskId);
  return task?.missionId ?? null;
}

export function getHabitatIdForTask(taskId: string): string | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  const db = getDb();
  const mission = db
    .select({ habitatId: missions.habitatId })
    .from(missions)
    .where(eq(missions.id, task.missionId))
    .get();
  return mission?.habitatId ?? null;
}
