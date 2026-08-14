/**
 * Immutable executable Automation rule revisions.
 *
 * Every rule create/mutation records a full executable snapshot (trigger,
 * condition, actions, enabled/match inputs, limits) plus a canonical digest,
 * author, and time. Revisions are append-only and deliberately NOT
 * foreign-keyed to `automation_rules`: deleting the live rule must not delete
 * revisions referenced by delivery history — the frozen revision remains the
 * executable intent for any pending delivery.
 */
import { createHash } from "node:crypto";
import { eq, desc, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";
import { automationRuleRevisions } from "../db/schema/index.js";
import { repositoryCreateError, repositoryNotFoundError } from "../errors/repository.js";
import type { AutomationRule } from "@orcy/shared";

/** Supplied-client database type (same convention as the finding-triage lifecycle). */
export type AutomationDbClient = ReturnType<typeof getDb>;

/** Persisted immutable executable revision row. */
export interface AutomationRuleRevision {
  id: string;
  ruleId: string;
  habitatId: string;
  revisionNumber: number;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  trigger: Record<string, unknown>;
  condition: Record<string, unknown>;
  actions: Record<string, unknown>[];
  cooldownSeconds: number;
  maxRunsPerHour: number;
  digest: string;
  authorType: string;
  authorId: string;
  createdAt: string;
}

/** Attribution recorded on each revision. */
export interface RevisionAuthor {
  type: string;
  id: string;
}

/**
 * Canonical JSON stringification: recursively key-sorted, stable across
 * engines, so the digest of identical executable intent is identical.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Versioned canonical digest of a revision's executable intent. */
export function computeRevisionDigest(input: {
  trigger: unknown;
  condition: unknown;
  actions: unknown;
  enabled: boolean;
  cooldownSeconds: number;
  maxRunsPerHour: number;
}): string {
  const canonical = canonicalJson({
    trigger: input.trigger,
    condition: input.condition,
    actions: input.actions,
    enabled: input.enabled,
    cooldownSeconds: input.cooldownSeconds,
    maxRunsPerHour: input.maxRunsPerHour,
  });
  return `v1:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Append one immutable revision for the given rule state. The revision number
 * is allocated as MAX(revision_number)+1 inside the caller's transaction
 * (callers wrap rule write + revision write in one immediate tx).
 */
export function createRuleRevision(
  rule: Pick<
    AutomationRule,
    | "id"
    | "habitatId"
    | "name"
    | "description"
    | "enabled"
    | "priority"
    | "trigger"
    | "condition"
    | "actions"
    | "cooldownSeconds"
    | "maxRunsPerHour"
  >,
  author: RevisionAuthor,
  client?: AutomationDbClient,
): AutomationRuleRevision {
  const db = client ?? getDb();
  const id = uuid();
  const now = new Date().toISOString();

  const maxRow = db
    .select({ max: sql<number | null>`MAX(${automationRuleRevisions.revisionNumber})` })
    .from(automationRuleRevisions)
    .where(eq(automationRuleRevisions.ruleId, rule.id))
    .get();
  const revisionNumber = (maxRow?.max ?? 0) + 1;

  const digest = computeRevisionDigest({
    trigger: rule.trigger,
    condition: rule.condition,
    actions: rule.actions,
    enabled: rule.enabled,
    cooldownSeconds: rule.cooldownSeconds,
    maxRunsPerHour: rule.maxRunsPerHour,
  });

  try {
    db.insert(automationRuleRevisions)
      .values({
        id,
        ruleId: rule.id,
        habitatId: rule.habitatId,
        revisionNumber,
        name: rule.name,
        description: rule.description ?? "",
        enabled: rule.enabled,
        priority: rule.priority ?? 0,
        trigger: rule.trigger as Record<string, unknown>,
        condition: rule.condition as Record<string, unknown>,
        actions: rule.actions as Record<string, unknown>[],
        cooldownSeconds: rule.cooldownSeconds,
        maxRunsPerHour: rule.maxRunsPerHour,
        digest,
        authorType: author.type,
        authorId: author.id,
        createdAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("automationRuleRevision", err as Error, id);
  }

  const created = getRuleRevisionById(id, db);
  if (!created) throw repositoryNotFoundError("automationRuleRevision", id);
  return created;
}

export function getRuleRevisionById(
  id: string,
  client?: AutomationDbClient,
): AutomationRuleRevision | null {
  const db = client ?? getDb();
  const row = db
    .select()
    .from(automationRuleRevisions)
    .where(eq(automationRuleRevisions.id, id))
    .get();
  return row ? (row as unknown as AutomationRuleRevision) : null;
}

export function getLatestRuleRevision(
  ruleId: string,
  client?: AutomationDbClient,
): AutomationRuleRevision | null {
  const db = client ?? getDb();
  const row = db
    .select()
    .from(automationRuleRevisions)
    .where(eq(automationRuleRevisions.ruleId, ruleId))
    .orderBy(desc(automationRuleRevisions.revisionNumber))
    .limit(1)
    .get();
  return row ? (row as unknown as AutomationRuleRevision) : null;
}

export function listRuleRevisions(ruleId: string): AutomationRuleRevision[] {
  const db = getDb();
  return db
    .select()
    .from(automationRuleRevisions)
    .where(eq(automationRuleRevisions.ruleId, ruleId))
    .orderBy(desc(automationRuleRevisions.revisionNumber))
    .all() as unknown as AutomationRuleRevision[];
}

/**
 * Materialize a revision back into the `AutomationRule` shape consumed by the
 * canonical lifecycle. `id` is the LIVE rule lineage id (`revision.ruleId`) so
 * fingerprints, cooldown/rate accounting, and run lineage stay stable. This
 * object is never written back to `automation_rules` — it exists only as the
 * frozen executable input to `attemptRuleRun`.
 */
export function materializeRuleFromRevision(revision: AutomationRuleRevision): AutomationRule {
  return {
    id: revision.ruleId,
    habitatId: revision.habitatId,
    name: revision.name,
    description: revision.description,
    enabled: revision.enabled,
    priority: revision.priority,
    trigger: revision.trigger as unknown as AutomationRule["trigger"],
    condition: revision.condition as unknown as AutomationRule["condition"],
    actions: revision.actions as unknown as AutomationRule["actions"],
    cooldownSeconds: revision.cooldownSeconds,
    maxRunsPerHour: revision.maxRunsPerHour,
    createdBy: `${revision.authorType}:${revision.authorId}`,
    createdAt: revision.createdAt,
    updatedAt: revision.createdAt,
    lastRunAt: null,
  };
}
