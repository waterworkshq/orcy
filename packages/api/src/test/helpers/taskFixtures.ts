/**
 * TEST-ONLY privileged task fixture writer (explicit legacy seeding).
 *
 * Production code must NEVER import this module: it writes the
 * authority-bearing task fields (status / assignee / execution token /
 * lifecycle clocks / provenance pointers) that the review-safety cutover
 * fenced out of the exported generic `taskRepo.updateTask`. It exists so
 * fixtures can construct arbitrary historical shapes directly — the same
 * license the raw SQL fixtures already have — and it is pinned to src/test by
 * the production-callsite boundary guard test.
 *
 * Semantics mirror the old privileged updateTask arm: optional
 * `expectedVersion` optimistic check, `updatedAt` refresh, `version+1`.
 */
import { getDb } from "../../db/index.js";
import { tasks } from "../../db/schema/index.js";
import { eq, sql } from "drizzle-orm";
import type { Task } from "../../models/index.js";

export interface FixtureTaskUpdateInput {
  title?: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "critical";
  requiredDomain?: string | null;
  requiredCapabilities?: string[];
  status?:
    | "pending"
    | "claimed"
    | "in_progress"
    | "submitted"
    | "approved"
    | "rejected"
    | "done"
    | "failed";
  remoteAssignedParticipantId?: string | null;
  result?: string | null;
  assignedAgentId?: string | null;
  delegatedToAgentId?: string | null;
  executionToken?: string | null;
  claimedAt?: string | null;
  startedAt?: string | null;
  submittedAt?: string | null;
  completedAt?: string | null;
  lastFailureEventId?: string | null;
  lastReleaseEventId?: string | null;
  rejectedCount?: number;
  rejectionReason?: string | null;
  retryCount?: number;
  nextRetryAt?: string | null;
  estimatedMinutes?: number | null;
  actualMinutes?: number | null;
  cycleTimeMinutes?: number | null;
  leadTimeMinutes?: number | null;
  estimationAccuracy?: number | null;
  artifacts?: unknown;
}

export type FixtureTaskUpdateResult =
  | { success: true; task: Task }
  | { success: false; notFound: true }
  | { success: false; versionMismatch: true; currentVersion: number };

export function updateTaskFixtureForTests(
  id: string,
  input: FixtureTaskUpdateInput,
  expectedVersion?: number,
): FixtureTaskUpdateResult {
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

  const set: Record<string, unknown> = { updatedAt: now };
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) set[key] = value;
  }

  db.update(tasks)
    .set({ ...set, version: sql`${tasks.version} + 1` } as never)
    .where(eq(tasks.id, id))
    .run();

  const task = db.select().from(tasks).where(eq(tasks.id, id)).get() as
    | (typeof tasks.$inferSelect)
    | undefined;
  return { success: true, task: task as unknown as Task };
}
