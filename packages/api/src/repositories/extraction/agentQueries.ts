/**
 * Actor-bound agent accepted-finding query — the security core.
 *
 * Implements the authorization-review §Agent read predicate as ONE joined
 * statement that returns an accepted finding only when ALL hold:
 *
 * 1. the supplied Task exists, `task.assigned_agent_id === agent`, status ∈
 *    {claimed, in_progress, submitted};
 * 2. the Task's Mission belongs to the requested Habitat AND finding.habitat_id
 *    matches;
 * 3. the finding is readable (accepted, not stale/withdrawn, visibility allows
 *    agent use — habitat_member only);
 * 4. ≥1 server-derived scope ref matches exactly task:<taskId> OR
 *    mission:<task.missionId> OR domain:<task.requiredDomain> (non-null).
 *
 * No Habitat-wide fallback. Unscoped findings are human-only. Client filters
 * only narrow the authorized set. Denials collapse not-found/forbidden into one
 * response with no count/existence oracle. Reassignment/terminalization before
 * the final SELECT removes access (no separate precheck race).
 *
 * Every `*WithClient` primitive accepts the caller-supplied client and never
 * calls `getDb()`, opens a nested transaction, or emits hooks/SSE/audit.
 */
import { sql } from "drizzle-orm";
import type {
  ExtractionFindingType,
  ExtractionFindingCompleteness,
} from "@orcy/shared";
import type { ExtractionDbClient } from "./types.js";

// ---------------------------------------------------------------------------
// Public input/output types
// ---------------------------------------------------------------------------

/** Optional client-side filters that may only NARROW the authorized result. */
export interface AgentFindingFilters {
  findingType?: ExtractionFindingType;
  /** Narrow to findings having a `domain` scope ref matching this value. */
  domain?: string;
  /** Exclude findings whose `last_seen_at` is older than now minus this. */
  maxAgeSeconds?: number;
  /** Soft cap on result count (default 10, hard-clamped to 25). */
  limit?: number;
  /** Truncate `subject` and `body` prose to this many characters. */
  maxChars?: number;
}

/** Summary of an accepted finding returned to an agent context. */
export interface AgentFindingSummary {
  id: string;
  habitatId: string;
  findingType: ExtractionFindingType;
  subject: string;
  body: string;
  confidence: number;
  sampleSize: number;
  completeness: ExtractionFindingCompleteness;
  caveats: string[];
  citationCount: number;
  revision: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Detail of a single accepted finding returned to an agent context. */
export interface AgentFindingDetail {
  id: string;
  habitatId: string;
  findingType: ExtractionFindingType;
  subject: string;
  body: string;
  structuredPayload: unknown;
  confidence: number;
  sampleSize: number;
  completeness: ExtractionFindingCompleteness;
  caveats: string[];
  citationCount: number;
  revision: number;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 10;
const HARD_LIMIT = 25;

/** Active task statuses that grant agent access to accepted findings. */
const ACTIVE_TASK_STATUSES = "('claimed', 'in_progress', 'submitted')";

// ---------------------------------------------------------------------------
// Agent-bound list — ONE joined SELECT with the full predicate
// ---------------------------------------------------------------------------

/**
 * List accepted findings authorized for the supplied agent + active task.
 *
 * The authorization predicate participates in the final SELECT via EXISTS
 * subqueries: if the task is reassigned or terminalized before this query
 * executes, the subqueries fail and no rows are returned. No separate precheck
 * can race into disclosure.
 *
 * Client filters (type/domain/age/limit/maxChars) are additional WHERE/ORDER
 * conditions on the same SELECT — they only narrow.
 */
export function listAcceptedFindingsForAgentWithClient(
  db: ExtractionDbClient,
  agentId: string,
  taskId: string,
  habitatId: string,
  filters?: AgentFindingFilters,
): AgentFindingSummary[] {
  const limit = Math.min(filters?.limit ?? DEFAULT_LIMIT, HARD_LIMIT);
  const maxChars = filters?.maxChars;

  const rows = db.all<{
    id: string;
    habitat_id: string;
    finding_type: string;
    subject: string;
    body: string;
    confidence: number;
    sample_size: number;
    completeness: string;
    caveats: string;
    revision: number;
    first_seen_at: string;
    last_seen_at: string;
    citation_count: number;
  }>(sql`
    SELECT
      ef.id, ef.habitat_id, ef.finding_type, ef.subject, ef.body,
      ef.confidence, ef.sample_size, ef.completeness, ef.caveats,
      ef.revision, ef.first_seen_at, ef.last_seen_at,
      (SELECT COUNT(*) FROM extracted_finding_sources src
       WHERE src.finding_id = ef.id) AS citation_count
    FROM extracted_findings ef
    WHERE ef.habitat_id = ${habitatId}
      AND ef.status = 'accepted'
      AND ef.completeness != 'stale'
      AND ef.visibility_ceiling = 'habitat_member'
      ${filters?.findingType
        ? sql`AND ef.finding_type = ${filters.findingType}`
        : sql``}
      ${filters?.domain
        ? sql`AND EXISTS (SELECT 1 FROM extracted_finding_scope_refs sr
            WHERE sr.finding_id = ef.id AND sr.scope_type = 'domain'
              AND sr.scope_id = ${filters.domain})`
        : sql``}
      ${filters?.maxAgeSeconds
        ? sql`AND ef.last_seen_at >= ${new Date(Date.now() - filters.maxAgeSeconds * 1000).toISOString()}`
        : sql``}
      AND EXISTS (
        SELECT 1 FROM tasks t
        JOIN missions m ON t.mission_id = m.id
        WHERE t.id = ${taskId}
          AND t.assigned_agent_id = ${agentId}
          AND t.status IN ${sql.raw(ACTIVE_TASK_STATUSES)}
          AND m.habitat_id = ${habitatId}
      )
      AND EXISTS (
        SELECT 1 FROM extracted_finding_scope_refs sr
        WHERE sr.finding_id = ef.id
          AND (
            (sr.scope_type = 'task' AND sr.scope_id = ${taskId})
            OR (sr.scope_type = 'mission' AND sr.scope_id = (
              SELECT t.mission_id FROM tasks t WHERE t.id = ${taskId}
            ))
            OR (
              sr.scope_type = 'domain'
              AND sr.scope_id = (
                SELECT t.required_domain FROM tasks t
                WHERE t.id = ${taskId} AND t.required_domain IS NOT NULL
              )
            )
          )
      )
    ORDER BY ef.last_seen_at DESC
    LIMIT ${limit}
  `);

  return rows.map((row) => ({
    id: row.id,
    habitatId: row.habitat_id,
    findingType: row.finding_type as ExtractionFindingType,
    subject: maxChars ? row.subject.slice(0, maxChars) : row.subject,
    body: maxChars ? row.body.slice(0, maxChars) : row.body,
    confidence: row.confidence,
    sampleSize: row.sample_size,
    completeness: row.completeness as ExtractionFindingCompleteness,
    caveats: JSON.parse(row.caveats) as string[],
    citationCount: row.citation_count,
    revision: row.revision,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  }));
}

// ---------------------------------------------------------------------------
// Agent-bound direct get — same predicate keyed by finding ID
// ---------------------------------------------------------------------------

/**
 * Get one accepted finding authorized for the supplied agent + active task.
 *
 * Uses exactly the same joined predicate as {@link listAcceptedFindingsForAgentWithClient}
 * but keyed by finding ID. Never fetches the finding first and authorizes
 * afterward — the authorization conditions participate in the final SELECT.
 *
 * Returns `null` for ALL denial cases (not-found, forbidden, wrong scope,
 * reassignment) — callers must respond identically to avoid leaking existence.
 */
export function getAcceptedFindingForAgentWithClient(
  db: ExtractionDbClient,
  agentId: string,
  taskId: string,
  habitatId: string,
  findingId: string,
): AgentFindingDetail | null {
  const rows = db.all<{
    id: string;
    habitat_id: string;
    finding_type: string;
    subject: string;
    body: string;
    structured_payload: string | null;
    confidence: number;
    sample_size: number;
    completeness: string;
    caveats: string;
    revision: number;
    occurrence_count: number;
    first_seen_at: string;
    last_seen_at: string;
    citation_count: number;
  }>(sql`
    SELECT
      ef.id, ef.habitat_id, ef.finding_type, ef.subject, ef.body,
      ef.structured_payload, ef.confidence, ef.sample_size, ef.completeness,
      ef.caveats, ef.revision, ef.occurrence_count,
      ef.first_seen_at, ef.last_seen_at,
      (SELECT COUNT(*) FROM extracted_finding_sources src
       WHERE src.finding_id = ef.id) AS citation_count
    FROM extracted_findings ef
    WHERE ef.id = ${findingId}
      AND ef.habitat_id = ${habitatId}
      AND ef.status = 'accepted'
      AND ef.completeness != 'stale'
      AND ef.visibility_ceiling = 'habitat_member'
      AND EXISTS (
        SELECT 1 FROM tasks t
        JOIN missions m ON t.mission_id = m.id
        WHERE t.id = ${taskId}
          AND t.assigned_agent_id = ${agentId}
          AND t.status IN ${sql.raw(ACTIVE_TASK_STATUSES)}
          AND m.habitat_id = ${habitatId}
      )
      AND EXISTS (
        SELECT 1 FROM extracted_finding_scope_refs sr
        WHERE sr.finding_id = ef.id
          AND (
            (sr.scope_type = 'task' AND sr.scope_id = ${taskId})
            OR (sr.scope_type = 'mission' AND sr.scope_id = (
              SELECT t.mission_id FROM tasks t WHERE t.id = ${taskId}
            ))
            OR (
              sr.scope_type = 'domain'
              AND sr.scope_id = (
                SELECT t.required_domain FROM tasks t
                WHERE t.id = ${taskId} AND t.required_domain IS NOT NULL
              )
            )
          )
      )
    LIMIT 1
  `);

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    id: row.id,
    habitatId: row.habitat_id,
    findingType: row.finding_type as ExtractionFindingType,
    subject: row.subject,
    body: row.body,
    structuredPayload: row.structured_payload
      ? JSON.parse(row.structured_payload)
      : null,
    confidence: row.confidence,
    sampleSize: row.sample_size,
    completeness: row.completeness as ExtractionFindingCompleteness,
    caveats: JSON.parse(row.caveats) as string[],
    citationCount: row.citation_count,
    revision: row.revision,
    occurrenceCount: row.occurrence_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}
