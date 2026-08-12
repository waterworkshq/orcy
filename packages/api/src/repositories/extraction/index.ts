/**
 * Extraction repository barrel — re-exports every public primitive.
 *
 * Importers should import from here, not from individual modules:
 * ```ts
 * import {
 *   createPolicyWithClient,
 *   reserveWorkItemWithClient,
 *   persistCandidateWithClient,
 *   reviewCasWithClient,
 *   reservePromotionWithClient,
 * } from "../repositories/extraction/index.js";
 * ```
 */
export type {
  ExtractionDbClient,
  ReserveWorkItemResult,
  TerminalizeWorkItemResult,
  PersistCandidateResult,
  ReviewCasResult,
  ReservePromotionResult,
  TerminalizePromotionResult,
} from "./types.js";
export { isUniqueConstraintViolation, getChanges } from "./types.js";

export {
  createPolicyWithClient,
  getPolicyByIdWithClient,
  getPoliciesByHabitatWithClient,
  updatePolicyWithClient,
  type CreatePolicyInput,
  type CreatePolicyResult,
  type UpdatePolicyInput,
  type UpdatePolicyResult,
} from "./policies.js";

export {
  reserveWorkItemWithClient,
  getWorkItemByIdWithClient,
  getWorkItemsByHabitatWithClient,
  terminalizeWorkItemWithClient,
  type ReserveWorkItemInput,
  type TerminalizeWorkItemInput,
} from "./workItems.js";

export {
  createAttemptWithClient,
  getAttemptByIdWithClient,
  getAttemptsByWorkItemWithClient,
  getLatestAttemptWithClient,
  terminalizeAttemptWithClient,
  type CreateAttemptInput,
  type CreateAttemptResult,
  type TerminalizeAttemptInput,
} from "./attempts.js";

export {
  persistCandidateWithClient,
  getFindingByIdWithClient,
  getFindingsByHabitatWithClient,
  getCitationsByFindingWithClient,
  getScopeRefsByFindingWithClient,
  type CitationInput,
  type ScopeRefInput,
  type PersistCandidateInput,
} from "./findings.js";

export {
  reviewCasWithClient,
  getReviewsByFindingWithClient,
  type ReviewCasInput,
} from "./reviews.js";

export {
  reservePromotionWithClient,
  terminalizePromotionWithClient,
  recordPromotionTargetWithClient,
  reArmPromotionWithClient,
  getPromotionsByFindingWithClient,
  isWikiPageExcludedFromSources,
  type ReservePromotionInput,
  type TerminalizePromotionInput,
  type RecordPromotionTargetInput,
  type RecordPromotionTargetResult,
  type ReArmPromotionInput,
  type ReArmPromotionResult,
} from "./promotions.js";

export {
  listAcceptedFindingsForAgentWithClient,
  getAcceptedFindingForAgentWithClient,
  type AgentFindingFilters,
  type AgentFindingSummary,
  type AgentFindingDetail,
} from "./agentQueries.js";
