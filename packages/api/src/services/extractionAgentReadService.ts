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

/** Default serialized character budget per finding item. */
const DEFAULT_TOTAL_CHAR_BUDGET = 4000;

/** Absolute hard maximum — no client request can exceed this. */
const HARD_TOTAL_CHAR_BUDGET = 8000;

/**
 * Resolve the effective total character budget. The client may request less;
 * the server clamps to the hard maximum. The budget is shared across all
 * agent-visible variable content, never applied independently per field.
 */
function resolveTotalCharBudget(requested?: number): number {
  if (!requested || requested <= 0) return DEFAULT_TOTAL_CHAR_BUDGET;
  return Math.min(requested, HARD_TOTAL_CHAR_BUDGET);
}

type BudgetedAgentFinding = AgentFindingSummary | AgentFindingDetail;

/** The get route serializes this exact envelope; using it is conservative for list items. */
function serializedFindingLength(finding: BudgetedAgentFinding): number {
  return JSON.stringify({ finding }).length;
}

function truncateStringToFit(value: string, fits: (candidate: string) => boolean): string {
  if (fits(value)) return value;

  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(value.slice(0, mid))) low = mid;
    else high = mid - 1;
  }
  return value.slice(0, low);
}

/**
 * Preserve JSON shape while shrinking oversized structured payloads. Object
 * properties and array entries are retained in order until the shared budget
 * is exhausted; oversized strings are prefix-truncated rather than emitting
 * invalid JSON.
 */
function clampJsonValue(value: unknown, maxSerializedChars: number): unknown {
  if (maxSerializedChars < 4) return null;

  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  if (serialized.length <= maxSerializedChars) return value;

  if (typeof value === "string") {
    return truncateStringToFit(
      value,
      (candidate) => JSON.stringify(candidate).length <= maxSerializedChars,
    );
  }

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      const nullCandidateLength = JSON.stringify([...result, null]).length;
      const allowance = maxSerializedChars - (nullCandidateLength - 4);
      if (allowance < 4) break;
      const clamped = clampJsonValue(item, allowance);
      const candidate = [...result, clamped];
      if (JSON.stringify(candidate).length > maxSerializedChars) break;
      result.push(clamped);
    }
    return result;
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const nullCandidate = { ...result, [key]: null };
      const allowance = maxSerializedChars - (JSON.stringify(nullCandidate).length - 4);
      if (allowance < 4) break;
      const clamped = clampJsonValue(item, allowance);
      const candidate = { ...result, [key]: clamped };
      if (JSON.stringify(candidate).length > maxSerializedChars) break;
      result[key] = clamped;
    }
    return result;
  }

  return null;
}

/** Clamp subject, body, caveats, and structured payload within one serialized budget. */
function applyTotalCharBudget<T extends BudgetedAgentFinding>(finding: T, budget: number): T {
  const result: BudgetedAgentFinding = {
    ...finding,
    subject: "",
    body: "",
    caveats: [],
    ...(Object.hasOwn(finding, "structuredPayload") ? { structuredPayload: null } : {}),
  };

  const fits = (candidate: BudgetedAgentFinding) => serializedFindingLength(candidate) <= budget;

  result.subject = truncateStringToFit(
    finding.subject,
    (subject) => fits({ ...result, subject }),
  );
  result.body = truncateStringToFit(
    finding.body,
    (body) => fits({ ...result, body }),
  );

  for (const caveat of finding.caveats) {
    const next = [...result.caveats, caveat];
    if (fits({ ...result, caveats: next })) {
      result.caveats = next;
      continue;
    }

    const truncated = truncateStringToFit(
      caveat,
      (candidate) => fits({ ...result, caveats: [...result.caveats, candidate] }),
    );
    if (truncated.length > 0) result.caveats = [...result.caveats, truncated];
    break;
  }

  if (Object.hasOwn(finding, "structuredPayload")) {
    const detail = finding as AgentFindingDetail;
    const fullPayload = { ...result, structuredPayload: detail.structuredPayload };
    if (fits(fullPayload)) {
      (result as AgentFindingDetail).structuredPayload = detail.structuredPayload;
    } else {
      const currentLength = serializedFindingLength(result);
      const payloadAllowance = budget - (currentLength - JSON.stringify(null).length);
      const clamped = clampJsonValue(detail.structuredPayload, payloadAllowance);
      const clampedResult = { ...result, structuredPayload: clamped };
      if (fits(clampedResult)) {
        (result as AgentFindingDetail).structuredPayload = clamped;
      }
    }
  }

  return result as T;
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
      const requestedKeys = new Set(
        refs.map((ref) => `${ref.sourceType}|${ref.sourceId}|${ref.sourceVersion}`),
      );
      const resolvedKeys = new Set(
        resolved.map((r) => `${r.ref.sourceType}|${r.ref.sourceId}|${r.ref.sourceVersion}`),
      );
      for (const key of requestedKeys) {
        if (!resolvedKeys.has(key)) return true;
      }
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
      return applyTotalCharBudget(f, budget);
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

  // I1 fix: budget the actual serialized route envelope across every variable
  // field, including caveats and the structured payload.
  const budget = resolveTotalCharBudget();
  return applyTotalCharBudget(finding, budget);
}
