/**
 * Learning Loop extraction boot recovery.
 *
 * Mirrors `recoveryCoordinator.ts`'s boot-only, no-periodic-timer shape.
 * Two reconciliation passes at boot:
 *
 * 1. **Stale lease reconciliation** — find `running` attempts whose lease has
 *    expired, mark them `failed`, and create exactly one fenced child attempt
 *    on the same logical work item (next `attempt_no`, new lease generation).
 *    The child attempt re-runs extraction through `runExtraction`.
 *
 * 2. **Finalization reconciliation** — find work items in `running` status
 *    whose latest attempt has committed findings (persisted_count > 0) but
 *    the attempt/work terminalization failed (crash-after-commit-before-
 *    finalization). Repair terminal status/counts **without re-running or
 *    duplicating findings**. Findings remain discoverable through
 *    `first_attempt_id`.
 *
 * No periodic timer is scheduled; operators/tests may call the exported pass
 * on demand. The boot wiring in `index.ts` calls it once at startup.
 */
import { eq, and, lt, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  extractionAttempts,
  extractionWorkItems,
  extractedFindings,
} from "../db/schema/index.js";
import { logger } from "../lib/logger.js";
import {
  terminalizeWorkItemWithClient,
  getLatestAttemptWithClient,
  createAttemptWithClient,
} from "../repositories/extraction/index.js";
import { getChanges } from "../repositories/extraction/types.js";
import type { ExtractionDbClient } from "../repositories/extraction/types.js";

// ---------------------------------------------------------------------------
// Summary types
// ---------------------------------------------------------------------------

export interface ExtractionRecoverySummary {
  /** Stale running attempts discovered. */
  staleAttempts: number;
  /** Stale attempts marked failed. */
  failedAttempts: number;
  /** Child attempts created for stale-lease work items. */
  childAttemptsCreated: number;
  /** Work items in running status examined for finalization repair. */
  runningWorkItems: number;
  /** Work items whose terminal status was repaired. */
  repairedWorkItems: number;
}

// ---------------------------------------------------------------------------
// Stale-lease reconciliation
// ---------------------------------------------------------------------------

/**
 * Find `running` attempts whose lease has expired.
 * Returns rows with their parent work items for child-attempt creation.
 */
function findStaleRunningAttempts(
  db: ExtractionDbClient,
  nowIso: string,
): Array<{ attempt: typeof extractionAttempts.$inferSelect; workItem: typeof extractionWorkItems.$inferSelect }> {
  return db
    .select({
      attempt: extractionAttempts,
      workItem: extractionWorkItems,
    })
    .from(extractionAttempts)
    .innerJoin(extractionWorkItems, eq(extractionAttempts.workItemId, extractionWorkItems.id))
    .where(
      and(
        eq(extractionAttempts.status, "running"),
        lt(extractionAttempts.leaseExpiresAt, nowIso),
      ),
    )
    .all();
}

/**
 * Mark a stale attempt as failed (guarded by status = 'running').
 * Uses `SELECT changes()` for portable affected-row classification.
 */
function markAttemptFailed(
  db: ExtractionDbClient,
  attemptId: string,
  error: string,
): boolean {
  const now = new Date().toISOString();
  db.update(extractionAttempts)
    .set({
      status: "failed",
      error,
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(extractionAttempts.id, attemptId))
    .run();
  return getChanges(db) === 1;
}

// ---------------------------------------------------------------------------
// Finalization reconciliation
// ---------------------------------------------------------------------------

/**
 * Find work items in `running` status whose latest attempt has terminalized
 * with committed findings but the work item itself was never terminalized
 * (crash-after-commit-before-finalization).
 */
function findUnfinalizedWorkItems(
  db: ExtractionDbClient,
): Array<{ workItem: typeof extractionWorkItems.$inferSelect }> {
  // Work items still in running/pending status that have terminal attempts
  // with persisted findings.
  return db
    .select({ workItem: extractionWorkItems })
    .from(extractionWorkItems)
    .where(
      sql`${extractionWorkItems.status} IN ('running', 'pending')`,
    )
    .all();
}

/**
 * Check whether a work item has committed findings from a given attempt.
 */
function hasCommittedFindings(
  db: ExtractionDbClient,
  attemptId: string,
): boolean {
  const result = db
    .select({ count: sql<number>`count(*)::int` })
    .from(extractedFindings)
    .where(eq(extractedFindings.firstAttemptId, attemptId))
    .all()[0];
  return (result?.count ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Main reconciliation pass
// ---------------------------------------------------------------------------

/**
 * Run the boot-only extraction recovery reconciliation pass.
 *
 * This is intentionally bounded and idempotent: boot and operators/tests
 * may invoke it, but there is no periodic timer. It mirrors
 * `runRecoveryReconciliationPass` in `recoveryCoordinator.ts`.
 */
export function runExtractionReconciliationPass(): ExtractionRecoverySummary {
  const db = getDb();
  const nowIso = new Date().toISOString();

  const summary: ExtractionRecoverySummary = {
    staleAttempts: 0,
    failedAttempts: 0,
    childAttemptsCreated: 0,
    runningWorkItems: 0,
    repairedWorkItems: 0,
  };

  // --- Pass 1: stale-lease reconciliation ---

  const staleRows = findStaleRunningAttempts(db, nowIso);
  summary.staleAttempts = staleRows.length;

  for (const row of staleRows) {
    const attempt = row.attempt;
    const workItem = row.workItem;

    // Mark the stale attempt as failed.
    const failed = markAttemptFailed(db, attempt.id, "lease_expired_boot_recovery");
    if (!failed) {
      // Another process already terminalized this attempt.
      continue;
    }
    summary.failedAttempts++;

    // Check if this attempt had committed findings.
    const hadFindings = attempt.persistedCount > 0;

    if (hadFindings) {
      // The attempt committed findings before crashing. Repair the work item
      // terminal status based on the committed outcome rather than creating
      // a child re-run (findings remain discoverable via first_attempt_id).
      const workStatus = attempt.persistedCount > 0 && attempt.candidateCount > attempt.persistedCount
        ? "partial"
        : "succeeded";
      const workResult = terminalizeWorkItemWithClient(db, {
        workItemId: workItem.id,
        attemptId: attempt.id,
        status: workStatus,
      });
      if (workResult.outcome === "terminalized") {
        summary.repairedWorkItems++;
      }
      continue;
    }

    // No committed findings — create a child attempt for the same work item.
    // The child gets the next attempt_no and a new lease generation.
    try {
      const childLeaseOwner = `extraction:boot_recovery:${process.pid ?? "unknown"}`;
      const childLeaseGeneration = attempt.leaseGeneration + 1;
      const childLeaseExpiresAt = new Date(
        Date.parse(nowIso) + 300 * 1000,
      ).toISOString();

      const childResult = createAttemptWithClient(db, {
        workItemId: workItem.id,
        parentAttemptId: attempt.id,
        deliveryMode: "boot_recovery",
        leaseOwner: childLeaseOwner,
        leaseGeneration: childLeaseGeneration,
        leaseExpiresAt: childLeaseExpiresAt,
      });

      if (childResult.outcome === "created") {
        summary.childAttemptsCreated++;
      }
    } catch (err) {
      logger.error(
        { err, workItemId: workItem.id, staleAttemptId: attempt.id },
        "Failed to create boot-recovery child attempt",
      );
    }
  }

  // --- Pass 2: finalization reconciliation ---

  const unfinalized = findUnfinalizedWorkItems(db);
  summary.runningWorkItems = unfinalized.length;

  for (const row of unfinalized) {
    const workItem = row.workItem;

    // Get the latest attempt for this work item.
    const latest = getLatestAttemptWithClient(db, workItem.id);
    if (!latest) continue;

    // If the latest attempt is terminal and has committed findings, repair
    // the work item status.
    if (latest.status === "running") continue; // Still running, skip.
    if (latest.status === "skipped") {
      // A skipped attempt means the work item should be skipped too.
      const result = terminalizeWorkItemWithClient(db, {
        workItemId: workItem.id,
        attemptId: latest.id,
        status: "skipped",
      });
      if (result.outcome === "terminalized") summary.repairedWorkItems++;
      continue;
    }

    // Terminal (succeeded/partial/failed) — repair work item if it has findings.
    if (latest.persistedCount > 0 || hasCommittedFindings(db, latest.id)) {
      const workStatus = latest.status === "failed" ? "partial" : latest.status;
      const result = terminalizeWorkItemWithClient(db, {
        workItemId: workItem.id,
        attemptId: latest.id,
        status: workStatus as "succeeded" | "partial" | "failed",
      });
      if (result.outcome === "terminalized") summary.repairedWorkItems++;
    } else if (latest.status === "failed") {
      // Failed with no findings — mark the work item as failed.
      const result = terminalizeWorkItemWithClient(db, {
        workItemId: workItem.id,
        attemptId: latest.id,
        status: "failed",
      });
      if (result.outcome === "terminalized") summary.repairedWorkItems++;
    }
  }

  if (summary.staleAttempts > 0 || summary.repairedWorkItems > 0) {
    logger.info(summary, "Extraction boot recovery reconciliation completed");
  }

  return summary;
}
