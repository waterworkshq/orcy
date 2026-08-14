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

/** Attribution actor type for triage write paths (triage, resolution, promotion). Shared across finding triage and triage resolution repos. */
export type TriageActorType =
  | "human"
  | "agent"
  | "system"
  | "remote_human"
  | "remote_orcy"
  | "remote_pod";

/**
 * Valid forward transitions in the finding_triage state machine.
 *
 * The restored lifecycle removes terminal-to-open edges: resolved/wontfix
 * are terminal and cannot be resurrected. Recurrence creates a new row with
 * persisted `recurrenceOf` lineage rather than reopening the old row.
 *
 * The legacy `["open"]` edges on terminal states are retained for the
 * transition map's type signature but the restored lifecycle command module
 * and later enforcement reject them. Existing service callers that used the
 * old map for validation will be migrated in the behavior cutover ticket.
 */
export const FINDING_TRIAGE_TRANSITIONS: Record<FindingTriageStatus, FindingTriageStatus[]> = {
  open: ["triaged", "in_progress", "wontfix"],
  triaged: ["in_progress", "resolved", "wontfix"],
  in_progress: ["resolved", "wontfix"],
  resolved: ["open"],
  wontfix: ["open"],
};

/**
 * Restored lifecycle: terminal states that must never move back to a
 * non-terminal state. Recurrence creates a new row, not a resurrection.
 */
export const TERMINAL_FINDING_TRIAGE_STATUSES: readonly FindingTriageStatus[] = [
  "resolved",
  "wontfix",
] as const;

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

// --- Restored lifecycle additive types ---

/** Activation cause for a finding triage record entering `in_progress`. */
export const ACTIVATION_CAUSES = ["manual", "release"] as const;

/** Cause of activation: manual human action or system Release activation. */
export type ActivationCause = (typeof ACTIVATION_CAUSES)[number];

/** Role of a Pulse in the normalized finding_triage_evidence table. */
export const FINDING_TRIAGE_EVIDENCE_ROLES = [
  "source",
  "corroborating",
  "legacy_observed",
] as const;

/** Role classification for evidence membership. */
export type FindingTriageEvidenceRole = (typeof FINDING_TRIAGE_EVIDENCE_ROLES)[number];

/** Mode of an offline lineage repair. */
export const LINEAGE_REPAIR_MODES = [
  "predecessor_mapping",
  "evidence_baselined_root",
] as const;

/** Mode for offline legacy lineage repair. */
export type LineageRepairMode = (typeof LINEAGE_REPAIR_MODES)[number];
