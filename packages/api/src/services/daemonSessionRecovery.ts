/**
 * Daemon worker contract — REC-05 terminal/crash/session-loss recovery.
 *
 * Two convergent mechanisms over the daemon session table:
 *
 *   - `driveDaemonSessionOutcome(sessionId)` — the post-terminal-write
 *     convergence seam BOTH transports call (the embedded
 *     `InProcessSessionUpdater.updateSession` and the daemon-auth
 *     `PATCH /daemon/sessions/:id` handler). Explicit branch by the task's
 *     current status; every seam re-validates atomically (the branch only
 *     chooses which guarded seam); NO null-fallthrough — a refused fail is
 *     never re-routed to the release seam, and a refused release is a no-op.
 *     DB-write failures THROW (caught at the call site, logged with a fixed
 *     code, retried by the sweep — the task-state ack + receipts make retry
 *     safe and idempotent).
 *
 *   - `sweepDaemonSessionOutcomes()` — the 60 s interval + boot pass. Two
 *     independent legs: (1) the task-side recovery leg resolves each
 *     active-tokened task's session by exact `(task_id, execution_token)`
 *     (never recency heuristics) and drives terminal ones; (2) the ghost
 *     terminalization leg frees `maxConcurrent`/per-agent capacity that
 *     dead-owner sessions permanently consume — INDEPENDENT of task state,
 *     without inferring task ownership, via the monotonic terminal guard
 *     with an in-tx heartbeat-freshness recheck (the revival race).
 *
 * User-settled policies (binding): P1 — a daemon whose DAEMON heartbeat
 * (`daemon_instances.lastHeartbeatAt`, ISO text — never `agents.lastHeartbeat`)
 * is ≥ exactly 10 minutes stale is a ghost owner (60 s sweep tolerance +
 * boot pass disclosed; effective detection 10–11 min). P2 — graceful stop
 * releases in-flight sessions with the EXISTING recovery effects, no retry
 * burn. Attribution is the auth-derived actorType: every write here is
 * `system`, so no agent-blamed pitfall can originate from this module.
 */
import { getDb } from "../db/index.js";
import { daemonInstances, tasks } from "../db/schema/index.js";
import { and, eq, sql } from "drizzle-orm";
import * as daemonRepo from "../repositories/daemon.js";
import * as taskRepo from "../repositories/task.js";
import { failTaskWithEffects } from "./effects/failureEffects.js";
import { releaseTaskWithEffects } from "./effects/releaseEffects.js";
import { emitTransitionNonRequired } from "./tasks/transition-emitter.js";
import { guardTransitionTop } from "./tasks/transitionBudget.js";
import { requestEffectDeliveryPass } from "./effects/effectDeliverer.js";
import { updateSessionStatusWithClient } from "../repositories/daemonSession.js";
import { logger } from "../lib/logger.js";
import type { Task } from "../models/index.js";

// Engine liveness probe (one-way dependency: daemonEngine registers its
// `isRunning` here at module scope; the recovery module never imports
// daemonEngine). Default `false` = the standalone/heartbeat-only semantics —
// exactly the contract's standalone branch, and the honest state whenever no
// embedded engine module has loaded in this process.
let engineLivenessProbe: (daemonId: string) => boolean = () => false;

/** Registered by daemonEngine at module scope (embedded liveness source). */
export function setEngineLivenessProbe(probe: (daemonId: string) => boolean): void {
  engineLivenessProbe = probe;
}

/** P1 — exactly 10 minutes (binding user policy). */
export const DAEMON_STALE_HEARTBEAT_MS = 10 * 60_000;

/** Default sweep cadence (the disclosed 60 s tolerance). */
export const DAEMON_SWEEP_INTERVAL_MS = 60_000;

/** Durable system provenance for every recovery write. */
export const DAEMON_RECOVERY_ACTOR = "daemon-recovery";

/** Closed drive outcome vocabulary (contract §driveDaemonSessionOutcome). */
export type DriveOutcome =
  | "ok_failed"
  | "ok_released"
  | "legacy_no_epoch"
  | "budget_refused"
  | "no_op_epoch_mismatch"
  | "no_op_task_terminal"
  | "no_op_session_active";

const TERMINAL_SESSION_STATUSES = new Set(["completed", "failed", "released", "lost"]);

/** Heartbeat freshness classification — numeric comparison, conservative on bad data. */
export type HeartbeatStaleness =
  | { stale: true }
  | { stale: false }
  | { skip: "unparseable" | "future_dated" };

/**
 * P1 staleness policy (numeric, no invented skew): NULL → stale (safe:
 * `createDaemon` initializes heartbeat-now at insert, so NULL is
 * anomalous-only); unparseable → skip reap + fixed-code log (caller);
 * future-dated (`> now`) → skip reap + log. Writers are uniformly
 * `toISOString()`, so `Date.parse` is exact.
 */
export function classifyHeartbeatStaleness(
  lastHeartbeatAt: string | null,
  now: number = Date.now(),
): HeartbeatStaleness {
  if (lastHeartbeatAt === null || lastHeartbeatAt === "") return { stale: true };
  const parsed = Date.parse(lastHeartbeatAt);
  if (Number.isNaN(parsed)) return { skip: "unparseable" };
  if (parsed > now) return { skip: "future_dated" };
  return { stale: now - parsed >= DAEMON_STALE_HEARTBEAT_MS };
}

/**
 * `driveDaemonSessionOutcome` — synchronous (better-sqlite3 all the way
 * down); DB-write failures throw to the caller. The intended epoch is the
 * SESSION's token, conveyed through the pre-image — never a fresh task read.
 */
export function driveDaemonSessionOutcome(sessionId: string): DriveOutcome {
  const session = daemonRepo.getSessionById(sessionId);
  if (!session) return "no_op_task_terminal";
  if (!TERMINAL_SESSION_STATUSES.has(session.status)) return "no_op_session_active";

  // Legacy gate: pre-migration sessions carry no epoch — task-side no-op (the
  // 30-min agent-stale fallback keeps its disclosed coverage); ghost
  // session-terminalization already happened at the sweep leg, independent
  // of this task-side decision.
  const sessionToken = session.executionToken ?? "";
  if (sessionToken === "") return "legacy_no_epoch";

  const task = taskRepo.getTaskById(session.taskId);
  if (!task) return "no_op_task_terminal";

  const habitatId = taskRepo.getHabitatIdForTask(session.taskId) ?? "";
  // Intended-epoch pre-image: the CURRENT task row with the SESSION's
  // conveyed epoch. A task re-claimed under a new epoch (E2) refuses inside
  // the act-tx with zero writes — E1's death never touches E2.
  const preImage = { ...task, executionToken: sessionToken } as Task;

  const deathStatus = session.status === "failed" || session.status === "lost";

  if (task.status === "in_progress" && deathStatus) {
    return driveFail(task, preImage, habitatId, `daemon_session_${session.status}`);
  }
  if (task.status === "claimed" && deathStatus) {
    return driveRelease(task, preImage, habitatId, "daemon_session_failed_never_started");
  }
  if (
    (task.status === "claimed" || task.status === "in_progress") &&
    (session.status === "completed" || session.status === "released")
  ) {
    return driveRelease(
      task,
      preImage,
      habitatId,
      session.status === "completed"
        ? "daemon_session_completed_no_submit"
        : "daemon_session_released",
    );
  }
  // submitted / terminal / any other shape: the guards would reject — no-op.
  return "no_op_task_terminal";
}

function driveFail(task: Task, preImage: Task, habitatId: string, reason: string): DriveOutcome {
  // Budget guard FIRST (refusal → no-op; never release a budget-refused
  // task). Refusals are write-free by construction apart from the guard's
  // own emit-once first-breach escalation.
  const budget = guardTransitionTop(task.id, habitatId, "system", "failed");
  if (budget.outcome === "refused") return "budget_refused";

  // Null refusal = epoch mismatch / status moved — NO release fallthrough.
  // (The worker deliberately does NOT pre-validate status: the branch above
  // already chose this seam, and the act-tx owns the atomic revalidation.)
  const result = failTaskWithEffects({
    taskId: task.id,
    actorId: DAEMON_RECOVERY_ACTOR,
    actorType: "system",
    reason,
    preImage,
  });
  if (!result) return "no_op_epoch_mismatch";

  emitTransitionNonRequired(task.id, "failed", habitatId, {
    actorType: "system",
    actorId: DAEMON_RECOVERY_ACTOR,
    oldStatus: preImage.status,
    newStatus: "failed",
    reason,
    metadata: { reason },
    task: result.task,
    existingEventId: result.eventId,
  });
  requestEffectDeliveryPass();
  return "ok_failed";
}

function driveRelease(task: Task, preImage: Task, habitatId: string, reason: string): DriveOutcome {
  const budget = guardTransitionTop(task.id, habitatId, "system", "released");
  if (budget.outcome === "refused") return "budget_refused";

  const result = releaseTaskWithEffects({
    taskId: task.id,
    actorId: DAEMON_RECOVERY_ACTOR,
    reason,
    preImage,
  });
  if (!result) return "no_op_epoch_mismatch";

  emitTransitionNonRequired(task.id, "released", habitatId, {
    actorType: "system",
    actorId: DAEMON_RECOVERY_ACTOR,
    oldStatus: preImage.status,
    newStatus: "pending",
    reason,
    metadata: { reason },
    task: result.task,
    existingEventId: result.eventId,
  });
  requestEffectDeliveryPass();
  return "ok_released";
}

/**
 * `sweepDaemonSessionOutcomes` — one idempotent pass. Every drive failure is
 * caught here and logged with a fixed code (the sweep retries next tick);
 * a throw never aborts the remaining sweep work.
 */
export function sweepDaemonSessionOutcomes(): void {
  sweepTaskSideLeg();
  sweepGhostLeg();
}

/** Task-side leg: active tokened tasks → session by exact (task_id, token). */
function sweepTaskSideLeg(): void {
  const db = getDb();
  const active = db
    .select({ id: tasks.id, token: tasks.executionToken })
    .from(tasks)
    .where(
      and(
        sql`${tasks.status} IN ('claimed', 'in_progress')`,
        sql`${tasks.executionToken} IS NOT NULL`,
      ),
    )
    .all();

  for (const row of active) {
    const session = daemonRepo.getSessionByTaskAndToken(row.id, row.token!);
    if (!session || !TERMINAL_SESSION_STATUSES.has(session.status)) continue;
    try {
      driveDaemonSessionOutcome(session.id);
    } catch {
      logger.error(
        { sessionId: session.id, taskId: row.id, errorCode: "daemon_recovery_db_write_failed" },
        "Daemon recovery drive failed; next sweep retries",
      );
    }
  }
}

/**
 * Ghost-terminalization leg — frees capacity even when the task is already
 * terminal or re-tokened (never infers task ownership). Dead-owner rule is
 * TRANSPORT-UNIFIED: spare while the embedded engine runs (`isRunning` —
 * the sweep never acts on a live engine, and standalone daemons are never
 * in that map, so for them the rule is heartbeat-only exactly as the
 * contract's standalone branch requires); otherwise the daemon heartbeat
 * decides, ≥ 10 min stale = ghost. The terminalization transaction re-reads
 * the heartbeat FRESH in-tx — a daemon that heartbeats again between the
 * sweep observation and the write is spared (revival race closed).
 */
function sweepGhostLeg(): void {
  const db = getDb();
  const rows = db
    .select({
      sessionId: sql<string>`s.id`,
      daemonId: sql<string>`s.daemon_id`,
    })
    .from(sql`daemon_sessions AS s`)
    .where(sql`s.status IN ('starting', 'running')`)
    .all();

  for (const row of rows) {
    if (engineLivenessProbe(row.daemonId)) continue; // live engine: never act
    const observed = readHeartbeat(row.daemonId);
    const classification = classifyHeartbeatStaleness(observed, Date.now());
    if ("skip" in classification) {
      logger.error(
        { daemonId: row.daemonId, errorCode: `daemon_recovery_heartbeat_${classification.skip}` },
        "Daemon heartbeat bad data; skipping reap",
      );
      continue;
    }
    if (!classification.stale) continue;

    if (!terminalizeGhostSession(row.daemonId, row.sessionId)) continue; // spared/lost race
    try {
      driveDaemonSessionOutcome(row.sessionId);
    } catch {
      logger.error(
        { sessionId: row.sessionId, errorCode: "daemon_recovery_db_write_failed" },
        "Daemon recovery drive failed after ghost terminalization; next sweep retries",
      );
    }
  }
}

function readHeartbeat(daemonId: string): string | null {
  const row = getDb()
    .select({ lastHeartbeatAt: daemonInstances.lastHeartbeatAt })
    .from(daemonInstances)
    .where(eq(daemonInstances.id, daemonId))
    .get();
  return row?.lastHeartbeatAt ?? null;
}

/**
 * One `BEGIN IMMEDIATE`: re-read the daemon heartbeat FRESH in-tx (revival
 * spare) + re-check the engine map in the same window, then the monotonic
 * `lost` write. Returns whether the session is now terminal (terminalized
 * here or already terminal by an earlier writer).
 */
function terminalizeGhostSession(daemonId: string, sessionId: string): boolean {
  const db = getDb();
  // BEGIN IMMEDIATE: reserves the writer lock BEFORE the freshness re-read,
  // so a heartbeat writer that committed first is VISIBLE in-tx, and a
  // heartbeat writer arriving later blocks until after our terminal write
  // commits (the lock serializes the race; the recheck decides it).
  return db.transaction(
    () => {
      if (engineLivenessProbe(daemonId)) return false;
      const inTx = classifyHeartbeatStaleness(readHeartbeat(daemonId), Date.now());
      // Revived in-tx (fresh heartbeat) or bad data: spared — never kill on the
      // stale observation once the authoritative in-tx read disagrees.
      if ("skip" in inTx || !inTx.stale) return false;

      const updated = updateSessionStatusWithClient(
        db,
        sessionId,
        "lost",
        "Recovered: daemon heartbeat lost (ghost sweep)",
      );
      return updated !== null && TERMINAL_SESSION_STATUSES.has(updated.status);
    },
    { behavior: "immediate" },
  );
}

/**
 * Verified-restart straggler cleanup — the ONLY start-time kill. The engine
 * starting locally proves the prior process dead (the embedded mirror of
 * standalone `recoverSessions`); every still-active session row of THIS
 * daemon is terminalized `lost` via the monotonic guard BEFORE the engine
 * serves its first claim. Sessions created by the newly started engine are
 * never marked (this runs before serving). Never reads `isRunning` or any
 * generation — heartbeat rules do not apply to a verified restart.
 */
export function cleanupDaemonSessionsOnStart(daemonId: string): number {
  const active = daemonRepo.getActiveSessionsByDaemonId(daemonId);
  let cleaned = 0;
  for (const session of active) {
    const updated = daemonRepo.updateSessionStatus(
      session.id,
      "lost",
      "Recovered: daemon restarted (verified start cleanup)",
    );
    if (updated && TERMINAL_SESSION_STATUSES.has(updated.status)) cleaned += 1;
    try {
      driveDaemonSessionOutcome(session.id);
    } catch {
      logger.error(
        { sessionId: session.id, errorCode: "daemon_recovery_db_write_failed" },
        "Daemon recovery drive failed during start cleanup; next sweep retries",
      );
    }
  }
  return cleaned;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sweep worker — interval + boot pass (interval-only start; the boot pass is
// owned by index.ts AFTER initDb, never at the pre-DB hook). Drives stay
// void-launched: they land or the next sweep recovers; stop() clears the
// timer so no interval keeps the process alive.
// ─────────────────────────────────────────────────────────────────────────────

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Starts the 60 s sweep interval (no-op if already running). */
export function startDaemonSessionSweep(intervalMs: number = DAEMON_SWEEP_INTERVAL_MS): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    try {
      sweepDaemonSessionOutcomes();
    } catch {
      logger.error(
        { errorCode: "daemon_recovery_sweep_failed" },
        "Daemon session recovery sweep pass failed",
      );
    }
  }, intervalMs);
}

/** Stops the sweep interval (drain-safe: in-flight synchronous passes finish). */
export function stopDaemonSessionSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
