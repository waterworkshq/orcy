import {
  publishScheduledOccurrence,
  resumeScheduledOccurrencePublication,
  type PublishScheduledOccurrenceOutcome,
  type ResumeScheduledOccurrenceOutcome,
} from "./scheduledOccurrencePublication.js";
import {
  publishInlineScheduledOccurrence,
  resumeInlineScheduledOccurrencePublication,
  type PublishInlineScheduledOccurrenceOutcome,
  type ResumeInlineScheduledOccurrenceOutcome,
} from "./inlineScheduledOccurrencePublication.js";
import {
  dispatchHandlerScheduledOccurrence,
  resumeHandlerScheduledOccurrenceDispatch,
  type PublishHandlerDispatchOutcome,
  type ResumeHandlerDispatchOutcome,
} from "./scheduledHandlerDispatch.js";

export type OccurrenceShape = "handler" | "template" | "inline";
export interface OccurrenceShapeSource {
  handlerKey?: string | null;
  templateId?: string | null;
  tasksTemplate?: unknown;
}
export type InitialOccurrenceOutcome = PublishScheduledOccurrenceOutcome | PublishInlineScheduledOccurrenceOutcome | PublishHandlerDispatchOutcome;
export type ResumeOccurrenceOutcome = ResumeScheduledOccurrenceOutcome | ResumeInlineScheduledOccurrenceOutcome | ResumeHandlerDispatchOutcome;
export type InitialDisposition = "terminal_success" | "terminal_failure" | "recoverable" | "contention";
export type RecoveryDisposition = "terminalized" | "resumable" | "skipped";
export interface InitialProjection {
  success: boolean;
  missionId?: string;
  error?: string;
  skipped?: boolean;
}
const initialDisposition = {
  published: "terminal_success", dispatched: "terminal_success",
  vetoed: "terminal_failure", rejected_validation: "terminal_failure",
  rejected_fingerprint: "terminal_failure", schedule_missing: "terminal_failure",
  handler_failed: "terminal_failure", handler_not_registered: "terminal_failure", not_found: "terminal_failure",
  schedule_guard_mismatch: "recoverable", guard_mismatch: "recoverable",
  governance_denied: "recoverable", schedule_vanished_mid_tx: "recoverable",
  replayed: "contention", already_publishing: "contention", illegal_source_state: "contention",
} satisfies Record<InitialOccurrenceOutcome["outcome"], InitialDisposition>;
const recoveryDisposition = {
  published: "terminalized", dispatched: "terminalized", vetoed: "terminalized",
  rejected_validation: "terminalized", rejected_fingerprint: "terminalized",
  schedule_missing: "terminalized", handler_failed: "terminalized", handler_not_registered: "terminalized",
  schedule_guard_mismatch: "resumable", guard_mismatch: "resumable",
  governance_denied: "resumable", schedule_vanished_mid_tx: "resumable", replayed: "resumable",
  not_found: "skipped", illegal_source_state: "skipped", not_owner: "skipped", already_publishing: "skipped",
} satisfies Record<InitialOccurrenceOutcome["outcome"] | ResumeOccurrenceOutcome["outcome"], RecoveryDisposition>;

/** Initial callers count not-found as failure; recovery treats it as skipped. */
export function classifyInitialOutcome(outcome: InitialOccurrenceOutcome): InitialDisposition {
  return initialDisposition[outcome.outcome];
}
/** Reserved takeover uses recovery counting even though it invokes initial adapters. */
export function classifyRecoveryOutcome(outcome: InitialOccurrenceOutcome | ResumeOccurrenceOutcome): RecoveryDisposition {
  return recoveryDisposition[outcome.outcome];
}
function initialProjection(scheduleId: string, shape: OccurrenceShape, outcome: InitialOccurrenceOutcome): InitialProjection {
  if (outcome.outcome === "published") return { success: true, missionId: outcome.mission.id };
  if (outcome.outcome === "dispatched") {
    const missionId = outcome.handlerResult.missionId;
    return { success: true, ...(missionId ? { missionId } : {}) };
  }
  if (classifyInitialOutcome(outcome) !== "terminal_failure") return { success: true, skipped: true };
  const prefix = shape === "inline" ? "Inline scheduled occurrence publication" : "Scheduled occurrence publication";
  switch (outcome.outcome) {
    case "handler_failed": return { success: false, error: outcome.error };
    case "handler_not_registered": return { success: false, error: `No handler registered for handlerKey "${outcome.handlerKey}" on scheduled task ${scheduleId}.` };
    case "schedule_missing": return { success: false, error: shape === "handler" ? "Handler dispatch failed (schedule missing)" : `${prefix} failed (schedule missing)` };
    case "not_found": return { success: false, error: shape === "handler" ? "Handler dispatch failed (occurrence not found)" : `${prefix} failed (occurrence not found)` };
    case "vetoed": return { success: false, error: `${prefix} vetoed by governance` };
    case "rejected_validation": return { success: false, error: `${prefix} rejected (validation)` };
    case "rejected_fingerprint": return { success: false, error: `${prefix} rejected (fingerprint mismatch)` };
    default: throw new Error(`Unexpected initial terminal outcome: ${outcome.outcome}`);
  }
}
export interface PublishReservedOccurrenceInput {
  scheduleId: string;
  occurrenceId: string;
  leaseOwner: string;
  leaseExpiresAt: string;
  shapeSource: OccurrenceShapeSource | null | undefined;
}
/** Publish a reserved occurrence; caller supplies its live or frozen routing basis. */
export function publishReservedOccurrence(input: PublishReservedOccurrenceInput) {
  const shape: OccurrenceShape = input.shapeSource?.handlerKey ? "handler" : input.shapeSource?.templateId ? "template" : "inline";
  const claim = { occurrenceId: input.occurrenceId, leaseOwner: input.leaseOwner, leaseExpiresAt: input.leaseExpiresAt };
  const outcome: InitialOccurrenceOutcome = shape === "handler" ? dispatchHandlerScheduledOccurrence(claim)
    : shape === "template" ? publishScheduledOccurrence(claim) : publishInlineScheduledOccurrence(claim);
  return {
    shape, outcome,
    initialDisposition: classifyInitialOutcome(outcome),
    recoveryDisposition: classifyRecoveryOutcome(outcome),
    projection: initialProjection(input.scheduleId, shape, outcome),
  };
}
export interface ResumeOccurrencePublicationInput {
  occurrenceId: string;
  leaseOwner: string;
  schedule: OccurrenceShapeSource | null | undefined;
}
/** Resume only under an already-reclaimed lease; malformed live shapes use template validation. */
export function resumeOccurrencePublication(input: ResumeOccurrencePublicationInput) {
  const source = input.schedule;
  const shape: OccurrenceShape = source?.handlerKey ? "handler" : source?.templateId ? "template"
    : source && Array.isArray(source.tasksTemplate) && source.tasksTemplate.length > 0 ? "inline" : "template";
  const claim = { occurrenceId: input.occurrenceId, leaseOwner: input.leaseOwner };
  const outcome: ResumeOccurrenceOutcome = shape === "handler" ? resumeHandlerScheduledOccurrenceDispatch(claim)
    : shape === "template" ? resumeScheduledOccurrencePublication(claim) : resumeInlineScheduledOccurrencePublication(claim);
  return { shape, outcome, recoveryDisposition: classifyRecoveryOutcome(outcome) };
}
