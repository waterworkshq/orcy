import type {
  CodeEvidenceBulkResult,
  CodeEvidenceLinkInput,
  CodeEvidenceLinkItem,
  CodeEvidenceLinkSource,
  CodeEvidenceTargetType,
  CodeEvidenceVerificationState,
} from "@orcy/shared";

import { getDb } from "../../db/index.js";
import { missions as missionsTable } from "../../db/schema/index.js";
import type { Mission, Task } from "@orcy/shared";
import type { FastifyRequest } from "fastify";
import { AppError, conflictWithCode, notFound } from "../../errors.js";
import { checkHabitatAccess, authorizeTaskAccess } from "../../middleware/realtimeAuth.js";
import * as codeBranchRepo from "../../repositories/codeBranchRepository.js";
import * as codeChangedFileRepo from "../../repositories/codeChangedFileRepository.js";
import * as codeCommitRepo from "../../repositories/codeCommitRepository.js";
import * as codeEvidenceRepo from "../../repositories/codeEvidenceRepository.js";
import * as codeEvidenceGapRepo from "../../repositories/codeEvidenceGapRepository.js";
import * as codeEvidenceLinkRepo from "../../repositories/codeEvidenceLinkRepository.js";
import { determineVerificationState, inferInitialConfidence } from "./confidence.js";
import { mapLinkToItem } from "./mappers.js";
import type { CodeEvidenceActor } from "./types.js";
import {
  getHabitatRowExact,
  getMissionRowExact,
  getTaskRowExact,
  resolveEvidenceTarget,
} from "./targetCompatibility.js";
import { normalizeUrl, parseUrl } from "./urlParsing.js";

/** The reporting origin as resolved from the URL spelling. */
export type ReportOrigin =
  | {
      kind: "task";
      rawId: string;
      taskId: string;
      missionId: string;
      habitatId: string;
    }
  | {
      kind: "mission";
      rawId: string;
      missionId: string;
      habitatId: string;
    };

/** One raw-selected dispatch occurrence, preserved before canonicalization. */
type ReportOccurrence =
  | { type: "branch"; branch: NonNullable<CodeEvidenceLinkInput["branch"]> }
  | { type: "main_commit"; commitIndex: number; sha: string }
  | {
      /** Retained resolved canonical context: EVERY raw occurrence carries it, including aliases whose admission check was deduplicated — execution never re-resolves a raw spelling. */
      type: "trailer";
      commitIndex: number;
      trailerKind: CodeEvidenceTargetType;
      rawValue: string;
      sha: string;
      canonicalId: string;
      habitatId: string;
      originReuse: boolean;
    }
  | { type: "changed_file"; fileIndex: number }
  | { type: "pull_request_url" }
  | { type: "pipeline_url" }
  | { type: "external_url"; urlIndex: number };

/**
 * A selected trailer destination awaiting admission, in first-seen order.
 * `missing` marks a destination that did not resolve under the current
 * grammar; its 404 surfaces during admission at its first-seen position,
 * interleaved with any earlier denied destination's 403 — not eagerly at
 * plan-build time.
 */
type ReportDestination = {
  kind: CodeEvidenceTargetType;
  rawId: string;
  canonicalId: string | null;
  habitatId: string | null;
  missing: boolean;
};

type RecordSelection = { action: "attach"; recordId: string } | { action: "create" };

type BranchPlan = {
  key: string;
  input: NonNullable<CodeEvidenceLinkInput["branch"]>;
  selection: RecordSelection;
  suppliedDiffers: boolean;
};

type CommitPlan = {
  sha: string;
  metadata: {
    message?: string;
    authorName?: string;
    authorEmail?: string;
    authoredAt?: string;
    url?: string;
  };
  selection: RecordSelection;
  suppliedDiffers: boolean;
};

type RepositoryFingerprint = {
  id: string;
  provider: string;
  providerBaseUrl: string | null;
  externalId: string | null;
  repoSlug: string | null;
  localPath: string | null;
  verificationState: string;
};

export type ReportPlan = {
  origin: ReportOrigin;
  input: CodeEvidenceLinkInput;
  occurrences: ReportOccurrence[];
  destinations: ReportDestination[];
  storage: {
    repositoryId: string | null;
    isRepoVerified: boolean;
    fingerprint: RepositoryFingerprint | null;
    branches: Map<string, BranchPlan>;
    commits: Map<string, CommitPlan>;
  };
};

/** Internal per-occurrence event context returned by execution. */
export type ReportEventContext = {
  linkId: string;
  targetType: CodeEvidenceTargetType;
  targetId: string;
  habitatId: string;
  entityTask: Task | null;
  entityMission: Mission | null;
};

/** Transaction root client (top-level db or a test-supplied equivalent). */
export type ReportDbClient = ReturnType<typeof getDb>;

const AUTO_RESOLVE_REASON_CODES = [
  "pr_commit_not_created_yet",
  "provider_webhook_missing",
  "waiting_for_reviewer_provider",
] as const;

function mainSourceForActor(actor: CodeEvidenceActor): CodeEvidenceLinkSource {
  if (actor.type === "agent") return "agent_reported";
  if (actor.type === "remote_human" || actor.type === "remote_orcy") return "remote";
  return "human_manual";
}

/**
 * Builds the raw dispatch plan for a local Task or Mission report:
 * resolves the origin row through the CURRENT transport grammar, inventories
 * every raw-selected occurrence in the original order (branch; each main
 * commit followed by its trailers; changed files; PR URL; pipeline URL;
 * external URLs), and resolves every recognized trailer destination.
 *
 * The trailer skip grammar compares RAW values only (`trailer.value ===
 * origin.rawId`); canonicalization happens after occurrence selection so
 * repeated provenance, results and events are never erased when raw aliases
 * collapse. A missing destination throws 404 here — before admission and
 * before any write.
 */
export function buildReportPlan(
  originInput: { kind: "task" | "mission"; rawId: string },
  input: CodeEvidenceLinkInput,
): ReportPlan {
  const resolvedOrigin = resolveEvidenceTarget(originInput.kind, originInput.rawId);
  if (!resolvedOrigin) {
    throw notFound(originInput.kind === "task" ? "Task not found" : "Mission not found");
  }

  let origin: ReportOrigin;
  if (resolvedOrigin.kind === "task") {
    const mission = getMissionRowExact(resolvedOrigin.row.missionId);
    if (!mission) throw notFound("Mission not found");
    origin = {
      kind: "task",
      rawId: originInput.rawId,
      taskId: resolvedOrigin.row.id,
      missionId: mission.id,
      habitatId: mission.habitatId,
    };
  } else {
    origin = {
      kind: "mission",
      rawId: originInput.rawId,
      missionId: resolvedOrigin.row.id,
      habitatId: resolvedOrigin.row.habitatId,
    };
  }

  // The origin's actual Habitat must EXIST before any report work — the
  // Mission origin is exempt from membership, never from ancestry/Habitat
  // resolution ("no orphan links"). This also covers empty and file-only
  // reports, which have no link contexts to validate later.
  if (!getHabitatRowExact(origin.habitatId)) {
    throw notFound("Habitat not found");
  }

  const occurrences: ReportOccurrence[] = [];
  const destinations: ReportDestination[] = [];
  const seenDestinationKeys = new Set<string>([
    `${origin.kind}:${origin.kind === "task" ? origin.taskId : origin.missionId}`,
  ]);

  if (input.branch) {
    occurrences.push({ type: "branch", branch: input.branch });
  }

  if (input.commits) {
    for (let commitIndex = 0; commitIndex < input.commits.length; commitIndex++) {
      const commit = input.commits[commitIndex]!;
      occurrences.push({ type: "main_commit", commitIndex, sha: commit.sha });

      if (commit.trailers) {
        for (const trailer of commit.trailers) {
          const key = trailer.key.toLowerCase();
          if (key === "orcy-task") {
            if (origin.kind !== "task" || trailer.value !== origin.rawId) {
              pushTrailerOccurrence("task", trailer.value, commitIndex, commit.sha);
            }
          }
          if (key === "orcy-mission") {
            if (origin.kind !== "mission" || trailer.value !== origin.rawId) {
              pushTrailerOccurrence("mission", trailer.value, commitIndex, commit.sha);
            }
          }
        }
      }
    }
  }

  function pushTrailerOccurrence(
    trailerKind: CodeEvidenceTargetType,
    rawValue: string,
    commitIndex: number,
    sha: string,
  ) {
    const destination = resolveEvidenceTarget(trailerKind, rawValue);
    if (!destination) {
      // Retain the unresolved occurrence for first-seen-order 404 at
      // admission; no canonical context exists to execute.
      occurrences.push({
        type: "trailer",
        commitIndex,
        trailerKind,
        rawValue,
        sha,
        canonicalId: "",
        habitatId: "",
        originReuse: false,
      });
      const missingKey = `missing:${trailerKind}:${rawValue}`;
      if (seenDestinationKeys.has(missingKey)) return;
      seenDestinationKeys.add(missingKey);
      destinations.push({
        kind: trailerKind,
        rawId: rawValue,
        canonicalId: null,
        habitatId: null,
        missing: true,
      });
      return;
    }
    const canonicalId = destination.row.id;
    const destKey = `${trailerKind}:${canonicalId}`;
    const alreadySeen = seenDestinationKeys.has(destKey);

    // Origin-reuse: an occurrence whose canonical id IS the reporting
    // origin's canonical id reuses origin admission and the origin habitat —
    // including raw aliases — with no additional membership requirement.
    const isOrigin =
      trailerKind === origin.kind &&
      canonicalId === (origin.kind === "task" ? origin.taskId : origin.missionId);
    const habitatId = isOrigin
      ? origin.habitatId
      : trailerKind === "task"
        ? habitatForTaskRow(canonicalId)
        : (destination.row as typeof missionsTable.$inferSelect).habitatId;

    // EVERY raw occurrence retains its resolved canonical context, even when
    // admission dedup already saw this destination — execution never looks
    // the raw spelling up again.
    occurrences.push({
      type: "trailer",
      commitIndex,
      trailerKind,
      rawValue,
      sha,
      canonicalId,
      habitatId: habitatId ?? "",
      originReuse: isOrigin || habitatId === null ? isOrigin : false,
    });

    if (habitatId === null && !isOrigin) {
      // Ancestry vanished between resolution and habitat derivation: record
      // a missing destination so the 404 surfaces at admission order.
      const missingKey2 = `missing:${trailerKind}:${rawValue}`;
      if (!seenDestinationKeys.has(missingKey2)) {
        seenDestinationKeys.add(missingKey2);
        destinations.push({
          kind: trailerKind,
          rawId: rawValue,
          canonicalId: null,
          habitatId: null,
          missing: true,
        });
      }
      return;
    }
    if (alreadySeen) return; // admission dedup only
    seenDestinationKeys.add(destKey);
    destinations.push({
      kind: trailerKind,
      rawId: rawValue,
      canonicalId,
      habitatId: habitatId!,
      missing: false,
    });
  }

  function habitatForTaskRow(taskId: string): string | null {
    const task = getTaskRowExact(taskId);
    const mission = task ? getMissionRowExact(task.missionId) : null;
    if (!task || !mission) return null;
    return mission.habitatId;
  }

  if (input.changedFiles?.length) {
    for (let fileIndex = 0; fileIndex < input.changedFiles.length; fileIndex++) {
      occurrences.push({ type: "changed_file", fileIndex });
    }
  }
  if (input.pullRequestUrl) occurrences.push({ type: "pull_request_url" });
  if (input.pipelineUrl) occurrences.push({ type: "pipeline_url" });
  if (input.externalUrls?.length) {
    for (let urlIndex = 0; urlIndex < input.externalUrls.length; urlIndex++) {
      occurrences.push({ type: "external_url", urlIndex });
    }
  }

  return {
    origin,
    input,
    occurrences,
    destinations,
    storage: {
      repositoryId: null,
      isRepoVerified: false,
      fingerprint: null,
      branches: new Map(),
      commits: new Map(),
    },
  };
}

/**
 * Admits every DISTINCT selected destination in original first-seen order,
 * BEFORE any write. Task destinations use the existing target-derived
 * Task→Mission→Habitat admission; Mission destinations use the existing
 * Mission→Habitat membership predicate. Occurrences that resolve to the
 * reporting origin itself (including raw aliases) already reused the origin's
 * own admission and are not re-checked — the Mission origin exemption is
 * admission reuse only. First 403/404 rejects the whole request with zero
 * evidence/event effects.
 */
export async function admitReportDestinations(
  request: FastifyRequest,
  plan: ReportPlan,
): Promise<void> {
  for (const destination of plan.destinations) {
    if (destination.missing) {
      throw notFound(
        destination.kind === "task"
          ? `Trailer target task not found: ${destination.rawId}`
          : `Trailer target mission not found: ${destination.rawId}`,
      );
    }
    if (destination.kind === "task") {
      await authorizeTaskAccess(request, destination.rawId);
    } else {
      await checkHabitatAccess(request, destination.habitatId!);
    }
  }
}

type RepoRow = Awaited<ReturnType<typeof codeEvidenceRepo.getByHabitatId>>;

function fingerprintOf(row: NonNullable<RepoRow>): RepositoryFingerprint {
  return {
    id: row.id,
    provider: row.provider,
    providerBaseUrl: row.providerBaseUrl,
    externalId: row.externalId,
    repoSlug: row.repoSlug,
    localPath: row.localPath,
    verificationState: row.verificationState,
  };
}

function sameFingerprint(a: RepositoryFingerprint, b: RepositoryFingerprint): boolean {
  return (
    a.id === b.id &&
    a.provider === b.provider &&
    a.providerBaseUrl === b.providerBaseUrl &&
    a.externalId === b.externalId &&
    a.repoSlug === b.repoSlug &&
    a.localPath === b.localPath &&
    a.verificationState === b.verificationState
  );
}

/**
 * Selects the reporting storage domain and every record candidate BEFORE any
 * write. The source domain is the ORIGIN's repository configuration (a
 * Mission report uses the reporting Mission's Habitat, never a trailer
 * destination's). Cardinality zero means fresh request-local unverified
 * records (no global name/SHA reuse); exactly one selects that configuration
 * domain; two or more refuse 409 before any write.
 *
 * Inside a configured domain, every same-key candidate row is inspected: one
 * local-provider row and no competing rows attaches UNCHANGED (no metadata,
 * verification, or updatedAt refresh); zero rows creates a local record; any
 * duplicate set or a sole incompatible-provider row refuses 409
 * EVIDENCE_RECORD_AMBIGUOUS. Null/formerly-bound rows are never selected.
 * Supplied persisted metadata for one request unions non-overlapping fields;
 * two defined values that differ refuse 409 EVIDENCE_INPUT_CONFLICT before
 * writes. commit.branch and changed-file references remain ignored.
 */
export function finalizeReportPlan(plan: ReportPlan): ReportPlan {
  const repoRows = codeEvidenceRepo.getAllByHabitatId(plan.origin.habitatId);
  if (repoRows.length > 1) {
    throw conflictWithCode(
      "EVIDENCE_REPOSITORY_AMBIGUOUS",
      "Multiple repository configurations exist for the reporting habitat; refusing before any evidence write.",
    );
  }

  const configured = repoRows.length === 1 ? repoRows[0]! : null;
  plan.storage.repositoryId = configured?.id ?? null;
  plan.storage.isRepoVerified = configured?.verificationState === "verified";
  plan.storage.fingerprint = configured ? fingerprintOf(configured) : null;

  if (plan.input.branch) {
    plan.storage.branches.set(
      plan.input.branch.name,
      planBranch(plan.input.branch, configured, plan.origin),
    );
  }

  if (plan.input.commits) {
    // Cumulative metadata: the merged object is RETAINED after every
    // occurrence, so each later defined persisted field is evaluated against
    // the whole union — nonoverlapping fields persist, and a third-or-later
    // occurrence that conflicts with ANY retained value refuses 409 before
    // all writes. Attached existing records are never refreshed; the
    // supplied-difference warning evaluates the complete union.
    for (const commit of plan.input.commits) {
      const existing = plan.storage.commits.get(commit.sha);
      const merged = existing
        ? unionCommitMetadata(existing.metadata, commitMetadataOf(commit), commit.sha)
        : commitMetadataOf(commit);
      if (!existing) {
        plan.storage.commits.set(
          commit.sha,
          planCommit(commit.sha, merged, configured, plan.origin),
        );
      } else {
        existing.metadata = merged;
        if (configured) {
          const row = codeCommitRepo.findByRepoAndShaWithClient(getDb(), configured.id, commit.sha)[0];
          existing.suppliedDiffers = Boolean(row) && commitSuppliedDiffers(row, merged);
        }
      }
    }
  }

  return plan;
}

function planBranch(
  branch: NonNullable<CodeEvidenceLinkInput["branch"]>,
  configured: NonNullable<RepoRow> | null,
  origin: ReportOrigin,
): BranchPlan {
  if (!configured) {
    // Fresh request-local fallback: no selection by name, one record per
    // distinct exact name per request.
    return {
      key: branch.name,
      input: branch,
      selection: { action: "create" },
      suppliedDiffers: false,
    };
  }
  const candidates = codeBranchRepo.findByRepoAndNameWithClient(
    getDb(),
    configured.id,
    branch.name,
  );
  const selection = decideSelection(candidates, "branch", branch.name);
  const suppliedDiffers =
    selection.action === "attach" &&
    candidates.length === 1 &&
    branchSuppliedDiffers(candidates[0]!, branch);
  return { key: branch.name, input: branch, selection, suppliedDiffers };
}

function planCommit(
  sha: string,
  metadata: CommitPlan["metadata"],
  configured: NonNullable<RepoRow> | null,
  _origin: ReportOrigin,
): CommitPlan {
  if (!configured) {
    return { sha, metadata, selection: { action: "create" }, suppliedDiffers: false };
  }
  const candidates = codeCommitRepo.findByRepoAndShaWithClient(getDb(), configured.id, sha);
  const selection = decideSelection(candidates, "commit", sha);
  const suppliedDiffers =
    selection.action === "attach" &&
    candidates.length === 1 &&
    commitSuppliedDiffers(candidates[0]!, metadata);
  return { sha, metadata, selection, suppliedDiffers };
}

function decideSelection(
  candidates: Array<{ id: string; provider: string }>,
  kind: "branch" | "commit",
  key: string,
): RecordSelection {
  if (candidates.length === 0) return { action: "create" };
  if (candidates.length > 1) {
    throw conflictWithCode(
      "EVIDENCE_RECORD_AMBIGUOUS",
      `Multiple ${kind} records exist for key ${key} in the reporting repository domain; refusing before any evidence write.`,
    );
  }
  const only = candidates[0]!;
  if (only.provider !== "local") {
    throw conflictWithCode(
      "EVIDENCE_RECORD_AMBIGUOUS",
      `The sole ${kind} record for key ${key} in the reporting repository domain has an incompatible provider; refusing before any evidence write.`,
    );
  }
  return { action: "attach", recordId: only.id };
}

function branchSuppliedDiffers(
  row: { headSha: string | null; baseBranch: string | null; url: string | null },
  branch: NonNullable<CodeEvidenceLinkInput["branch"]>,
): boolean {
  if (branch.headSha !== undefined && branch.headSha !== row.headSha) return true;
  if (branch.baseBranch !== undefined && branch.baseBranch !== row.baseBranch) return true;
  if (branch.url !== undefined && branch.url !== row.url) return true;
  return false;
}

function commitSuppliedDiffers(
  row: {
    message: string | null;
    authorName: string | null;
    authorEmail: string | null;
    authoredAt: string | null;
    url: string | null;
  },
  metadata: CommitPlan["metadata"],
): boolean {
  if (metadata.message !== undefined && metadata.message !== row.message) return true;
  if (metadata.authorName !== undefined && metadata.authorName !== row.authorName) return true;
  if (metadata.authorEmail !== undefined && metadata.authorEmail !== row.authorEmail) return true;
  if (metadata.authoredAt !== undefined && metadata.authoredAt !== row.authoredAt) return true;
  if (metadata.url !== undefined && metadata.url !== row.url) return true;
  return false;
}

function commitMetadataOf(commit: NonNullable<CodeEvidenceLinkInput["commits"]>[number]) {
  return {
    message: commit.message,
    authorName: commit.authorName,
    authorEmail: commit.authorEmail,
    authoredAt: commit.authoredAt,
    url: commit.url,
  };
}

function unionCommitMetadata(
  a: CommitPlan["metadata"],
  b: CommitPlan["metadata"],
  sha: string,
): CommitPlan["metadata"] {
  const keys = ["message", "authorName", "authorEmail", "authoredAt", "url"] as const;
  const merged: CommitPlan["metadata"] = { ...a };
  for (const key of keys) {
    const aVal = a[key];
    const bVal = b[key];
    if (aVal === undefined || bVal === undefined || aVal === bVal) {
      if (merged[key] === undefined && bVal !== undefined) merged[key] = bVal;
      continue;
    }
    throw conflictWithCode(
      "EVIDENCE_INPUT_CONFLICT",
      `Conflicting supplied metadata for commit ${sha}; refusing before any evidence write.`,
    );
  }
  return merged;
}

/**
 * Executes the plan as ONE synchronous immediate evidence-write bundle:
 * every record, link, corroboration, changed-file and canonical gap change
 * runs on the supplied transaction client. Under the writer reservation the
 * origin ancestry, repository cardinality/fingerprint and the planned record
 * selection (ids/cardinality/provider/key) are re-read and compared — any
 * drift refuses 409 EVIDENCE_CONTEXT_CHANGED with zero writes from this
 * report, never a silent replan. A thrown write failure rolls back the whole
 * bundle; ordinary returned warnings/errors keep their bulk semantics and do
 * NOT roll anything back. No root getDb()/nested-root transaction is invoked
 * inside the bundle; no awaits run inside the transaction.
 */
export function executeReportPlan(
  plan: ReportPlan,
  actor: CodeEvidenceActor,
): { result: CodeEvidenceBulkResult; contexts: ReportEventContext[] } {
  const db = getDb();

  return db.transaction(
    (tx) => {
      recheckUnderReservation(tx, plan);

      const links: CodeEvidenceLinkItem[] = [];
      const warnings: CodeEvidenceBulkResult["warnings"] = [];
      const errors: CodeEvidenceBulkResult["errors"] = [];
      const contexts: ReportEventContext[] = [];
      const warnedRetained = new Set<string>();

      const mainSource = mainSourceForActor(actor);
      const allowExternalRepo = plan.input.allowExternalRepository ?? false;

      const branchRecords = new Map<string, { id: string } | null>();
      const commitRecords = new Map<string, { id: string } | null>();

      const ensureBranchRecord = (name: string): { id: string } | null => {
        if (branchRecords.has(name)) return branchRecords.get(name)!;
        const branchPlan = plan.storage.branches.get(name);
        if (!branchPlan) return null;
        let record: { id: string } | null = null;
        if (branchPlan.selection.action === "attach") {
          record = { id: branchPlan.selection.recordId };
          maybeWarnRetained("branch", name, branchPlan.suppliedDiffers);
        } else {
          const created = codeBranchRepo.createWithClient(tx, {
            repositoryId: plan.storage.repositoryId,
            provider: "local",
            name: branchPlan.input.name,
            baseBranch: branchPlan.input.baseBranch,
            headSha: branchPlan.input.headSha,
            url: branchPlan.input.url,
            createdFromTaskId: plan.origin.kind === "task" ? plan.origin.taskId : undefined,
            verificationState: "unverified",
          });
          record = created ? { id: created.id } : null;
        }
        branchRecords.set(name, record);
        return record;
      };

      const ensureCommitRecord = (sha: string): { id: string } | null => {
        if (commitRecords.has(sha)) return commitRecords.get(sha)!;
        const commitPlan = plan.storage.commits.get(sha);
        if (!commitPlan) return null;
        let record: { id: string } | null = null;
        if (commitPlan.selection.action === "attach") {
          record = { id: commitPlan.selection.recordId };
          maybeWarnRetained("commit", sha, commitPlan.suppliedDiffers);
        } else {
          // Novel commit record is created ONCE from its main report source —
          // unverified even in a verified repository. Trailer links may still
          // be verified; record and link verification deliberately differ.
          const source = mainSourceForActor(actor);
          const verificationState = determineVerificationState(
            source,
            plan.storage.isRepoVerified,
            false,
          );
          const created = codeCommitRepo.createWithClient(tx, {
            repositoryId: plan.storage.repositoryId,
            provider: "local",
            sha: commitPlan.sha,
            message: commitPlan.metadata.message,
            authorName: commitPlan.metadata.authorName,
            authorEmail: commitPlan.metadata.authorEmail,
            authoredAt: commitPlan.metadata.authoredAt,
            url: commitPlan.metadata.url,
            verificationState,
          });
          record = created ? { id: created.id } : null;
        }
        commitRecords.set(sha, record);
        return record;
      };

      const maybeWarnRetained = (kind: string, key: string, differs: boolean) => {
        if (!differs || warnedRetained.has(`${kind}:${key}`)) return;
        warnedRetained.add(`${kind}:${key}`);
        warnings.push({
          code: "EXISTING_EVIDENCE_METADATA_RETAINED",
          message: `Existing ${kind} record ${key} was attached without refreshing its stored metadata; supplied metadata differences were ignored.`,
          inputRef: key,
        });
      };

      const ensureLink = (
        targetType: CodeEvidenceTargetType,
        targetId: string,
        habitatId: string,
        evidenceType: Parameters<
          typeof codeEvidenceLinkRepo.findOrCreateActiveWithClient
        >[1]["evidenceType"],
        evidenceId: string | null,
        externalUrl: string | null,
        title: string | null,
        linkSource: CodeEvidenceLinkSource,
        verificationState: CodeEvidenceVerificationState,
        confidence: number,
        normalizedExternalUrl?: string | null,
      ): { item: CodeEvidenceLinkItem | null; context: ReportEventContext | null } => {
        const found = codeEvidenceLinkRepo.findOrCreateActiveWithClient(tx, {
          targetType,
          targetId,
          evidenceType,
          evidenceId,
          externalUrl,
          normalizedExternalUrl:
            normalizedExternalUrl ?? (externalUrl ? normalizeUrl(externalUrl) : null),
          title,
          linkSource,
          linkedByType: actor.type,
          linkedById: actor.id,
          verificationState,
          confidence,
          allowExternalRepository: linkSource === "commit_trailer" ? false : allowExternalRepo,
        });
        if (!found) return { item: null, context: null };

        if (!found.created) {
          codeEvidenceLinkRepo.addCorroboratingSourceWithClient(tx, found.link.id, linkSource);
        }

        const row = found.created
          ? found.link
          : (codeEvidenceLinkRepo.getByIdWithClient(tx, found.link.id) ?? found.link);

        const item = mapLinkToItem(row);
        const context: ReportEventContext = {
          linkId: row.id,
          targetType: row.targetType as CodeEvidenceTargetType,
          targetId: row.targetId,
          habitatId,
          entityTask: null,
          entityMission: null,
        };
        return { item, context };
      };

      const pushOutcome = (
        outcome: { item: CodeEvidenceLinkItem | null; context: ReportEventContext | null },
        onError: { code: string; message: string },
      ) => {
        if (outcome.item) {
          links.push(outcome.item);
          contexts.push(outcome.context!);
        } else {
          errors.push(onError);
        }
      };

      const originPair = (): { targetType: CodeEvidenceTargetType; targetId: string } =>
        plan.origin.kind === "task"
          ? { targetType: "task", targetId: plan.origin.taskId }
          : { targetType: "mission", targetId: plan.origin.missionId };

      for (const occurrence of plan.occurrences) {
        switch (occurrence.type) {
          case "branch": {
            const record = ensureBranchRecord(occurrence.branch.name);
            if (!record) {
              errors.push({
                code: "BRANCH_CREATE_FAILED",
                message: `Failed to create branch evidence for ${occurrence.branch.name}`,
              });
              break;
            }
            const source: CodeEvidenceLinkSource = "human_manual";
            const verificationState = determineVerificationState(
              source,
              plan.storage.isRepoVerified,
              false,
            );
            const confidence = inferInitialConfidence(source, false, verificationState);
            const originP = originPair();
            const outcome = ensureLink(
              originP.targetType,
              originP.targetId,
              plan.origin.habitatId,
              "branch",
              record.id,
              null,
              occurrence.branch.name,
              source,
              verificationState,
              confidence,
            );
            pushOutcome(outcome, {
              code: "BRANCH_CREATE_FAILED",
              message: `Failed to create branch evidence for ${occurrence.branch.name}`,
            });
            break;
          }

          case "main_commit": {
            const commit = plan.input.commits![occurrence.commitIndex]!;
            const record = ensureCommitRecord(commit.sha);
            if (!record) {
              errors.push({
                code: "COMMIT_CREATE_FAILED",
                message: `Failed to create commit evidence for ${commit.sha}`,
              });
              break;
            }
            const verificationState = determineVerificationState(
              mainSource,
              plan.storage.isRepoVerified,
              false,
            );
            const confidence = inferInitialConfidence(mainSource, false, verificationState);
            const originP = originPair();
            const outcome = ensureLink(
              originP.targetType,
              originP.targetId,
              plan.origin.habitatId,
              "commit",
              record.id,
              commit.url ?? null,
              commit.sha.slice(0, 7),
              mainSource,
              verificationState,
              confidence,
            );
            pushOutcome(outcome, {
              code: "COMMIT_CREATE_FAILED",
              message: `Failed to create commit evidence for ${commit.sha}`,
            });
            break;
          }

          case "trailer": {
            if (!occurrence.originReuse && !occurrence.habitatId) {
              // Unreachable post-admission: an unresolved destination
              // rejected the whole request before execution. The guard is
              // explicit rather than silently skipping an occurrence.
              throw notFound(`Trailer target not found: ${occurrence.rawValue}`);
            }
            const record = ensureCommitRecord(occurrence.sha);
            if (!record) {
              warnings.push({
                code: "TRAILER_COMMIT_FAILED",
                message: `Failed to create commit evidence for trailer target`,
              });
              break;
            }
            const source: CodeEvidenceLinkSource = "commit_trailer";
            const verificationState = determineVerificationState(
              source,
              plan.storage.isRepoVerified,
              false,
            );
            const confidence = inferInitialConfidence(source, false, verificationState);
            // Retained per-occurrence canonical context (origin-reuse
            // occurrences carry the origin habitat); no raw re-resolution.
            const outcome = ensureLink(
              occurrence.trailerKind,
              occurrence.canonicalId,
              occurrence.originReuse ? plan.origin.habitatId : occurrence.habitatId,
              "commit",
              record.id,
              null,
              occurrence.sha.slice(0, 7),
              source,
              verificationState,
              confidence,
            );
            pushOutcome(outcome, {
              code: "TRAILER_COMMIT_FAILED",
              message: `Failed to create commit evidence for trailer target`,
            });
            break;
          }

          case "changed_file": {
            const file = plan.input.changedFiles![occurrence.fileIndex]!;
            codeChangedFileRepo.createWithClient(tx, {
              provider: "local",
              path: file.path,
              previousPath: file.previousPath,
              changeType: file.changeType,
              additions: file.additions,
              deletions: file.deletions,
              source: actor.type === "agent" ? "agent_reported" : "human_manual",
            });
            break;
          }

          case "pull_request_url":
          case "pipeline_url": {
            const url =
              occurrence.type === "pull_request_url"
                ? plan.input.pullRequestUrl!
                : plan.input.pipelineUrl!;
            const parsed = parseUrl(url);
            // Input selection is preserved exactly as the prior linker:
            // pullRequestUrl maps a parsed provider URL ONLY as a
            // pull_request, pipelineUrl ONLY as a pipeline_run; a recognized
            // URL of the wrong type takes the external-URL path. Generic
            // externalUrls classify every recognized provider URL as before.
            const typeMatches =
              parsed !== null &&
              ((occurrence.type === "pull_request_url" && parsed.evidenceType === "pull_request") ||
                (occurrence.type === "pipeline_url" && parsed.evidenceType === "pipeline_run"));
            const source: CodeEvidenceLinkSource = "human_manual";
            const originP = originPair();
            if (typeMatches && parsed) {
              const verificationState = determineVerificationState(
                source,
                plan.storage.isRepoVerified,
                false,
              );
              const confidence = inferInitialConfidence(source, false, verificationState);
              const outcome = ensureLink(
                originP.targetType,
                originP.targetId,
                plan.origin.habitatId,
                parsed.evidenceType,
                null,
                url,
                `${parsed.evidenceType.replace("_", " ")} ${parsed.identifier}`,
                source,
                verificationState,
                confidence,
              );
              pushOutcome(outcome, {
                code: "EVIDENCE_LINK_FAILED",
                message: `Failed to link ${parsed.evidenceType} evidence`,
              });
            } else {
              const outcome = ensureLink(
                originP.targetType,
                originP.targetId,
                plan.origin.habitatId,
                "external_url",
                null,
                url,
                url,
                source,
                "unverified",
                0.5,
                normalizeUrl(url),
              );
              if (!outcome.item) {
                warnings.push({
                  code: "EXTERNAL_URL_LINK_FAILED",
                  message: `Failed to link external URL`,
                });
              } else {
                links.push(outcome.item);
                contexts.push(outcome.context!);
              }
            }
            break;
          }

          case "external_url": {
            const url = plan.input.externalUrls![occurrence.urlIndex]!;
            const parsed = parseUrl(url);
            const source: CodeEvidenceLinkSource = "human_manual";
            const originP = originPair();
            if (parsed) {
              const verificationState = determineVerificationState(
                source,
                plan.storage.isRepoVerified,
                false,
              );
              const confidence = inferInitialConfidence(source, false, verificationState);
              const outcome = ensureLink(
                originP.targetType,
                originP.targetId,
                plan.origin.habitatId,
                parsed.evidenceType,
                null,
                url,
                `${parsed.evidenceType.replace("_", " ")} ${parsed.identifier}`,
                source,
                verificationState,
                confidence,
              );
              pushOutcome(outcome, {
                code: "EVIDENCE_LINK_FAILED",
                message: `Failed to link ${parsed.evidenceType} evidence`,
              });
            } else {
              const outcome = ensureLink(
                originP.targetType,
                originP.targetId,
                plan.origin.habitatId,
                "external_url",
                null,
                url,
                url,
                source,
                "unverified",
                0.5,
                normalizeUrl(url),
              );
              if (!outcome.item) {
                warnings.push({
                  code: "EXTERNAL_URL_LINK_FAILED",
                  message: `Failed to link external URL`,
                });
              } else {
                links.push(outcome.item);
                contexts.push(outcome.context!);
              }
            }
            break;
          }
        }
      }

      // Canonical URL-pair gap auto-resolution only: legacy alias gaps stay
      // visible until resolved explicitly by resource id.
      const originP = originPair();
      codeEvidenceGapRepo.autoResolveByReasonCodesWithClient(
        tx,
        originP.targetType,
        originP.targetId,
        [...AUTO_RESOLVE_REASON_CODES],
      );

      return { result: { links, warnings, errors }, contexts };
    },
    { behavior: "immediate" },
  );
}

function recheckUnderReservation(tx: ReportDbClient, plan: ReportPlan): void {
  // 1. Origin exact ancestry + Habitat EXISTENCE, all on the supplied client
  //    (no root getDb after transaction entry; the Mission origin is exempt
  //    from membership, never from ancestry/Habitat resolution).
  if (plan.origin.kind === "task") {
    const task = getTaskRowExact(plan.origin.taskId, tx);
    const mission = task ? getMissionRowExact(task.missionId, tx) : null;
    const habitat = mission ? getHabitatRowExact(mission.habitatId, tx) : null;
    if (
      !task ||
      task.missionId !== plan.origin.missionId ||
      !mission ||
      mission.habitatId !== plan.origin.habitatId ||
      !habitat
    ) {
      throw conflictWithCode(
        "EVIDENCE_CONTEXT_CHANGED",
        "The reporting task's ancestry changed before the evidence write; refusing with zero writes.",
      );
    }
  } else {
    const mission = getMissionRowExact(plan.origin.missionId, tx);
    const habitat = mission ? getHabitatRowExact(mission.habitatId, tx) : null;
    if (!mission || mission.habitatId !== plan.origin.habitatId || !habitat) {
      throw conflictWithCode(
        "EVIDENCE_CONTEXT_CHANGED",
        "The reporting mission changed before the evidence write; refusing with zero writes.",
      );
    }
  }

  // 2. Repository cardinality + fingerprint.
  const repoRows = codeEvidenceRepo.getAllByHabitatIdWithClient(tx, plan.origin.habitatId);
  if (plan.storage.fingerprint) {
    if (
      repoRows.length !== 1 ||
      !sameFingerprint(fingerprintOf(repoRows[0]!), plan.storage.fingerprint)
    ) {
      throw conflictWithCode(
        "EVIDENCE_CONTEXT_CHANGED",
        "The reporting repository configuration changed before the evidence write; refusing with zero writes.",
      );
    }
  } else if (repoRows.length !== 0) {
    throw conflictWithCode(
      "EVIDENCE_CONTEXT_CHANGED",
      "A repository configuration appeared for the reporting habitat before the evidence write; refusing with zero writes.",
    );
  }

  // 3. Planned record selection: ids/cardinality/provider/key.
  for (const [name, branchPlan] of plan.storage.branches) {
    if (!plan.storage.repositoryId) break;
    const candidates = codeBranchRepo.findByRepoAndNameWithClient(
      tx,
      plan.storage.repositoryId,
      name,
    );
    compareCandidates(candidates, branchPlan.selection, `branch ${name}`);
  }
  for (const [sha, commitPlan] of plan.storage.commits) {
    if (!plan.storage.repositoryId) break;
    const candidates = codeCommitRepo.findByRepoAndShaWithClient(
      tx,
      plan.storage.repositoryId,
      sha,
    );
    compareCandidates(candidates, commitPlan.selection, `commit ${sha}`);
  }
}

function compareCandidates(
  candidates: Array<{ id: string; provider: string }>,
  planned: RecordSelection,
  label: string,
): void {
  if (planned.action === "attach") {
    const match = candidates.find((c) => c.id === planned.recordId);
    const stillUniqueLocal = candidates.length === 1 && match && match.provider === "local";
    if (!stillUniqueLocal) {
      throw conflictWithCode(
        "EVIDENCE_CONTEXT_CHANGED",
        `The selected ${label} record changed before the evidence write; refusing with zero writes.`,
      );
    }
  } else if (candidates.length !== 0) {
    throw conflictWithCode(
      "EVIDENCE_CONTEXT_CHANGED",
      `A ${label} record appeared in the reporting domain before the evidence write; refusing with zero writes.`,
    );
  }
}

/**
 * Validates the ENTIRE returned link-context batch against the admitted plan
 * and the PUBLIC result BEFORE the first route event: the public result's
 * link IDs must match the internal contexts one-for-one in count and order;
 * every row id must match its context occurrence, its canonical pair must
 * belong to the plan (origin or admitted destination), and the exact
 * Task/Mission entity and actual EXISTING Habitat must still resolve through
 * exact stored-id reads (never a prefix-normalized refetch). Any invalid
 * context throws 500 with ZERO route events — already committed evidence may
 * remain, and the response must not claim rollback. Later audit/SSE failures
 * may still partially fan out; no outbox or atomic event guarantee exists.
 */
export function validateReportContexts(
  plan: ReportPlan,
  contexts: ReportEventContext[],
  result?: { links: Array<{ linkId: string }> },
): void {
  if (result) {
    // The public result is the emission inventory: same count, same order,
    // same ids. Missing, extra or swapped occurrences refuse before any
    // event is emitted.
    if (result.links.length !== contexts.length) {
      throw new AppError(
        500,
        "INTERNAL_ERROR",
        "Evidence result does not match the validated context batch; no route events were emitted.",
      );
    }
    for (let i = 0; i < contexts.length; i++) {
      if (result.links[i]!.linkId !== contexts[i]!.linkId) {
        throw new AppError(
          500,
          "INTERNAL_ERROR",
          "Evidence result order does not match the validated context batch; no route events were emitted.",
        );
      }
    }
  }

  for (const context of contexts) {
    const row = codeEvidenceLinkRepo.getById(context.linkId);
    if (!row || row.targetType !== context.targetType || row.targetId !== context.targetId) {
      throw new AppError(
        500,
        "INTERNAL_ERROR",
        "Evidence event context became invalid after the write bundle; no route events were emitted.",
      );
    }

    const inPlan =
      (plan.origin.kind === "task"
        ? context.targetType === "task" && context.targetId === plan.origin.taskId
        : context.targetType === "mission" && context.targetId === plan.origin.missionId) ||
      plan.destinations.some(
        (d) => d.kind === context.targetType && d.canonicalId === context.targetId,
      );
    if (!inPlan) {
      throw new AppError(
        500,
        "INTERNAL_ERROR",
        "Evidence event context does not belong to the admitted plan; no route events were emitted.",
      );
    }

    if (context.targetType === "task") {
      const task = getTaskRowExact(context.targetId);
      const mission = task ? getMissionRowExact(task.missionId) : null;
      const habitat = mission ? getHabitatRowExact(mission.habitatId) : null;
      if (!task || !mission || !habitat || mission.habitatId !== context.habitatId) {
        throw new AppError(
          500,
          "INTERNAL_ERROR",
          "Evidence event task context became invalid; no route events were emitted.",
        );
      }
      // Same underlying row; the repository mapper only narrows enum text
      // columns. The exact-row read above is what preserves literal-id
      // identity (no one-strip normalization).
      context.entityTask = task as unknown as Task;
    } else {
      const mission = getMissionRowExact(context.targetId);
      const habitat = mission ? getHabitatRowExact(mission.habitatId) : null;
      if (!mission || !habitat || mission.habitatId !== context.habitatId) {
        throw new AppError(
          500,
          "INTERNAL_ERROR",
          "Evidence event mission context became invalid; no route events were emitted.",
        );
      }
      context.entityMission = mission as unknown as Mission;
    }
  }
}
