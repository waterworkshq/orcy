/**
 * Durable Automation rule-run completion outbox (FU2).
 *
 * The frozen-revision delivery pipeline writes ONE row here — in the SAME
 * immediate transaction that terminalizes the delivery, the run, and the
 * inbox — so a crash cannot lose the completion subscriber event. A
 * drain/boot pass (`deliverAutomationCompletionOutbox` in the inbox service)
 * reads undelivered rows, invokes the completion hooks, and marks them
 * delivered; a crash mid-delivery leaves the row undelivered and the next
 * drain retries it.
 *
 * Dedup: `UNIQUE(run_id)` — exactly one completion per rule run. The
 * `INSERT OR IGNORE` makes a replay write a no-op.
 */
import { eq, isNull, asc, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";
import { automationRunCompletionOutbox } from "../db/schema/index.js";
import { repositoryCreateError, repositoryNotFoundError } from "../errors/repository.js";
import type { AutomationDbClient } from "./automationRuleRevision.js";

export interface AutomationRunCompletionOutboxRow {
  id: string;
  runId: string;
  ruleId: string;
  habitatId: string;
  outcome: string;
  createdAt: string;
  deliveredAt: string | null;
  deliveryAttempts: number;
  lastError: string | null;
}

export interface EnqueueCompletionInput {
  runId: string;
  ruleId: string;
  habitatId: string;
  outcome: string;
  now: string;
}

/**
 * Write one completion row inside the caller's transaction. Idempotent:
 * `INSERT OR IGNORE` on the `UNIQUE(run_id)` dedup key returns the existing
 * row untouched on replay.
 */
export function enqueueAutomationRunCompletion(
  input: EnqueueCompletionInput,
  client?: AutomationDbClient,
): AutomationRunCompletionOutboxRow {
  const db = client ?? getDb();
  const id = uuid();
  try {
    db.insert(automationRunCompletionOutbox)
      .values({
        id,
        runId: input.runId,
        ruleId: input.ruleId,
        habitatId: input.habitatId,
        outcome: input.outcome,
        createdAt: input.now,
        deliveredAt: null,
        deliveryAttempts: 0,
        lastError: null,
      })
      .onConflictDoNothing()
      .run();
  } catch (err) {
    throw repositoryCreateError("automationRunCompletionOutbox", err as Error, id);
  }

  const created = getCompletionByRunId(input.runId, db);
  if (!created) throw repositoryNotFoundError("automationRunCompletionOutbox", id);
  return created;
}

export function getCompletionByRunId(
  runId: string,
  client?: AutomationDbClient,
): AutomationRunCompletionOutboxRow | null {
  const db = client ?? getDb();
  const row = db
    .select()
    .from(automationRunCompletionOutbox)
    .where(eq(automationRunCompletionOutbox.runId, runId))
    .get();
  return row ? (row as unknown as AutomationRunCompletionOutboxRow) : null;
}

/** Undelivered completion rows (oldest first). */
export function listUndeliveredCompletions(
  options?: { limit?: number },
  client?: AutomationDbClient,
): AutomationRunCompletionOutboxRow[] {
  const db = client ?? getDb();
  const limit = options?.limit ?? 50;
  return db
    .select()
    .from(automationRunCompletionOutbox)
    .where(isNull(automationRunCompletionOutbox.deliveredAt))
    .orderBy(asc(automationRunCompletionOutbox.createdAt))
    .limit(limit)
    .all() as unknown as AutomationRunCompletionOutboxRow[];
}

/**
 * Mark a completion delivered (CAS on `delivered_at IS NULL` so a concurrent
 * deliverer cannot double-mark). Bumps `delivery_attempts` for observability.
 */
export function markCompletionDelivered(
  id: string,
  now: string,
  client?: AutomationDbClient,
): boolean {
  const db = client ?? getDb();
  const result = db.run(sql`
    UPDATE automation_run_completion_outbox
    SET delivered_at = ${now},
        delivery_attempts = delivery_attempts + 1,
        last_error = NULL
    WHERE id = ${id}
      AND delivered_at IS NULL
  `);
  const changes = (result as { changes?: number } | undefined)?.changes;
  if (typeof changes === "number") return changes === 1;
  const probe = db
    .select({ deliveredAt: automationRunCompletionOutbox.deliveredAt })
    .from(automationRunCompletionOutbox)
    .where(eq(automationRunCompletionOutbox.id, id))
    .get();
  return probe != null && probe.deliveredAt === now;
}

/**
 * Record a permanent delivery failure (e.g. the run row is gone) so the row
 * stops retrying forever. The completion hooks themselves are isolated
 * (per-hook errors are swallowed by `notifyAutomationRunCompleted`), so a
 * failed DELIVERY here means the row is undeliverable, not transiently busy.
 */
export function markCompletionDeliveryError(
  id: string,
  message: string,
  now: string,
  client?: AutomationDbClient,
): boolean {
  const db = client ?? getDb();
  db.run(sql`
    UPDATE automation_run_completion_outbox
    SET delivered_at = ${now},
        delivery_attempts = delivery_attempts + 1,
        last_error = ${message}
    WHERE id = ${id}
      AND delivered_at IS NULL
  `);
  return true;
}
