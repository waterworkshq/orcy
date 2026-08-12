/**
 * Agent accepted-finding read service — citation re-resolution on every read.
 *
 * Wraps the actor-bound repository queries with a post-query citation
 * re-resolution pass. A finding whose citation has degraded to
 * `unauthorized`, `dangling`, or `changed` is excluded from agent reads —
 * indistinguishable from not-found. This enforces ADR-0045's
 * captured-ceiling-is-not-a-permanent-grant rule.
 *
 * The actor-bound SQL predicate is unchanged (one joined SELECT). The
 * re-resolution may only NARROW the authorized set — never widen it.
 *
 * For Experience citations specifically, a below-floor cohort resolves
 * `unauthorized` on resolve (composes with B2 window-scoped floor).
 */
import {
  listAcceptedFindingsForAgentWithClient,
  getAcceptedFindingForAgentWithClient,
  getCitationsByFindingWithClient,
  type AgentFindingFilters,
  type AgentFindingSummary,
  type AgentFindingDetail,
} from "../repositories/extraction/index.js";
import { getDb } from "../db/index.js";
import { getAdapter, type ResolveRef, type ViewerContext } from "./extractionSourceCatalog/index.js";
import type {
  CitationResolutionState,
} from "@orcy/shared";
import type { ExtractionDbClient } from "../repositories/extraction/types.js";

// ---------------------------------------------------------------------------
// Blocking citation states
// ---------------------------------------------------------------------------

/** Citation states that collapse a finding from agent reads. */
const BLOCKING_STATES: ReadonlySet<CitationResolutionState> = new Set([
  "unauthorized",
  "dangling",
  "changed",
]);

// ---------------------------------------------------------------------------
// Character budget (I1 — server-owned total rendered-character budget)
// ---------------------------------------------------------------------------

/** Default total character budget per finding item (subject + body combined). */
const DEFAULT_TOTAL_CHAR_BUDGET = 4000;

/** Absolute hard maximum — no client request can exceed this. */
const HARD_TOTAL_CHAR_BUDGET = 8000;

/**
 * Resolve the effective total character budget. The client may request less;
 * the server clamps to the hard maximum. The budget is shared across subject
 * and body — NOT applied independently (fixes the 2× issue).
 */
function resolveTotalCharBudget(requested?: number): number {
  if (!requested || requested <= 0) return DEFAULT_TOTAL_CHAR_BUDGET;
  return Math.min(requested, HARD_TOTAL_CHAR_BUDGET);
}

/** Truncate subject + body within a shared total budget. */
function applyTotalCharBudget(
  subject: string,
  body: string,
  budget: number,
): { subject: string; body: string } {
  const subjectLen = subject.length;
  if (subjectLen >= budget) {
    return { subject: subject.slice(0, budget), body: "" };
  }
  const bodyBudget = budget - subjectLen;
  return { subject, body: body.slice(0, bodyBudget) };
}

// ---------------------------------------------------------------------------
// Citation re-resolution
// ---------------------------------------------------------------------------

/**
 * Re-resolve all citations for a finding and return whether any are in a
 * blocking state. Blocking states collapse the finding from agent reads.
 */
function hasBlockingCitations(
  db: ExtractionDbClient,
  findingId: string,
  habitatId: string,
): boolean {
  const citations = getCitationsByFindingWithClient(db, findingId);
  if (citations.length === 0) return true; // No citations → invalid for agent reads.

  const viewer: ViewerContext = { habitatId };

  // Group by source type for batch resolution.
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

  for (const [sourceType, refs] of byType) {
    try {
      const adapter = getAdapter(sourceType as never);
      const resolved = adapter.resolveByRefs(refs, viewer);
      for (const r of resolved) {
        if (BLOCKING_STATES.has(r.state)) {
          return true;
        }
      }
    } catch {
      // Adapter failure → treat as blocking (fail closed).
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List accepted findings for an agent, with current citation re-resolution.
 *
 * Runs the actor-bound query, then re-resolves every citation for each result.
 * Findings with any blocking citation are excluded — indistinguishable from
 * not-found. No reason is leaked.
 */
export function listAcceptedFindingsForAgent(
  agentId: string,
  taskId: string,
  habitatId: string,
  filters?: AgentFindingFilters,
): AgentFindingSummary[] {
  const db = getDb();
  const budget = resolveTotalCharBudget(filters?.maxChars);

  const findings = listAcceptedFindingsForAgentWithClient(
    db,
    agentId,
    taskId,
    habitatId,
    filters,
  );

  // Re-resolve citations — narrow the authorized set.
  return findings
    .filter((f) => !hasBlockingCitations(db, f.id, habitatId))
    .map((f) => {
      const truncated = applyTotalCharBudget(f.subject, f.body, budget);
      return { ...f, subject: truncated.subject, body: truncated.body };
    });
}

/**
 * Get one accepted finding for an agent, with current citation re-resolution.
 *
 * Returns null for ALL denial cases (not-found, forbidden, wrong scope,
 * reassignment, blocking citation) — callers must respond identically.
 */
export function getAcceptedFindingForAgent(
  agentId: string,
  taskId: string,
  habitatId: string,
  findingId: string,
): AgentFindingDetail | null {
  const db = getDb();

  const finding = getAcceptedFindingForAgentWithClient(
    db,
    agentId,
    taskId,
    habitatId,
    findingId,
  );

  if (!finding) return null;

  // Re-resolve citations — a blocking citation collapses to not-found.
  if (hasBlockingCitations(db, finding.id, habitatId)) {
    return null;
  }

  return finding;
}
