/**
 * Extraction reviews repository — append-only review decisions with
 * compare-and-set on `decisionVersion`.
 *
 * Two reviewers using one expected version yield one decision and one
 * conflict. The CAS uses `SELECT changes()` for portable affected-row
 * classification across both SQLite backends.
 *
 * Every `*WithClient` primitive accepts the caller-supplied client and never
 * calls `getDb()`, opens a nested transaction, or emits hooks/SSE/audit.
 */
import { eq, and, asc } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  extractedFindings,
  extractedFindingReviews,
} from "../../db/schema/index.js";
import { repositoryCreateError, repositoryUpdateError } from "../../errors/repository.js";
import { inArray } from "drizzle-orm";
import type {
  ExtractedFindingReviewRow,
  ExtractedFindingRow,
  ExtractionReviewDecision,
  ExtractionFindingStatus,
  CitationResolutionState,
} from "@orcy/shared";
import type { ExtractionDbClient } from "./types.js";
import { getChanges } from "./types.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface ReviewCasInput {
  findingId: string;
  decision: ExtractionReviewDecision;
  reason?: string | null;
  reviewerType?: "human" | "agent" | "system";
  reviewerId: string;
  expectedDecisionVersion: number;
  resolvedCitationStates?: Array<{ sourceId: string; state: CitationResolutionState }>;
}

export type ReviewCasResult =
  | { outcome: "decided"; review: ExtractedFindingReviewRow; finding: ExtractedFindingRow }
  | { outcome: "version_conflict"; finding: ExtractedFindingRow }
  | { outcome: "illegal_source_state"; finding: ExtractedFindingRow; fromState: string };

// ---------------------------------------------------------------------------
// Review compare-and-set
// ---------------------------------------------------------------------------

/**
 * Append one review decision and update the finding status/decision_version
 * atomically in one caller-owned transaction.
 *
 * CAS predicate: `id = findingId AND decision_version = expectedDecisionVersion
 * AND status IN (allowed_prior_statuses)`.
 *
 * `affected === 1` → decision recorded and finding status bumped.
 * `affected === 0` → either a concurrent reviewer bumped the version
 *   (version_conflict) or the finding's status is not in the allowed set
 *   (illegal_source_state). Re-reading distinguishes the two.
 *
 * The review row is always inserted AFTER the CAS succeeds, so a conflict
 * leaves no orphan review. The caller MUST wrap this in a transaction so
 * that a review-INSERT failure rolls back the status update.
 *
 * Approved state machine:
 *   proposed → accepted | rejected | proposed (request_revision)
 *   accepted → withdrawn
 *   withdrawn is terminal unless a separately-approved recovery transition exists.
 */
export function reviewCasWithClient(
  db: ExtractionDbClient,
  input: ReviewCasInput,
): ReviewCasResult {
  const newStatus = decisionToStatus(input.decision);
  const allowedPriorStatuses = allowedPriorStatusesFor(input.decision);
  const newVersion = input.expectedDecisionVersion + 1;
  const now = new Date().toISOString();

  // --- 1. CAS the finding status and decision_version with state-machine guard ---
  try {
    db.update(extractedFindings)
      .set({
        status: newStatus,
        decisionVersion: newVersion,
        updatedAt: now,
      })
      .where(
        and(
          eq(extractedFindings.id, input.findingId),
          eq(extractedFindings.decisionVersion, input.expectedDecisionVersion),
          inArray(extractedFindings.status, allowedPriorStatuses),
        ),
      )
      .run();
  } catch (err) {
    throw repositoryUpdateError("extractedFinding", err as Error, input.findingId);
  }

  const affected = getChanges(db);

  // Re-read the finding (needed for all branches)
  const findingRow = db
    .select()
    .from(extractedFindings)
    .where(eq(extractedFindings.id, input.findingId))
    .all()[0];
  if (!findingRow) throw repositoryCreateError("extractedFinding", undefined, input.findingId);

  if (affected === 0) {
    // Distinguish version conflict from illegal source state.
    if (!allowedPriorStatuses.includes(findingRow.status as ExtractionFindingStatus)) {
      return {
        outcome: "illegal_source_state",
        finding: mapFindingRow(findingRow),
        fromState: findingRow.status,
      };
    }
    return { outcome: "version_conflict", finding: mapFindingRow(findingRow) };
  }

  // --- 2. Append the review row ---
  const reviewId = uuid();
  try {
    db.insert(extractedFindingReviews)
      .values({
        id: reviewId,
        findingId: input.findingId,
        decision: input.decision,
        reason: input.reason ?? null,
        reviewerType: input.reviewerType ?? "human",
        reviewerId: input.reviewerId,
        expectedDecisionVersion: input.expectedDecisionVersion,
        resultingDecisionVersion: newVersion,
        resolvedCitationStates: input.resolvedCitationStates ?? [],
      })
      .run();
  } catch (err) {
    // This should not happen if the CAS succeeded — but if it does, the
    // caller's transaction will roll back the CAS update too.
    throw repositoryCreateError("extractedFindingReview", err as Error, reviewId);
  }

  const reviewRow = db
    .select()
    .from(extractedFindingReviews)
    .where(eq(extractedFindingReviews.id, reviewId))
    .all()[0];
  if (!reviewRow) throw repositoryCreateError("extractedFindingReview", undefined, reviewId);

  return {
    outcome: "decided",
    review: mapReviewRow(reviewRow),
    finding: mapFindingRow(findingRow),
  };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function getReviewsByFindingWithClient(
  db: ExtractionDbClient,
  findingId: string,
): ExtractedFindingReviewRow[] {
  return db
    .select()
    .from(extractedFindingReviews)
    .where(eq(extractedFindingReviews.findingId, findingId))
    .orderBy(asc(extractedFindingReviews.createdAt))
    .all()
    .map(mapReviewRow);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decisionToStatus(decision: ExtractionReviewDecision): ExtractionFindingStatus {
  switch (decision) {
    case "accept": return "accepted";
    case "reject": return "rejected";
    case "request_revision": return "proposed"; // status unchanged; records feedback
    case "withdraw": return "withdrawn";
  }
}

/**
 * Allowed prior statuses for each decision — the state-machine guard.
 * proposed → accepted|rejected|proposed (request_revision)
 * accepted → withdrawn
 * withdrawn is terminal.
 */
function allowedPriorStatusesFor(decision: ExtractionReviewDecision): ExtractionFindingStatus[] {
  switch (decision) {
    case "accept":
    case "reject":
    case "request_revision":
      return ["proposed"];
    case "withdraw":
      return ["accepted"];
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

type FindingDbRow = typeof extractedFindings.$inferSelect;
type ReviewDbRow = typeof extractedFindingReviews.$inferSelect;

function mapFindingRow(row: FindingDbRow): ExtractedFindingRow {
  return {
    id: row.id,
    habitatId: row.habitatId,
    firstAttemptId: row.firstAttemptId,
    lastSeenAttemptId: row.lastSeenAttemptId,
    lineageRootId: row.lineageRootId,
    supersedesFindingId: row.supersedesFindingId,
    revision: row.revision,
    extractorKey: row.extractorKey,
    extractorVersion: row.extractorVersion,
    findingType: row.findingType as ExtractedFindingRow["findingType"],
    subject: row.subject,
    body: row.body,
    structuredPayload: row.structuredPayload,
    confidence: row.confidence,
    sampleSize: row.sampleSize,
    completeness: row.completeness as ExtractedFindingRow["completeness"],
    visibilityCeiling: row.visibilityCeiling as ExtractedFindingRow["visibilityCeiling"],
    fingerprint: row.fingerprint,
    evidenceDigest: row.evidenceDigest,
    status: row.status as ExtractedFindingRow["status"],
    decisionVersion: row.decisionVersion,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    occurrenceCount: row.occurrenceCount,
    caveats: row.caveats,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapReviewRow(row: ReviewDbRow): ExtractedFindingReviewRow {
  return {
    id: row.id,
    findingId: row.findingId,
    decision: row.decision as ExtractionReviewDecision,
    reason: row.reason,
    reviewerType: row.reviewerType as "human" | "agent" | "system",
    reviewerId: row.reviewerId,
    expectedDecisionVersion: row.expectedDecisionVersion,
    resultingDecisionVersion: row.resultingDecisionVersion,
    resolvedCitationStates: row.resolvedCitationStates as Array<{ sourceId: string; state: CitationResolutionState }>,
    createdAt: row.createdAt,
  };
}
