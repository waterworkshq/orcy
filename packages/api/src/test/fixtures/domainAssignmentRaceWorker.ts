/**
 * domain_expert assignment race worker — REAL cross-process concurrency.
 *
 * Forked (own OS process, own better-sqlite3 file connection via production
 * `initDb`) by `domainAssignmentRace.test.ts`. Two synchronous better-sqlite3
 * connections cannot interleave on one event loop — only separate processes
 * produce genuine read/insert overlap on one DB file.
 *
 * Protocol (IPC):
 *   1. WORKER: dynamic-imports the service modules so the module graph loads
 *      BEFORE the race window (no import-time skew), then emits READY.
 *   2. PARENT: waits for every worker's READY, sends GO to each
 *      back-to-back.
 *   3. WORKER: on GO, runs `assignReviewers(taskId, habitatId)` and reports
 *      { ok, assignedCount, skipped, reason }.
 *
 * Usage: forked with argv [dbPath, taskId, habitatId].
 */
export interface AssignmentResultMessage {
  type: "RESULT";
  ok: boolean;
  assignedCount?: number;
  skipped?: boolean;
  reason?: string;
  error?: string;
}

async function main(): Promise<void> {
  const [dbPath, taskId, habitatId] = process.argv.slice(2);
  if (!dbPath || !taskId || !habitatId) {
    process.exitCode = 2;
    return;
  }

  // Load the module graph (and run idempotent migrations) before READY so the
  // race window contains only the assignment call itself.
  const { initDb, closeDb } = await import("../../db/index.js");
  const reviewAssignment = await import("../../services/reviewAssignmentService.js");

  await initDb(dbPath);

  process.on("message", (msg: { type?: string }) => {
    if (msg?.type !== "GO") return;
    // Test-only hang mode (ORCY_RACE_WORKER_HANG=1): swallow GO — never
    // reply, never exit — so the parent's bounded exit wait can prove its
    // timeout/kill path against a genuinely wedged child.
    if (process.env.ORCY_RACE_WORKER_HANG === "1") return;
    try {
      const result = reviewAssignment.assignReviewers(taskId, habitatId);
      const m: AssignmentResultMessage = {
        type: "RESULT",
        ok: true,
        assignedCount: result.assigned.length,
        skipped: result.skipped,
        reason: result.reason,
      };
      process.send?.(m);
    } catch (err) {
      const m: AssignmentResultMessage = {
        type: "RESULT",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      process.send?.(m);
    } finally {
      closeDb();
      // The open IPC channel holds the event loop alive — exit explicitly
      // once the result is out.
      process.exit(0);
    }
  });

  process.send?.({ type: "READY" });
}

void main();
