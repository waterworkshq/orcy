import { getDb } from "../db/index.js";
import { automationRuleRuns, automationRules } from "../db/schema/index.js";
import { eq, and, desc, gte, lte, sql, inArray } from "drizzle-orm";
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

export function getHourlyRunCount(ruleId: string, nowIso: string): number {
  const oneHourAgo = new Date(new Date(nowIso).getTime() - 60 * 60 * 1000).toISOString();
  return getRunCountForRuleSince(ruleId, oneHourAgo, nowIso);
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
