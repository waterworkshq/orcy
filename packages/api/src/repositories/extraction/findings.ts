/**
 * Extraction findings repository — atomic candidate persistence, recurrence
 * detection, and immutable-revision lineage.
 *
 * Candidate persistence commits one finding revision plus every citation and
 * server-derived scope ref in one transaction, guarded by the current attempt
 * fence. Same fingerprint + evidence digest increments recurrence only;
 * changed evidence creates a new immutable revision linked through lineage.
 *
 * Every `*WithClient` primitive accepts the caller-supplied client and never
 * calls `getDb()`, opens a nested transaction, or emits hooks/SSE/audit.
 */
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  extractedFindings,
  extractedFindingSources,
  extractedFindingScopeRefs,
  extractionAttempts,
} from "../../db/schema/index.js";
import {
  repositoryCreateError,
} from "../../errors/repository.js";
import type {
  ExtractedFindingRow,
  ExtractedFindingSourceRow,
  ExtractedFindingScopeRefRow,
  ExtractionFindingType,
  ExtractionFindingCompleteness,
  ExtractionVisibilityClass,
  ExtractionSourceType,
  ExtractionCitationRole,
  ExtractionSourceCompleteness,
  ExtractionScopeType,
} from "@orcy/shared";
import type { ExtractionDbClient } from "./types.js";
import type { ExtractionAttemptRow } from "@orcy/shared";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CitationInput {
  /** Caller-supplied citation row ID (so scope refs can reference it). */
  id: string;
  sourceType: ExtractionSourceType;
  sourceId: string;
  sourceVersion: string;
  role: ExtractionCitationRole;
  sourceDigest?: string | null;
  occurredAt?: string | null;
  entityRefs?: Array<{ type: string; id: string }>;
  completeness?: ExtractionSourceCompleteness;
  visibilityClass: ExtractionVisibilityClass;
}

export interface ScopeRefInput {
  scopeType: ExtractionScopeType;
  scopeId: string;
  /** Must match a `CitationInput.id` in the same `PersistCandidateInput`. */
  derivedFromSourceId: string;
}

export interface PersistCandidateInput {
  // Attempt fence — the caller supplies lease credentials proving it owns
  // the currently running attempt. A stale fence returns `fence_mismatch`
  // without persisting anything.
  attemptId: string;
  workItemId: string;
  leaseOwner: string;
  leaseGeneration: number;

  // Finding identity and provenance
  habitatId: string;
  firstAttemptId: string;
  fingerprint: string;
  evidenceDigest: string;
  extractorKey: string;
  extractorVersion: number;

  // Finding content (immutable)
  findingType: ExtractionFindingType;
  subject: string;
  body: string;
  structuredPayload?: unknown;
  confidence: number;
  sampleSize: number;
  completeness: ExtractionFindingCompleteness;
  visibilityCeiling: ExtractionVisibilityClass;
  caveats: string[];

  // Lineage
  lineageRootId: string;
  revision: number;
  supersedesFindingId?: string | null;

  // Citations and scope refs
  citations: CitationInput[];
  scopeRefs: ScopeRefInput[];
}

export type PersistCandidateResult =
  | { outcome: "created"; finding: ExtractedFindingRow; citations: ExtractedFindingSourceRow[]; scopeRefs: ExtractedFindingScopeRefRow[] }
  | { outcome: "recurrence"; finding: ExtractedFindingRow }
  | { outcome: "fence_mismatch"; attempt: ExtractionAttemptRow };

// ---------------------------------------------------------------------------
// Persist candidate (atomic: finding + citations + scope refs)
// ---------------------------------------------------------------------------

/**
 * Atomically persist one candidate finding revision plus all its citations and
 * server-derived scope refs, guarded by the attempt fence.
 *
 * Flow:
 * 1. Verify the attempt fence (running + lease owner + lease generation).
 *    A stale fence returns `fence_mismatch` without persisting.
 * 2. Check for recurrence: same `(habitat_id, extractor_key, extractor_version,
 *    fingerprint, evidence_digest)`. If found, increment recurrence counters
 *    only (`last_seen_at`, `last_seen_attempt_id`, `occurrence_count`).
 * 3. Otherwise, INSERT the finding, then every citation, then every scope ref.
 *    Any failure in steps 3 rolls back the entire transaction (caller's tx).
 *
 * The unique index on `(habitat_id, extractor_key, extractor_version,
 * fingerprint, evidence_digest)` is the race defender for concurrent
 * recurrence checks.
 */
export function persistCandidateWithClient(
  db: ExtractionDbClient,
  input: PersistCandidateInput,
): PersistCandidateResult {
  // --- 1. Attempt fence verification ---
  const attempt = db
    .select()
    .from(extractionAttempts)
    .where(
      and(
        eq(extractionAttempts.id, input.attemptId),
        eq(extractionAttempts.workItemId, input.workItemId),
      ),
    )
    .all()[0];

  if (!attempt) throw repositoryCreateError("extractionAttempt", undefined, input.attemptId);

  if (
    attempt.status !== "running" ||
    attempt.leaseOwner !== input.leaseOwner ||
    attempt.leaseGeneration !== input.leaseGeneration
  ) {
    return { outcome: "fence_mismatch", attempt: mapAttemptRow(attempt) };
  }

  // --- 2. Recurrence check ---
  const existing = db
    .select()
    .from(extractedFindings)
    .where(
      and(
        eq(extractedFindings.habitatId, input.habitatId),
        eq(extractedFindings.extractorKey, input.extractorKey),
        eq(extractedFindings.extractorVersion, input.extractorVersion),
        eq(extractedFindings.fingerprint, input.fingerprint),
        eq(extractedFindings.evidenceDigest, input.evidenceDigest),
      ),
    )
    .all()[0];

  if (existing) {
    // Recurrence: increment counters only. Content, evidence, extractor
    // identity, confidence, and completeness never mutate on an existing
    // revision.
    const now = new Date().toISOString();
    db.update(extractedFindings)
      .set({
        lastSeenAt: now,
        lastSeenAttemptId: input.attemptId,
        occurrenceCount: existing.occurrenceCount + 1,
        updatedAt: now,
      })
      .where(eq(extractedFindings.id, existing.id))
      .run();

    const updated = db
      .select()
      .from(extractedFindings)
      .where(eq(extractedFindings.id, existing.id))
      .all()[0];
    if (!updated) throw repositoryCreateError("extractedFinding", undefined, existing.id);
    return { outcome: "recurrence", finding: mapFindingRow(updated) };
  }

  // --- 3. New finding: INSERT finding, then citations, then scope refs ---
  const findingId = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(extractedFindings)
      .values({
        id: findingId,
        habitatId: input.habitatId,
        firstAttemptId: input.firstAttemptId,
        lastSeenAttemptId: input.attemptId,
        lineageRootId: input.lineageRootId,
        supersedesFindingId: input.supersedesFindingId ?? null,
        revision: input.revision,
        extractorKey: input.extractorKey,
        extractorVersion: input.extractorVersion,
        findingType: input.findingType,
        subject: input.subject,
        body: input.body,
        structuredPayload: input.structuredPayload ?? null,
        confidence: input.confidence,
        sampleSize: input.sampleSize,
        completeness: input.completeness,
        visibilityCeiling: input.visibilityCeiling,
        fingerprint: input.fingerprint,
        evidenceDigest: input.evidenceDigest,
        status: "proposed",
        decisionVersion: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        occurrenceCount: 1,
        caveats: input.caveats,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("extractedFinding", err as Error, findingId);
  }

  // Insert all citations
  const createdCitations: ExtractedFindingSourceRow[] = [];
  for (const cite of input.citations) {
    try {
      db.insert(extractedFindingSources)
        .values({
          id: cite.id,
          findingId,
          sourceType: cite.sourceType,
          sourceId: cite.sourceId,
          sourceVersion: cite.sourceVersion,
          role: cite.role,
          sourceDigest: cite.sourceDigest ?? null,
          occurredAt: cite.occurredAt ?? null,
          entityRefs: cite.entityRefs ?? [],
          completeness: cite.completeness ?? "complete",
          visibilityClass: cite.visibilityClass,
        })
        .run();
    } catch (err) {
      // Any citation failure rolls back the finding and all subordinate rows.
      // The caller's transaction owns the rollback.
      throw repositoryCreateError("extractedFindingSource", err as Error, cite.id);
    }

    const srcRow = db
      .select()
      .from(extractedFindingSources)
      .where(eq(extractedFindingSources.id, cite.id))
      .all()[0];
    if (srcRow) createdCitations.push(mapSourceRow(srcRow));
  }

  // Insert all scope refs
  const createdScopeRefs: ExtractedFindingScopeRefRow[] = [];
  for (const ref of input.scopeRefs) {
    const refId = uuid();
    try {
      db.insert(extractedFindingScopeRefs)
        .values({
          id: refId,
          findingId,
          scopeType: ref.scopeType,
          scopeId: ref.scopeId,
          derivedFromSourceId: ref.derivedFromSourceId,
        })
        .run();
    } catch (err) {
      throw repositoryCreateError("extractedFindingScopeRef", err as Error, refId);
    }

    const refRow = db
      .select()
      .from(extractedFindingScopeRefs)
      .where(eq(extractedFindingScopeRefs.id, refId))
      .all()[0];
    if (refRow) createdScopeRefs.push(mapScopeRefRow(refRow));
  }

  const findingRow = db
    .select()
    .from(extractedFindings)
    .where(eq(extractedFindings.id, findingId))
    .all()[0];
  if (!findingRow) throw repositoryCreateError("extractedFinding", undefined, findingId);

  return {
    outcome: "created",
    finding: mapFindingRow(findingRow),
    citations: createdCitations,
    scopeRefs: createdScopeRefs,
  };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function getFindingByIdWithClient(
  db: ExtractionDbClient,
  findingId: string,
): ExtractedFindingRow | null {
  const row = db
    .select()
    .from(extractedFindings)
    .where(eq(extractedFindings.id, findingId))
    .all()[0];
  return row ? mapFindingRow(row) : null;
}

export function getFindingsByHabitatWithClient(
  db: ExtractionDbClient,
  habitatId: string,
): ExtractedFindingRow[] {
  return db
    .select()
    .from(extractedFindings)
    .where(eq(extractedFindings.habitatId, habitatId))
    .all()
    .map(mapFindingRow);
}

export function getCitationsByFindingWithClient(
  db: ExtractionDbClient,
  findingId: string,
): ExtractedFindingSourceRow[] {
  return db
    .select()
    .from(extractedFindingSources)
    .where(eq(extractedFindingSources.findingId, findingId))
    .all()
    .map(mapSourceRow);
}

export function getScopeRefsByFindingWithClient(
  db: ExtractionDbClient,
  findingId: string,
): ExtractedFindingScopeRefRow[] {
  return db
    .select()
    .from(extractedFindingScopeRefs)
    .where(eq(extractedFindingScopeRefs.findingId, findingId))
    .all()
    .map(mapScopeRefRow);
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

type FindingDbRow = typeof extractedFindings.$inferSelect;
type SourceDbRow = typeof extractedFindingSources.$inferSelect;
type ScopeRefDbRow = typeof extractedFindingScopeRefs.$inferSelect;
type AttemptDbRow = typeof extractionAttempts.$inferSelect;

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
    findingType: row.findingType as ExtractionFindingType,
    subject: row.subject,
    body: row.body,
    structuredPayload: row.structuredPayload,
    confidence: row.confidence,
    sampleSize: row.sampleSize,
    completeness: row.completeness as ExtractionFindingCompleteness,
    visibilityCeiling: row.visibilityCeiling as ExtractionVisibilityClass,
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

function mapSourceRow(row: SourceDbRow): ExtractedFindingSourceRow {
  return {
    id: row.id,
    findingId: row.findingId,
    sourceType: row.sourceType as ExtractionSourceType,
    sourceId: row.sourceId,
    sourceVersion: row.sourceVersion,
    role: row.role as ExtractionCitationRole,
    sourceDigest: row.sourceDigest,
    occurredAt: row.occurredAt,
    entityRefs: row.entityRefs,
    completeness: row.completeness as ExtractionSourceCompleteness,
    visibilityClass: row.visibilityClass as ExtractionVisibilityClass,
    createdAt: row.createdAt,
  };
}

function mapScopeRefRow(row: ScopeRefDbRow): ExtractedFindingScopeRefRow {
  return {
    id: row.id,
    findingId: row.findingId,
    scopeType: row.scopeType as ExtractionScopeType,
    scopeId: row.scopeId,
    derivedFromSourceId: row.derivedFromSourceId,
    createdAt: row.createdAt,
  };
}

function mapAttemptRow(row: AttemptDbRow): ExtractionAttemptRow {
  return {
    id: row.id,
    workItemId: row.workItemId,
    attemptNo: row.attemptNo,
    parentAttemptId: row.parentAttemptId,
    deliveryMode: row.deliveryMode as ExtractionAttemptRow["deliveryMode"],
    leaseOwner: row.leaseOwner,
    leaseGeneration: row.leaseGeneration,
    leaseExpiresAt: row.leaseExpiresAt,
    sourceSnapshot: row.sourceSnapshot,
    status: row.status as ExtractionAttemptRow["status"],
    candidateCount: row.candidateCount,
    persistedCount: row.persistedCount,
    deduplicatedCount: row.deduplicatedCount,
    error: row.error,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
