import { getDb } from "../db/index.js";
import { automationRuleRuns, automationRules } from "../db/schema/index.js";
import { eq, and, desc, gte, lte, ne, sql, inArray } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { buildFingerprint } from "@orcy/shared";
import { isSqliteError } from "../errors/sqlite.js";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";
import type {
  AutomationRuleRun,
  AutomationRunStatus,
  AutomationSkipReason,
  AutomationConditionResult,
  AutomationActionResult,
  AutomationTargetType,
} from "@orcy/shared";

export interface StartRuleRunInput {
  ruleId: string;
  habitatId: string;
  triggerType: string;
  triggerEventId?: string | null;
  targetType?: AutomationTargetType | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  eventDedupeKey?: string | null;
  now?: string;
}

/**
 * Outcome of {@link startRuleRun}. The reservation contract:
 * - `created: true`  — a fresh run row was inserted (the caller owns it).
 * - `created: false` — a concurrent same-`(eventDedupeKey, ruleId)` insert won
 *   the reservation race; `run` is the EXISTING row owned by the other worker.
 *   The caller MUST NOT execute actions or mutate the run's status.
 *
 * When `eventDedupeKey` is absent/null (all existing scan / manual / skip
 * callers), the reservation is NOT engaged: every call inserts unconditionally
 * and returns `created: true`. This keeps periodic-scan synthetic trigger keys
 * (`scan:…`, `orphan:…`, `cluster:…`) completely unaffected.
 */
export interface StartRuleRunResult {
  run: AutomationRuleRun;
  created: boolean;
}

export function startRuleRun(input: StartRuleRunInput): StartRuleRunResult {
  const db = getDb();
  const id = uuid();
  const startedAt = input.now ?? new Date().toISOString();
  const fingerprint = buildFingerprint(
    input.habitatId,
    input.ruleId,
    input.triggerType,
    input.triggerEventId ?? null,
    input.targetType ?? null,
    input.targetId ?? null,
  );

  const dedupeKey = input.eventDedupeKey ?? null;

  try {
    db.insert(automationRuleRuns)
      .values({
        id,
        ruleId: input.ruleId,
        habitatId: input.habitatId,
        triggerType: input.triggerType,
        triggerEventId: input.triggerEventId ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        fingerprint,
        eventDedupeKey: dedupeKey,
        status: "running",
        skipReason: null,
        conditionResult: null,
        actionResults: null,
        metadata: (input.metadata ?? null) as Record<string, unknown> | null,
        startedAt,
        finishedAt: null,
      })
      .run();
  } catch (err) {
    if (dedupeKey && isUniqueConstraintViolation(err)) {
      const existing = db
        .select()
        .from(automationRuleRuns)
        .where(
          and(
            eq(automationRuleRuns.eventDedupeKey, dedupeKey),
            eq(automationRuleRuns.ruleId, input.ruleId),
          ),
        )
        .get();
      if (existing) {
        return { run: existing as unknown as AutomationRuleRun, created: false };
      }
    }
    throw repositoryCreateError("automationRuleRun", err as Error, id);
  }

  const created = getRuleRunById(id);
  if (!created) throw repositoryNotFoundError("automationRuleRun", id);
  return { run: created, created: true };
}

export function getRuleRunById(id: string): AutomationRuleRun | null {
  const db = getDb();
  const row = db.select().from(automationRuleRuns).where(eq(automationRuleRuns.id, id)).get();
  return row ? (row as unknown as AutomationRuleRun) : null;
}

export function listRunsByRule(
  ruleId: string,
  options?: { limit?: number; offset?: number },
): { runs: AutomationRuleRun[]; total: number } {
  const db = getDb();
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  const totalResult = db
    .select({ count: sql<number>`count(*)` })
    .from(automationRuleRuns)
    .where(eq(automationRuleRuns.ruleId, ruleId))
    .get();
  const total = totalResult?.count ?? 0;

  const rows = db
    .select()
    .from(automationRuleRuns)
    .where(eq(automationRuleRuns.ruleId, ruleId))
    .orderBy(desc(automationRuleRuns.startedAt))
    .limit(limit)
    .offset(offset)
    .all();

  return { runs: rows as unknown as AutomationRuleRun[], total };
}

export function listRunsByHabitat(
  habitatId: string,
  options?: {
    limit?: number;
    offset?: number;
    status?: AutomationRunStatus | AutomationRunStatus[];
  },
): { runs: AutomationRuleRun[]; total: number } {
  const db = getDb();
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  const conditions = [eq(automationRuleRuns.habitatId, habitatId)];
  if (options?.status) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    conditions.push(inArray(automationRuleRuns.status, statuses));
  }
  const where = and(...conditions);

  const totalResult = db
    .select({ count: sql<number>`count(*)` })
    .from(automationRuleRuns)
    .where(where)
    .get();
  const total = totalResult?.count ?? 0;

  const rows = db
    .select()
    .from(automationRuleRuns)
    .where(where)
    .orderBy(desc(automationRuleRuns.startedAt))
    .limit(limit)
    .offset(offset)
    .all();

  return { runs: rows as unknown as AutomationRuleRun[], total };
}

export function finishRuleRun(
  runId: string,
  outcome: {
    status: Extract<AutomationRunStatus, "succeeded" | "partial_failed" | "failed" | "simulated">;
    conditionResult?: AutomationConditionResult | null;
    actionResults?: AutomationActionResult[] | null;
    finishedAt?: string;
  },
): AutomationRuleRun {
  const db = getDb();
  const finishedAt = outcome.finishedAt ?? new Date().toISOString();

  const set: Record<string, unknown> = {
    status: outcome.status,
    finishedAt,
  };
  if (outcome.conditionResult !== undefined) {
    set.conditionResult = outcome.conditionResult as unknown as Record<string, unknown>;
  }
  if (outcome.actionResults !== undefined) {
    set.actionResults = outcome.actionResults as unknown as Record<string, unknown>[];
  }

  try {
    db.update(automationRuleRuns).set(set).where(eq(automationRuleRuns.id, runId)).run();
  } catch (err) {
    throw repositoryUpdateError("automationRuleRun", err as Error, runId);
  }

  const updated = getRuleRunById(runId);
  if (!updated) throw repositoryNotFoundError("automationRuleRun", runId);

  try {
    db.update(automationRules)
      .set({ lastRunAt: finishedAt })
      .where(eq(automationRules.id, updated.ruleId))
      .run();
  } catch {
    // best-effort: rule may have been deleted between run and finish
  }

  return updated;
}

export function skipRuleRun(
  runId: string,
  reason: AutomationSkipReason,
  metadata?: Record<string, unknown> | null,
): AutomationRuleRun {
  const db = getDb();
  const finishedAt = new Date().toISOString();

  try {
    db.update(automationRuleRuns)
      .set({
        status: "skipped",
        skipReason: reason,
        finishedAt,
        metadata: (metadata ?? null) as Record<string, unknown> | null,
      })
      .where(eq(automationRuleRuns.id, runId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("automationRuleRun", err as Error, runId);
  }

  const updated = getRuleRunById(runId);
  if (!updated) throw repositoryNotFoundError("automationRuleRun", runId);
  return updated;
}

/**
 * CS-56 T2 — Terminal status set accepted by the unified terminalization
 * primitive. Excludes `running` (a pre-terminal state) and `matched`
 * (a transient planning state never persisted to the runs table).
 */
export type TerminalRunStatus = Extract<
  AutomationRunStatus,
  "skipped" | "succeeded" | "partial_failed" | "failed" | "simulated"
>;

/**
 * Input for the unified terminalization primitive
 * ({@link terminalizeRuleRun}). Captures every field the canonical
 * lifecycle (T3) needs to persist across all terminal branches:
 *   - `status`: any of the {@link TerminalRunStatus} values.
 *   - `skipReason`: required iff `status === "skipped"`.
 *   - `conditionResult`: optional; populated on condition-evaluated
 *     branches (false/true/causal/kill-switch/failed-evaluation).
 *   - `actionResults`: optional; populated on action-attempted branches.
 *   - `metadata`: bounded diagnostic payload (no secrets, no full
 *     thrown objects, no untrusted headers — T3 will redact this).
 *   - `finishedAt`: optional override; defaults to now.
 */
export interface TerminalizeRuleRunInput {
  runId: string;
  status: TerminalRunStatus;
  skipReason?: AutomationSkipReason | null;
  conditionResult?: AutomationConditionResult | null;
  actionResults?: AutomationActionResult[] | null;
  metadata?: Record<string, unknown> | null;
  finishedAt?: string;
}

/**
 * Output of the unified terminalization primitive. Two values matter:
 *   - `run`: the refreshed row. When `transitioned: false` this is the
 *     existing terminal row (NOT mutated by this call), so callers can
 *     use it as the source of truth for emission (e.g., completion
 *     callback payload) and dedupe double-finalization correctly.
 *   - `transitioned`: `true` iff THIS call performed the running→terminal
 *     transition. A second finalization attempt reports `transitioned:
 *     false` and leaves the first terminal result unchanged.
 */
export interface TerminalizeRuleRunResult {
  run: AutomationRuleRun;
  transitioned: boolean;
}

/**
 * CS-56 T2 — Ownership-safe terminalization primitive. Unifies
 * {@link finishRuleRun} and {@link skipRuleRun} behind one operation
 * that can persist every terminal outcome a rule attempt may produce.
 *
 * Ownership safety: the UPDATE is a compare-and-set
 *   `UPDATE ... SET terminal fields WHERE id = ? AND status = 'running'`
 * so a concurrent finalization attempt (e.g., an error-handling path that
 * re-runs the seam) cannot clobber the first terminal result. The
 * refreshed row is returned in both cases; `transitioned: false` signals
 * the caller that this call did NOT own the transition.
 *
 * Cross-backend write-count detection: better-sqlite3 returns
 * `{changes: N}`; sql.js returns `true` (drizzle yields `undefined` for
 * `changes`); vitest mocks may return either. We coerce all three
 * representations to `boolean` via `(result as {changes?:number})?.changes`.
 * The terminal seam treats `changes === 1` as the ownership signal.
 *
 * Existing callers can keep using {@link finishRuleRun} and
 * {@link skipRuleRun} — both are compat wrappers around this primitive
 * until T3 wires the canonical lifecycle end-to-end.
 */
export function terminalizeRuleRun(
  input: TerminalizeRuleRunInput,
): TerminalizeRuleRunResult {
  const db = getDb();
  const finishedAt = input.finishedAt ?? new Date().toISOString();

  const set: Record<string, unknown> = {
    status: input.status,
    finishedAt,
  };
  if (input.skipReason !== undefined) {
    set.skipReason = input.skipReason;
  }
  if (input.conditionResult !== undefined) {
    set.conditionResult = input.conditionResult as unknown as Record<string, unknown>;
  }
  if (input.actionResults !== undefined) {
    set.actionResults = input.actionResults as unknown as Record<string, unknown>[];
  }
  if (input.metadata !== undefined) {
    set.metadata = (input.metadata ?? null) as Record<string, unknown> | null;
  }

  let result: unknown;
  try {
    result = db
      .update(automationRuleRuns)
      .set(set)
      .where(
        and(
          eq(automationRuleRuns.id, input.runId),
          eq(automationRuleRuns.status, "running"),
        ),
      )
      .run();
  } catch (err) {
    throw repositoryUpdateError("automationRuleRun", err as Error, input.runId);
  }

  // Cross-backend ownership detection: better-sqlite3 returns
  // `{changes: N}` from `.run()`; sql.js returns `true` (it does not
  // report a row-count). We normalize both via the `changes` field, and
  // when sql.js / mocks return no count, fall back to a post-update
  // compare against the status we just wrote to decide ownership.
  //
  // The compare-and-set UPDATE carries `WHERE status = 'running'`, so a
  // transition is detectable in two ways:
  //   (a) the better-sqlite3 path: `changes === 1` proves one row moved.
  //   (b) the sql.js / mocks path: a post-update SELECT shows the row
  //       now carries the exact `status` + `finishedAt` we wrote. If a
  //       prior terminalization had already moved the row to a terminal
  //       state, the WHERE clause matched zero rows → our `status` /
  //       `finishedAt` were not written, so the SELECT shows the prior
  //       terminal values instead.
  const rawChanges = (result as { changes?: number } | undefined)?.changes;
  let transitioned: boolean;
  if (typeof rawChanges === "number") {
    transitioned = rawChanges === 1;
  } else {
    const probe = db
      .select({ status: automationRuleRuns.status, finishedAt: automationRuleRuns.finishedAt })
      .from(automationRuleRuns)
      .where(eq(automationRuleRuns.id, input.runId))
      .get();
    transitioned =
      probe != null &&
      probe.status === input.status &&
      probe.finishedAt === finishedAt;
  }

  // Compare-and-set guarantees: when `transitioned === true`, the row
  // is now terminal; when `false`, the row was either already terminal or
  // missing. Either way, the post-update read returns the authoritative
  // current row. A missing row still throws — terminalizing a non-existent
  // run is a programming error, not a benign idempotent no-op.
  const refreshed = getRuleRunById(input.runId);
  if (!refreshed) throw repositoryNotFoundError("automationRuleRun", input.runId);

  if (transitioned) {
    // Mirror the existing best-effort lastRunAt bump from finishRuleRun.
    // Only the row that owned the transition may bump the rule's
    // lastRunAt; otherwise a redundant second-finalization would race-
    // rewrite it.
    try {
      db.update(automationRules)
        .set({ lastRunAt: finishedAt })
        .where(eq(automationRules.id, refreshed.ruleId))
        .run();
    } catch {
      // best-effort: rule may have been deleted between run and finish
    }
  }

  return { run: refreshed, transitioned };
}

export interface GetLastSuccessfulRunForFingerprintInput {
  habitatId: string;
  ruleId: string;
  triggerType: string;
  triggerEventId: string | null;
  targetType: string | null;
  targetId: string | null;
}

export function getLastSuccessfulRunForFingerprint(
  input: GetLastSuccessfulRunForFingerprintInput,
): AutomationRuleRun | null {
  const db = getDb();
  const fingerprint = buildFingerprint(
    input.habitatId,
    input.ruleId,
    input.triggerType,
    input.triggerEventId,
    input.targetType,
    input.targetId,
  );

  const row = db
    .select()
    .from(automationRuleRuns)
    .where(
      and(
        eq(automationRuleRuns.fingerprint, fingerprint),
        eq(automationRuleRuns.status, "succeeded"),
      ),
    )
    .orderBy(desc(automationRuleRuns.startedAt))
    .limit(1)
    .get();

  return row ? (row as unknown as AutomationRuleRun) : null;
}

export function getRunsByFingerprint(
  habitatId: string,
  fingerprint: string,
  options?: { limit?: number },
): AutomationRuleRun[] {
  const db = getDb();
  return db
    .select()
    .from(automationRuleRuns)
    .where(
      and(
        eq(automationRuleRuns.habitatId, habitatId),
        eq(automationRuleRuns.fingerprint, fingerprint),
      ),
    )
    .orderBy(desc(automationRuleRuns.startedAt))
    .limit(options?.limit ?? 20)
    .all() as unknown as AutomationRuleRun[];
}

export function getRunCountForRuleSince(
  ruleId: string,
  sinceIso: string,
  untilIso?: string,
): number {
  const db = getDb();
  const conditions = [
    eq(automationRuleRuns.ruleId, ruleId),
    gte(automationRuleRuns.startedAt, sinceIso),
  ];
  if (untilIso) {
    conditions.push(lte(automationRuleRuns.startedAt, untilIso));
  }
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(automationRuleRuns)
    .where(and(...conditions))
    .get();
  return result?.count ?? 0;
}

/**
 * CS-56 T2 — Skip reasons that intentionally do NOT consume the
 * hourly-admission budget. `cooldown` and `rate_limited` are pre-
 * admission rejections; `missing_target` is a target-validation
 * rejection. Dedupe losers never reach the DB. The boolean membership
 * is built from {@link AutomationSkipReason} so the type system enforces
 * that any new admission-discounted reason must be added here too.
 */
const NON_ADMITTING_SKIP_REASONS: ReadonlySet<AutomationSkipReason> = new Set<AutomationSkipReason>([
  "cooldown",
  "rate_limited",
  "missing_target",
]);

/**
 * CS-56 cold-review m1 — Admitted-attempt status set (terminal
 * non-skipped). The `running` reservation is admitted via
 * {@link ADMITTED_RUNNING_STATUSES} (separate so each branch can be
 * reasoned about independently); the `skipped` branch is admitted via
 * {@link ADMITTED_SKIPPED_PREDICATE_BUILDER} which couples the status to
 * `skipReason NOT IN non-admitting-set`.
 */
const ADMITTED_TERMINAL_STATUSES: ReadonlyArray<Exclude<AutomationRunStatus, "running" | "matched" | "simulated" | "skipped">> = [
  "succeeded",
  "partial_failed",
  "failed",
] as const;

/**
 * CS-56 cold-review m1 — `running` reservations count against the cap (so
 * the cap engages even if finalization is slow). The column is the literal
 * string `'running'`.
 */
const ADMITTED_RUNNING_STATUSES: ReadonlyArray<AutomationRunStatus> = ["running"] as const;

/**
 * CS-56 T2 — Count of admitted attempts in the last `[nowIso - 1h, nowIso]`
 * window. Replaces the all-row count returned by the legacy
 * {@link getHourlyRunCount} (kept as a compat wrapper below).
 *
 * "Admitted" attempts are the ones that legitimately consumed the rule's
 * hourly budget:
 *   - `running` (reservation still open; counted so the cap engages even
 *     if finalization is slow);
 *   - `succeeded`, `partial_failed`, `failed` (executed terminals);
 *   - `skipped` rows with `skipReason` in
 *     {`condition_false`, `causal_cycle`, `causal_depth_limit`,
 *      `disabled`, `loop_guard`}.
 *
 * Excluded rows:
 *   - `skipped` rows with `skipReason` in {`cooldown`, `rate_limited`,
 *     `missing_target`} — these are pre-admission rejections that, if
 *     counted, would extend the rate-limit window indefinitely under
 *     continuous rejected traffic.
 *   - Dedupe losers — they never create a row, so no exclusion needed.
 *   - `simulated` and `matched` — these are not produced by the live
 *     path (matches are run-state precursors that finalize to running or
 *     skipped before they would be observable in the hourly window).
 *
 * Membership is EXPLICIT (cold-review m1): the previous
 * `status != 'skipped'` formulation also admitted `simulated`/`matched`
 * rows. Today's canonical lifecycle never persists those, but the
 * membership is now explicit so a future refactor cannot regress the
 * accounting by adding a `simulated` row that consumes hourly budget.
 *
 * NULL `skipReason` semantics: rows whose status is `running` or a
 * non-skipped terminal always have `skipReason IS NULL`; the admission
 * branch for those statuses makes no reference to `skipReason`. The
 * `skipped` branch requires `skipReason NOT IN non-admitting-set`.
 */
export function countAdmittedAttemptsInWindow(
  ruleId: string,
  nowIso: string,
): number {
  const db = getDb();
  const oneHourAgo = new Date(new Date(nowIso).getTime() - 60 * 60 * 1000).toISOString();
  const conditions = [
    eq(automationRuleRuns.ruleId, ruleId),
    gte(automationRuleRuns.startedAt, oneHourAgo),
    lte(automationRuleRuns.startedAt, nowIso),
  ];

  // Explicit admission membership (cold-review m1). The branches are
  // disjoint so they cannot double-count: `running` is admitted via the
  // running branch only; non-skipped terminals are admitted via the
  // terminal branch only; `skipped` is admitted only when the
  // `skipReason` is NOT in the non-admitting set (and not NULL — see
  // the SQL ne(...) semantics below).
  const admitTerminalCondition = sql`(${automationRuleRuns.status} IN (${sql.join(
    ADMITTED_TERMINAL_STATUSES.map((s) => sql`${s}`),
    sql.raw(", "),
  )}) OR ${automationRuleRuns.status} IN (${sql.join(
    ADMITTED_RUNNING_STATUSES.map((s) => sql`${s}`),
    sql.raw(", "),
  )}))`;

  const nonAdmittingSkipConditions = Array.from(NON_ADMITTING_SKIP_REASONS).map((reason) =>
    ne(automationRuleRuns.skipReason, reason),
  );
  // Admit a `skipped` row only when its skipReason is NOT in the
  // non-admitting set (and not NULL — `ne(NULL, x)` is NULL in SQLite,
  // so the chain evaluates to NOT TRUE for NULL rows, excluding them).
  const admitSkippedCondition = sql`(${automationRuleRuns.status} = 'skipped' AND ${sql.join(
    nonAdmittingSkipConditions,
    sql` AND `,
  )})`;

  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(automationRuleRuns)
    .where(
      and(
        ...conditions,
        sql`(${admitTerminalCondition} OR ${admitSkippedCondition})`,
      ),
    )
    .get();
  return result?.count ?? 0;
}

/**
 * CS-56 T2 — compat wrapper. New callers should use
 * {@link countAdmittedAttemptsInWindow} directly. This wrapper keeps the
 * old name working for any existing call sites and tests; its semantics
 * have been narrowed to admit-only accounting as required by T2.
 */
export function getHourlyRunCount(ruleId: string, nowIso: string): number {
  return countAdmittedAttemptsInWindow(ruleId, nowIso);
}

export function getSkippedRunsByRule(
  ruleId: string,
  options?: { limit?: number; offset?: number },
): { runs: AutomationRuleRun[]; total: number } {
  const db = getDb();
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  const where = and(
    eq(automationRuleRuns.ruleId, ruleId),
    eq(automationRuleRuns.status, "skipped"),
  );

  const totalResult = db
    .select({ count: sql<number>`count(*)` })
    .from(automationRuleRuns)
    .where(where)
    .get();
  const total = totalResult?.count ?? 0;

  const rows = db
    .select()
    .from(automationRuleRuns)
    .where(where)
    .orderBy(desc(automationRuleRuns.startedAt))
    .limit(limit)
    .offset(offset)
    .all();

  return { runs: rows as unknown as AutomationRuleRun[], total };
}

export function deleteRunsForRule(ruleId: string): number {
  const db = getDb();
  try {
    const result = db.delete(automationRuleRuns).where(eq(automationRuleRuns.ruleId, ruleId)).run();
    return result.changes ?? 0;
  } catch (err) {
    throw repositoryUpdateError("automationRuleRun", err as Error, ruleId);
  }
}

const UNIQUE_CONSTRAINT_RE = /UNIQUE constraint failed/i;

/**
 * Cross-backend UNIQUE-constraint detector (mirrors the pattern in
 * `taskCreationAttempts.ts`). better-sqlite3 (production) throws a `SqliteError`
 * with `code === "SQLITE_CONSTRAINT_UNIQUE"` (drizzle-orm may wrap it, putting
 * the real error on `.cause`); sql.js (tests) throws a plain `Error` whose
 * `message` contains "UNIQUE constraint failed".
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  if (isSqliteError(err) && err.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  if (err instanceof Error && UNIQUE_CONSTRAINT_RE.test(err.message)) return true;
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error) {
    if (isSqliteError(cause) && cause.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
    if (UNIQUE_CONSTRAINT_RE.test(cause.message)) return true;
  }
  return false;
}
