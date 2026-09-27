/**
 * Merge-as-approval — the full guarded operation, INSIDE the webhook trust
 * boundary (review-safety fixup-2, blocker 1).
 *
 * The exported operation accepts ONLY verified wire material:
 * `{ provider, rawBody, signature? (GitHub), token? (GitLab) }`. Every
 * authoritative field — merged action, immutable repository/project id,
 * display repo, PR/MR number, and the linked Task — is PARSED from the
 * verified body and DERIVED under the reservation; no caller-supplied
 * taskId/repo/provenance exists on this interface.
 *
 * Credential model (preserved exactly from the wire layer): GitHub verifies
 * an HMAC over the EXACT raw body bytes, so a matching signature proves this
 * body's integrity; the GitLab shared token authenticates the SENDER only —
 * it covers no body bytes and no integrity is claimed for it, so every
 * GitLab-side authority derives from the habitat-scoped allowlist + link
 * record + task-habitat binding instead.
 *
 * ONE `BEGIN IMMEDIATE` reservation performs: exactly-one-habitat credential
 * resolution → body parse (merged-shape gate) → body-derived immutable-id
 * allowlist admission → UNIQUE link-record match (zero or multiple exact
 * matches refuse) → task-in-verified-habitat → fresh `autoApproveOnMerge` →
 * fresh submitted status → genuine captured known-zero requirement →
 * module-private terminal CAS + `approved_generation` proof stamp + the
 * approval audit event row (an event fault rolls back everything). Only
 * best-effort post-commit effects follow.
 */
import { getDb } from "../../db/index.js";
import {
  tasks,
  missions,
  habitats,
  taskReviewRequirements,
  pullRequests,
} from "../../db/schema/index.js";
import { eq, and, sql } from "drizzle-orm";
import * as eventRepo from "../../repositories/event.js";
import { getRequirementWithClient, evaluateFinalityWithClient } from "../../repositories/reviewSafety.js";
import {
  resolveCodeReviewHabitatIdsByGithubSignature,
  resolveCodeReviewHabitatIdsByGitlabToken,
} from "../habitatSecretCache.js";
import { emitTransition } from "../tasks/transition-emitter.js";
import { notifyTaskEvent } from "../tasks/task-lifecycle.js";
import * as pluginManager from "../../plugins/pluginManager.js";
import { logger } from "../../lib/logger.js";
import type { Task, TaskEvent } from "../../models/index.js";

/** Verified wire ingress — the ONLY inputs the operation trusts. */
export interface MergeIngress {
  provider: "github" | "gitlab";
  /** The EXACT raw body bytes the provider delivered. */
  rawBody: string;
  /** GitHub: the `x-hub-signature-256` header (HMAC over rawBody). */
  signature?: string;
  /** GitLab: the `X-Gitlab-Token` header (sender authentication only). */
  token?: string;
}

export type MergeApprovalOutcome =
  | { outcome: "approved"; task: Task; event: TaskEvent; oldStatus: string }
  | { outcome: "no_op"; status: string };

/** Body-derived merge event — the single source of every authoritative field. */
interface ParsedMergeEvent {
  immutableRepoId: string;
  displayRepo: string;
  prNumber: number;
}

function parseGithubMergeEvent(rawBody: string): ParsedMergeEvent | null {
  try {
    const body = JSON.parse(rawBody) as {
      action?: string;
      number?: number;
      pull_request?: {
        merged?: boolean;
        base?: { repo?: { id?: number | string; full_name?: string } };
      };
    };
    if (body.action !== "closed" || body.pull_request?.merged !== true) return null;
    const id = body.pull_request.base?.repo?.id;
    const fullName = body.pull_request.base?.repo?.full_name;
    const number = body.number;
    if (id === undefined || id === null || !fullName || number === undefined) return null;
    return { immutableRepoId: String(id), displayRepo: fullName, prNumber: number };
  } catch {
    return null;
  }
}

function parseGitlabMergeEvent(rawBody: string): ParsedMergeEvent | null {
  try {
    const body = JSON.parse(rawBody) as {
      object_attributes?: {
        action?: string;
        iid?: number;
        source_branch?: string;
      };
      project?: { id?: number | string; path_with_namespace?: string };
    };
    const attrs = body.object_attributes;
    if (!attrs || attrs.action !== "merge") return null;
    const id = body.project?.id;
    const path = body.project?.path_with_namespace;
    const iid = attrs.iid;
    if (id === undefined || id === null || !path || iid === undefined) return null;
    return { immutableRepoId: String(id), displayRepo: path, prNumber: iid };
  } catch {
    return null;
  }
}

/** Module-private terminal CAS context — constructed only below, never exported. */
interface MergeTerminalContext {
  readonly tx: ReturnType<typeof getDb>;
  readonly taskId: string;
  readonly generation: number;
}

function mergeTerminalApproveCas(ctx: MergeTerminalContext): Task | null {
  const now = new Date().toISOString();
  const runResult = ctx.tx
    .update(tasks)
    .set({
      status: "approved",
      completedAt: now,
      executionToken: null,
      lastFailureEventId: null,
      lastReleaseEventId: null,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(and(eq(tasks.id, ctx.taskId), eq(tasks.status, "submitted")))
    .run();
  const changes = (runResult as { changes?: number } | undefined)?.changes;
  if (changes === 0) return null;
  const stamped = ctx.tx
    .update(taskReviewRequirements)
    .set({ approvedGeneration: ctx.generation, updatedAt: now })
    .where(
      and(
        eq(taskReviewRequirements.taskId, ctx.taskId),
        eq(taskReviewRequirements.reviewGeneration, ctx.generation),
      ),
    )
    .run();
  const stampChanges = (stamped as { changes?: number } | undefined)?.changes;
  const updated = ctx.tx.select().from(tasks).where(eq(tasks.id, ctx.taskId)).get() as
    | typeof tasks.$inferSelect
    | undefined;
  if (!updated || updated.status !== "approved" || stampChanges === 0) return null;
  return updated as unknown as Task;
}

/**
 * Credential-verified, body-bound merge approval. All authoritative writes —
 * the submitted→approved CAS, the approval-proof stamp and the audit event
 * row — share ONE immediate reservation; an event INSERT failure rolls the
 * approval and proof back with it.
 */
export function approveTaskForMergedPR(ingress: MergeIngress): MergeApprovalOutcome {
  // ── 1. Credential verification (exactly one habitat). GitHub: HMAC over
  // the exact rawBody. GitLab: token = sender authentication only — no
  // body-integrity claim; authority derives from allowlist + link + binding.
  const habitatIds =
    ingress.provider === "github"
      ? ingress.rawBody !== undefined && ingress.signature !== undefined
        ? resolveCodeReviewHabitatIdsByGithubSignature(ingress.rawBody, ingress.signature)
        : []
      : resolveCodeReviewHabitatIdsByGitlabToken(ingress.token);
  if (habitatIds.length !== 1) {
    return { outcome: "no_op", status: "ingress_unverified" };
  }
  const verifiedHabitatId = habitatIds[0];

  // ── 2. Parse the merge event FROM THE VERIFIED BODY. Every authoritative
  // field below derives from this parse; nothing is caller-supplied.
  const parsed =
    ingress.provider === "github"
      ? parseGithubMergeEvent(ingress.rawBody)
      : parseGitlabMergeEvent(ingress.rawBody);
  if (!parsed) {
    return { outcome: "no_op", status: "not_a_merge_event" };
  }

  const db = getDb();
  const actorId = `${ingress.provider}-webhook`;
  const metadata: Record<string, unknown> = {
    provider: ingress.provider,
    repo: parsed.displayRepo,
    prNumber: parsed.prNumber,
    autoApproved: true,
  };

  const result = db.transaction(
    (tx) => {
      // ── 3. Fresh admission on the credential-resolved habitat. ──────────
      const settingsRow = tx
        .select({ settings: habitats.codeReviewSettings })
        .from(habitats)
        .where(eq(habitats.id, verifiedHabitatId))
        .get();
      const settings = settingsRow?.settings ?? null;
      if (!settings?.autoApproveOnMerge) {
        return { outcome: "no_op" as const, status: "auto_approve_disabled" };
      }
      const allowlist =
        ingress.provider === "github" ? settings.githubRepositories : settings.gitlabProjects;
      const trusted = (allowlist ?? []).some(
        (entry) => String(entry.id) === parsed.immutableRepoId,
      );
      if (!trusted) {
        return { outcome: "no_op" as const, status: "repo_not_allowlisted" };
      }

      // ── 4. UNIQUE body-derived link-record match. Zero OR MULTIPLE exact
      // matches refuse — a FIRST-row lookup is not unique proof and cannot
      // authorize a terminal write.
      const links = tx
        .select()
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.provider, ingress.provider),
            eq(pullRequests.repo, parsed.displayRepo),
            eq(pullRequests.prNumber, parsed.prNumber),
          ),
        )
        .all();
      if (links.length === 0) {
        return { outcome: "no_op" as const, status: "link_record_missing" };
      }
      if (links.length > 1) {
        return { outcome: "no_op" as const, status: "link_record_ambiguous" };
      }
      const taskId = links[0].taskId;

      // ── 5. The linked task must live in the credential-verified habitat. ─
      const taskHabitat = tx
        .select({ habitatId: missions.habitatId })
        .from(tasks)
        .innerJoin(missions, eq(tasks.missionId, missions.id))
        .where(eq(tasks.id, taskId))
        .get();
      if (!taskHabitat || taskHabitat.habitatId !== verifiedHabitatId) {
        return { outcome: "no_op" as const, status: "task_not_in_verified_habitat" };
      }

      // ── 6. Fresh status + genuine captured known-zero requirement. ──────
      const preimage = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as
        | typeof tasks.$inferSelect
        | undefined;
      if (!preimage) return { outcome: "no_op" as const, status: "missing" };
      if (preimage.status !== "submitted") {
        return { outcome: "no_op" as const, status: preimage.status };
      }
      const requirement = getRequirementWithClient(tx, taskId);
      if (!requirement || requirement.state !== "known_zero") {
        return { outcome: "no_op" as const, status: "review_required" };
      }
      // Fixup-4 blocker 2: the CANONICAL fresh finality predicate (same one
      // the approval service uses) — no unresolved assigned reviewers may
      // remain (pending/rejected slots block; ineligible claimant slot
      // treatment and count semantics stay canonical, no hand-rolled
      // shortcut). A drift in the predicate fails closed here too.
      const finality = evaluateFinalityWithClient(tx, taskId);
      if (!finality.eligible) {
        return { outcome: "no_op" as const, status: "review_required" };
      }

      // ── 7. Terminal CAS + proof + audit event — one reservation. ────────
      const ctx: MergeTerminalContext = {
        tx,
        taskId,
        generation: requirement.reviewGeneration,
      };
      const task = mergeTerminalApproveCas(ctx);
      if (!task) return { outcome: "no_op" as const, status: "lost_race" };

      const event = eventRepo.createEvent({
        taskId,
        actorType: "system",
        actorId,
        action: "approved",
        fromStatus: "submitted",
        toStatus: "approved",
        metadata,
      });

      return { outcome: "approved" as const, task, event, oldStatus: preimage.status };
    },
    { behavior: "immediate" },
  );

  if (result.outcome !== "approved") return result;

  // Post-commit, best-effort only — the audited state is already committed.
  const context = {
    actorType: "system" as const,
    actorId,
    oldStatus: result.oldStatus,
    newStatus: "approved" as const,
    metadata,
    task: result.task,
    existingEventId: result.event.id,
  };

  try {
    emitTransition(taskIdFor(result.task), "approved", verifiedHabitatId, context);
    pluginManager.runPostInterceptors(
      taskIdFor(result.task),
      "taskApproved",
      verifiedHabitatId,
      context,
    );
    notifyTaskEvent({
      habitatId: verifiedHabitatId,
      taskId: taskIdFor(result.task),
      event: "approved",
      actorType: "system",
      actorId,
    });
  } catch (err) {
    logger.warn(
      { err, taskId: taskIdFor(result.task) },
      "Merge-approval post-commit effects failed (audited state is committed)",
    );
  }

  return result;
}

function taskIdFor(task: Task): string {
  return task.id;
}
