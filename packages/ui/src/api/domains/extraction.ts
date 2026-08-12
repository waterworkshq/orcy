/**
 * Extraction API client — Learning Loop policy CRUD, review queue/detail,
 * CAS-protected decisions, citation refresh, manual execution controls,
 * and run/work history.
 *
 * All routes are under `/habitats/:habitatId/extraction/*`. The `request()`
 * helper prepends `/api`. Responses are unwrapped per the domain-module
 * convention (`.then((r) => r.field)`).
 *
 * AbortSignal is forwarded on every query-shaped call so React Query
 * cancellation is real (ADR-0040).
 */
import { request } from "../transport.js";
import type {
  LearningLoopPolicyRow,
  ExtractedFindingRow,
  ExtractionReviewQueueEntry,
  ExtractionFindingDetailView,
  ExtractionFindingSummary,
  ExtractionRunHistoryEntry,
} from "../../types/index.js";

// ---------------------------------------------------------------------------
// Policy CRUD
// ---------------------------------------------------------------------------

export const extractionApi = {
  /** List all extraction policies for a habitat. */
  listPolicies: (habitatId: string, signal?: AbortSignal) =>
    request<{ policies: LearningLoopPolicyRow[] }>(
      `/habitats/${habitatId}/extraction/policies`,
      { signal },
    ).then((r) => r.policies),

  /** Create a new extraction policy (starts disabled). */
  createPolicy: (
    habitatId: string,
    body: {
      extractorKey: string;
      sourceTypes: string[];
      schedule: string;
      windowSeconds: number;
      lookbackSeconds: number;
      minConfidence?: number | null;
      minSampleSize?: number | null;
      config?: Record<string, unknown>;
    },
  ) =>
    request<{ outcome: string; policy: LearningLoopPolicyRow }>(
      `/habitats/${habitatId}/extraction/policies`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  /** Update a policy with version CAS. */
  updatePolicy: (
    habitatId: string,
    policyId: string,
    body: {
      expectedVersion: number;
      enabled?: boolean;
      sourceTypes?: string[];
      schedule?: string;
      windowSeconds?: number;
      lookbackSeconds?: number;
      minConfidence?: number | null;
      minSampleSize?: number | null;
      config?: Record<string, unknown>;
    },
  ) =>
    request<{ outcome: string; policy: LearningLoopPolicyRow }>(
      `/habitats/${habitatId}/extraction/policies/${policyId}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),

  // ──────────────────────────────────────────────────────────────
  // Review queue + finding detail
  // ──────────────────────────────────────────────────────────────

  /** List proposed findings awaiting human review. */
  getReviewQueue: (
    habitatId: string,
    filters?: { findingType?: string; limit?: number },
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams();
    if (filters?.findingType) params.set("findingType", filters.findingType);
    if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return request<{ findings: ExtractionReviewQueueEntry[] }>(
      `/habitats/${habitatId}/extraction/review/queue${qs ? `?${qs}` : ""}`,
      { signal },
    ).then((r) => r.findings);
  },

  /** List accepted findings for the habitat. */
  listAcceptedFindings: (
    habitatId: string,
    filters?: { findingType?: string; domain?: string; limit?: number },
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams();
    if (filters?.findingType) params.set("findingType", filters.findingType);
    if (filters?.domain) params.set("domain", filters.domain);
    if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return request<{ findings: ExtractionFindingSummary[] }>(
      `/habitats/${habitatId}/extraction/findings${qs ? `?${qs}` : ""}`,
      { signal },
    ).then((r) => r.findings);
  },

  /** Get full finding detail with re-resolved citation states. */
  getFindingDetail: (
    habitatId: string,
    findingId: string,
    signal?: AbortSignal,
  ) =>
    request<ExtractionFindingDetailView>(
      `/habitats/${habitatId}/extraction/findings/${findingId}`,
      { signal },
    ),

  // ──────────────────────────────────────────────────────────────
  // Decisions (CAS-protected via expectedDecisionVersion)
  // ──────────────────────────────────────────────────────────────

  acceptFinding: (
    habitatId: string,
    findingId: string,
    body: { expectedDecisionVersion: number; reason?: string },
  ) =>
    request<{ finding: ExtractedFindingRow }>(
      `/habitats/${habitatId}/extraction/findings/${findingId}/accept`,
      { method: "POST", body: JSON.stringify(body) },
    ).then((r) => r.finding),

  rejectFinding: (
    habitatId: string,
    findingId: string,
    body: { expectedDecisionVersion: number; reason?: string },
  ) =>
    request<{ finding: ExtractedFindingRow }>(
      `/habitats/${habitatId}/extraction/findings/${findingId}/reject`,
      { method: "POST", body: JSON.stringify(body) },
    ).then((r) => r.finding),

  requestRevision: (
    habitatId: string,
    findingId: string,
    body: { expectedDecisionVersion: number; reason?: string },
  ) =>
    request<{ recorded: true }>(
      `/habitats/${habitatId}/extraction/findings/${findingId}/revise`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  withdrawFinding: (
    habitatId: string,
    findingId: string,
    body: { expectedDecisionVersion: number; reason?: string },
  ) =>
    request<{ finding: ExtractedFindingRow }>(
      `/habitats/${habitatId}/extraction/findings/${findingId}/withdraw`,
      { method: "POST", body: JSON.stringify(body) },
    ).then((r) => r.finding),

  // ──────────────────────────────────────────────────────────────
  // Citation refresh
  // ──────────────────────────────────────────────────────────────

  refreshCitations: (habitatId: string, findingId: string) =>
    request<{
      citations: Array<{ sourceId: string; state: string }>;
    }>(`/habitats/${habitatId}/extraction/findings/${findingId}/citations/refresh`, {
      method: "POST",
    }).then((r) => r.citations),

  // ──────────────────────────────────────────────────────────────
  // Wiki draft promotion (human-only)
  // ──────────────────────────────────────────────────────────────

  /** Promote an accepted finding to a Wiki draft page. */
  promoteToWiki: (
    habitatId: string,
    findingId: string,
    body: { destinationType: "wiki_draft" },
  ) =>
    request<{
      outcome: "promoted" | "already_promoted";
      promotion: {
        id: string;
        findingId: string;
        destinationType: string;
        destinationKey: string;
        status: string;
        targetType: string | null;
        targetId: string | null;
        targetVersion: string | null;
        consumedFindingRevision: number;
        error: string | null;
        completedAt: string | null;
      };
      pageId: string;
    }>(
      `/habitats/${habitatId}/extraction/findings/${findingId}/promote`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  // ──────────────────────────────────────────────────────────────
  // Manual execution controls
  //
  // These routes target the expected REST paths for ensure / fresh_rerun /
  // dry_run / run history. The service layer (extractionRunLifecycle.ts) is
  // delivered; REST route wiring is pending backend follow-up.
  // ──────────────────────────────────────────────────────────────

  /** Manual ensure — replay extraction for dedup/convergence. */
  ensureRun: (habitatId: string, policyId: string) =>
    request<{ result: unknown }>(
      `/habitats/${habitatId}/extraction/policies/${policyId}/ensure`,
      { method: "POST" },
    ).then((r) => r.result),

  /** Fresh rerun — requires a human reason. */
  freshRerun: (habitatId: string, policyId: string, reason: string) =>
    request<{ result: unknown }>(
      `/habitats/${habitatId}/extraction/policies/${policyId}/fresh-rerun`,
      { method: "POST", body: JSON.stringify({ reason }) },
    ).then((r) => r.result),

  /** Dry run — diagnostic extraction, no persisted findings. */
  dryRun: (habitatId: string, policyId: string) =>
    request<{ result: unknown }>(
      `/habitats/${habitatId}/extraction/policies/${policyId}/dry-run`,
      { method: "POST" },
    ).then((r) => r.result),

  /** Run/work history — extraction attempts for the habitat. */
  getRunHistory: (habitatId: string, signal?: AbortSignal) =>
    request<{ runs: ExtractionRunHistoryEntry[] }>(
      `/habitats/${habitatId}/extraction/runs`,
      { signal },
    ).then((r) => r.runs),
};
