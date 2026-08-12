/**
 * Extraction review service — human-only queue/list/detail, CAS decisions,
 * citation re-resolution, and append-only review history.
 *
 * Every decision uses `expectedDecisionVersion` CAS via {@link reviewCasWithClient}:
 * concurrent reviewers receive 409 rather than last-write-wins. Accept/reject
 * require a reason; request_revision records feedback only (does not mutate
 * the finding). Citation re-resolution runs through the source catalog adapter
 * on decision and promotion eligibility, recording resolved states at decision
 * time.
 *
 * Privacy: audit events/SSE payloads carry NO raw source bodies or Experience
 * contributor data. Aggregate-only citations expose bands/caveats only.
 */
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";
import { extractedFindings, extractedFindingReviews } from "../db/schema/index.js";
import {
  reviewCasWithClient,
  getReviewsByFindingWithClient,
  getFindingByIdWithClient,
  getFindingsByHabitatWithClient,
  getCitationsByFindingWithClient,
  getChanges,
  type ReviewCasInput,
} from "../repositories/extraction/index.js";
import { getAdapter, type ResolveRef, type ViewerContext } from "./extractionSourceCatalog/index.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { notFound, conflict, badRequest } from "../errors.js";
import type {
  ExtractedFindingRow,
  ExtractedFindingReviewRow,
  ExtractionReviewDecision,
  CitationResolutionState,
  ExtractionVisibilityClass,
  ExtractionFindingType,
} from "@orcy/shared";

// ---------------------------------------------------------------------------
// Review queue + detail (human-only)
// ---------------------------------------------------------------------------

export interface ReviewQueueEntry {
  id: string;
  findingType: ExtractionFindingType;
  subject: string;
  confidence: number;
  sampleSize: number;
  completeness: string;
  visibilityCeiling: ExtractionVisibilityClass;
  decisionVersion: number;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
}

export interface ReviewQueueFilters {
  findingType?: ExtractionFindingType;
  limit?: number;
}

/** List proposed findings awaiting human review, most recent first. */
export function getReviewQueue(
  habitatId: string,
  filters?: ReviewQueueFilters,
): ReviewQueueEntry[] {
  const limit = Math.min(filters?.limit ?? 50, 100);
  let findings = getFindingsByHabitatWithClient(getDb(), habitatId)
    .filter((f) => f.status === "proposed");

  if (filters?.findingType) {
    findings = findings.filter((f) => f.findingType === filters.findingType);
  }

  return findings
    .toSorted((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    .slice(0, limit)
    .map((f) => ({
      id: f.id,
      findingType: f.findingType,
      subject: f.subject,
      confidence: f.confidence,
      sampleSize: f.sampleSize,
      completeness: f.completeness,
      visibilityCeiling: f.visibilityCeiling,
      decisionVersion: f.decisionVersion,
      firstSeenAt: f.firstSeenAt,
      lastSeenAt: f.lastSeenAt,
      occurrenceCount: f.occurrenceCount,
    }));
}

// ---------------------------------------------------------------------------
// Finding detail with citations (human-only)
// ---------------------------------------------------------------------------

export interface CitationSummary {
  id: string;
  sourceType: string;
  role: string;
  visibilityClass: ExtractionVisibilityClass;
  completeness: string;
  /** Re-resolved state at read time. */
  resolutionState: CitationResolutionState;
  /** Present only for available citations with non-aggregate visibility. */
  occurredAt: string | null;
  entityRefs: Array<{ type: string; id: string }> | null;
}

export interface FindingDetail {
  finding: ExtractedFindingRow;
  citations: CitationSummary[];
  reviews: ExtractedFindingReviewRow[];
}

/**
 * Get full finding detail with re-resolved citation states.
 *
 * For aggregate-only citations: entity refs and source IDs are omitted (no
 * drill-down). For unauthorized/dangling citations: only the resolution state
 * marker is shown.
 */
export function getFindingDetail(
  habitatId: string,
  findingId: string,
): FindingDetail {
  const finding = getFindingByIdWithClient(getDb(), findingId);
  if (!finding || finding.habitatId !== habitatId) {
    throw notFound("Finding not found");
  }

  const citations = getCitationsByFindingWithClient(getDb(), findingId);
  const reviews = getReviewsByFindingWithClient(getDb(), findingId);
  const citationSummaries = resolveCitationSummaries(citations, habitatId);

  return { finding, citations: citationSummaries, reviews };
}

// ---------------------------------------------------------------------------
// Human accepted-finding list (broader than agent query — no task bound)
// ---------------------------------------------------------------------------

export interface HumanFindingFilters {
  findingType?: ExtractionFindingType;
  domain?: string;
  maxAgeSeconds?: number;
  limit?: number;
}

export interface HumanFindingSummary {
  id: string;
  findingType: ExtractionFindingType;
  subject: string;
  confidence: number;
  sampleSize: number;
  completeness: string;
  visibilityCeiling: ExtractionVisibilityClass;
  citationCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Human-only list of accepted findings in the habitat (no task predicate). */
export function listAcceptedFindings(
  habitatId: string,
  filters?: HumanFindingFilters,
): HumanFindingSummary[] {
  const limit = Math.min(filters?.limit ?? 25, 100);
  let findings = getFindingsByHabitatWithClient(getDb(), habitatId)
    .filter((f) => f.status === "accepted" && f.completeness !== "stale");

  if (filters?.findingType) {
    findings = findings.filter((f) => f.findingType === filters.findingType);
  }
  if (filters?.maxAgeSeconds) {
    const cutoff = new Date(Date.now() - filters.maxAgeSeconds * 1000).toISOString();
    findings = findings.filter((f) => f.lastSeenAt >= cutoff);
  }

  return findings
    .toSorted((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    .slice(0, limit)
    .map((f) => ({
      id: f.id,
      findingType: f.findingType,
      subject: f.subject,
      confidence: f.confidence,
      sampleSize: f.sampleSize,
      completeness: f.completeness,
      visibilityCeiling: f.visibilityCeiling,
      citationCount: getCitationsByFindingWithClient(getDb(), f.id).length,
      firstSeenAt: f.firstSeenAt,
      lastSeenAt: f.lastSeenAt,
    }));
}

// ---------------------------------------------------------------------------
// Decisions (human-only, CAS-protected)
// ---------------------------------------------------------------------------

export interface DecisionInput {
  habitatId: string;
  findingId: string;
  reviewerId: string;
  expectedDecisionVersion: number;
  reason?: string;
}

/** Accept a proposed finding. Reason required. Re-resolves citations at decision time. */
export function acceptFinding(input: DecisionInput): ExtractedFindingRow {
  if (!input.reason?.trim()) {
    throw badRequest("A reason is required for accept decisions");
  }
  return executeDecision(input, "accept");
}

/** Reject a proposed finding. Reason required. */
export function rejectFinding(input: DecisionInput): ExtractedFindingRow {
  if (!input.reason?.trim()) {
    throw badRequest("A reason is required for reject decisions");
  }
  return executeDecision(input, "reject");
}

/**
 * Request revision: records feedback only. Does NOT mutate the finding status
 * or decision version in a breaking way. A new immutable revision must supersede.
 */
export function requestRevision(input: DecisionInput): { recorded: true } {
  const finding = getFindingByIdWithClient(getDb(), input.findingId);
  if (!finding || finding.habitatId !== input.habitatId) {
    throw notFound("Finding not found");
  }

  const resolvedStates = resolveCitationStates(input.habitatId, input.findingId);
  const db = getDb();

  const casInput: ReviewCasInput = {
    findingId: input.findingId,
    decision: "request_revision",
    reason: input.reason ?? null,
    reviewerType: "human",
    reviewerId: input.reviewerId,
    expectedDecisionVersion: input.expectedDecisionVersion,
    resolvedCitationStates: resolvedStates,
  };

  const result = reviewCasWithClient(db, casInput);
  if (result.outcome === "version_conflict") {
    throw conflict("Finding decision version mismatch — another reviewer acted first");
  }

  emitDecisionSSE(input.habitatId, input.findingId, "request_revision");
  return { recorded: true };
}

/**
 * Withdraw a finding (privacy/integrity invalidation). Status → withdrawn.
 * Uses CAS: only succeeds if the expected decision version matches.
 */
export function withdrawFinding(input: DecisionInput): ExtractedFindingRow {
  const finding = getFindingByIdWithClient(getDb(), input.findingId);
  if (!finding || finding.habitatId !== input.habitatId) {
    throw notFound("Finding not found");
  }

  const db = getDb();
  const resolvedStates = resolveCitationStates(input.habitatId, input.findingId);
  const newVersion = input.expectedDecisionVersion + 1;
  const now = new Date().toISOString();

  // CAS: only update if the expected version matches
  db.update(extractedFindings)
    .set({ status: "withdrawn", decisionVersion: newVersion, updatedAt: now })
    .where(
      and(
        eq(extractedFindings.id, input.findingId),
        eq(extractedFindings.decisionVersion, input.expectedDecisionVersion),
      ),
    )
    .run();

  const affected = getChanges(db);
  if (affected === 0) {
    throw conflict("Finding decision version mismatch — another reviewer acted first");
  }

  // Append the review history row
  const reviewId = uuid();
  db.insert(extractedFindingReviews)
    .values({
      id: reviewId,
      findingId: input.findingId,
      decision: "reject", // closest decision enum; reason carries context
      reason: input.reason ?? "Withdrawn",
      reviewerType: "human",
      reviewerId: input.reviewerId,
      expectedDecisionVersion: input.expectedDecisionVersion,
      resultingDecisionVersion: newVersion,
      resolvedCitationStates: resolvedStates,
    })
    .run();

  emitDecisionSSE(input.habitatId, input.findingId, "withdrawn");

  const updated = getFindingByIdWithClient(getDb(), input.findingId);
  return updated ?? finding;
}

// ---------------------------------------------------------------------------
// Citation state refresh
// ---------------------------------------------------------------------------

/** Re-resolve and return current citation states for a finding. */
export function refreshCitationStates(
  habitatId: string,
  findingId: string,
): Array<{ sourceId: string; state: CitationResolutionState }> {
  const finding = getFindingByIdWithClient(getDb(), findingId);
  if (!finding || finding.habitatId !== habitatId) {
    throw notFound("Finding not found");
  }
  return resolveCitationStates(habitatId, findingId);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function executeDecision(
  input: DecisionInput,
  decision: ExtractionReviewDecision,
): ExtractedFindingRow {
  const finding = getFindingByIdWithClient(getDb(), input.findingId);
  if (!finding || finding.habitatId !== input.habitatId) {
    throw notFound("Finding not found");
  }

  const resolvedStates = resolveCitationStates(input.habitatId, input.findingId);
  const db = getDb();

  const casInput: ReviewCasInput = {
    findingId: input.findingId,
    decision,
    reason: input.reason ?? null,
    reviewerType: "human",
    reviewerId: input.reviewerId,
    expectedDecisionVersion: input.expectedDecisionVersion,
    resolvedCitationStates: resolvedStates,
  };

  const result = reviewCasWithClient(db, casInput);
  if (result.outcome === "version_conflict") {
    throw conflict("Finding decision version mismatch — another reviewer acted first");
  }

  emitDecisionSSE(input.habitatId, input.findingId, decision);
  return result.finding;
}

/** Resolve citation states through the source catalog adapters. */
function resolveCitationStates(
  habitatId: string,
  findingId: string,
): Array<{ sourceId: string; state: CitationResolutionState }> {
  const citations = getCitationsByFindingWithClient(getDb(), findingId);
  const viewer: ViewerContext = { habitatId };

  // Group by source type for adapter resolution
  const byType = new Map<string, ResolveRef[]>();
  for (const c of citations) {
    const group = byType.get(c.sourceType) ?? [];
    group.push({
      sourceType: c.sourceType,
      sourceId: c.sourceId,
      sourceVersion: c.sourceVersion,
      sourceDigest: c.sourceDigest,
    });
    byType.set(c.sourceType, group);
  }

  const result: Array<{ sourceId: string; state: CitationResolutionState }> = [];
  for (const [sourceType, refs] of byType) {
    try {
      const adapter = getAdapter(sourceType as never);
      const resolved = adapter.resolveByRefs(refs, viewer);
      for (const r of resolved) {
        result.push({ sourceId: r.ref.sourceId, state: r.state });
      }
    } catch {
      for (const r of refs) {
        result.push({ sourceId: r.sourceId, state: "dangling" });
      }
    }
  }

  return result;
}

/** Build citation summaries with re-resolved states, respecting aggregate-only privacy. */
function resolveCitationSummaries(
  citations: ReturnType<typeof getCitationsByFindingWithClient>,
  habitatId: string,
): CitationSummary[] {
  const viewer: ViewerContext = { habitatId };

  // Group by source type for adapter resolution
  const byType = new Map<string, ResolveRef[]>();
  for (const c of citations) {
    const group = byType.get(c.sourceType) ?? [];
    group.push({
      sourceType: c.sourceType,
      sourceId: c.sourceId,
      sourceVersion: c.sourceVersion,
      sourceDigest: c.sourceDigest,
    });
    byType.set(c.sourceType, group);
  }

  const stateMap = new Map<string, CitationResolutionState>();
  for (const [sourceType, refs] of byType) {
    try {
      const adapter = getAdapter(sourceType as never);
      const resolved = adapter.resolveByRefs(refs, viewer);
      for (const r of resolved) {
        stateMap.set(r.ref.sourceId, r.state);
      }
    } catch {
      for (const r of refs) {
        stateMap.set(r.sourceId, "dangling");
      }
    }
  }

  return citations.map((c) => {
    const state = stateMap.get(c.sourceId) ?? "dangling";
    const isAggregate = c.visibilityClass === "aggregate_only";
    const showDetails = state === "available" && !isAggregate;

    return {
      id: c.id,
      sourceType: c.sourceType,
      role: c.role,
      visibilityClass: c.visibilityClass,
      completeness: c.completeness,
      resolutionState: state,
      occurredAt: showDetails ? c.occurredAt : null,
      entityRefs: showDetails ? c.entityRefs : null,
    };
  });
}

/** Emit a decision-changed or withdrawal SSE event (IDs + bounded state only). */
function emitDecisionSSE(
  habitatId: string,
  findingId: string,
  decision: string,
): void {
  try {
    if (decision === "withdrawn") {
      sseBroadcaster.publish(habitatId, {
        type: "extraction.finding_withdrawn",
        data: { habitatId, findingId },
      });
    } else {
      sseBroadcaster.publish(habitatId, {
        type: "extraction.decision_changed",
        data: { habitatId, findingId, decision },
      });
    }
  } catch {
    // SSE broadcast failure is non-fatal
  }
}
