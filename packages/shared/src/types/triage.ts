/**
 * Triage domain shared types (v0.23 "Triage").
 *
 * Finding triage lifecycle, resolution records, and trigger payloads for the
 * two new automation scans (signal_pattern_clustered, agent_quality_degraded).
 *
 * Rationale: ADR-0024 (cluster detection as scan), ADR-0027 (parallel-table
 * lifecycle). Status machine and resolution kinds are shared between API,
 * MCP, and UI consumers.
 */

/** Exhaustive readonly list of finding triage lifecycle states. */
export const FINDING_TRIAGE_STATUSES = [
  "open",
  "triaged",
  "in_progress",
  "resolved",
  "wontfix",
] as const;

/** Lifecycle state of a finding_triage record. */
export type FindingTriageStatus = (typeof FINDING_TRIAGE_STATUSES)[number];

/**
 * Valid forward transitions in the finding_triage state machine.
 *
 * Acyclic graph with a single backward edge: terminal states (resolved,
 * wontfix) may reopen to `open` on recurrence detection (manual review).
 * Invalid transitions are rejected by the repository layer.
 */
export const FINDING_TRIAGE_TRANSITIONS: Record<FindingTriageStatus, FindingTriageStatus[]> = {
  open: ["triaged", "in_progress", "wontfix"],
  triaged: ["in_progress", "resolved", "wontfix"],
  in_progress: ["resolved", "wontfix"],
  resolved: ["open"],
  wontfix: ["open"],
};

/** Exhaustive readonly list of resolution kinds recorded against a triage. */
export const RESOLUTION_KINDS = [
  "config_change",
  "doc_clarification",
  "code_fix",
  "process_change",
  "wontfix",
  "other",
] as const;

/** Categorisation of how a triage was resolved. */
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number];

/**
 * Cluster payload carried in a `signal_pattern_clustered` scan trigger context.
 *
 * Grouped raw pulses by normalize(subject) within a time window, across
 * provenance. Consumed by automation conditions/actions and surfaced to the
 * daemon agent as investigation context.
 */
export interface ClusterPayload {
  clusterKey: string;
  /** Primary (most-common) category, derived from provenanceBreakdown. */
  skillCategory: string;
  /** signalType/skillCategory → count. */
  provenanceBreakdown: Record<string, number>;
  signalCount: number;
  affectedTaskIds: string[];
  affectedMissionIds: string[];
  agentIds: string[];
  crossMissionCount: number;
  distinctAgentCount: number;
  timeWindowDays: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * Agent quality payload carried in an `agent_quality_degraded` scan trigger
 * context. Informational only — does NOT mutate assignment, gates, or
 * permissions (CONTEXT.md).
 */
export interface AgentQualityPayload {
  agentId: string;
  agentName: string;
  score: number;
  confidence: string;
  sampleSize: number;
  dimensions: {
    approval: number | null;
    nonRejectionRate: number | null;
    consistency: number | null;
  };
}
