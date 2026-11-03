// Grounds for each test in this file (ticket T2, plan "Introduce the internal
// execution module with RED→GREEN matrix tests"; requirement coverage R1–R4, R7, R11–R12):
// - "classifies %s without flattening caller semantics" → DESIGN §5 Exhaustive outcome
//   matrix (initial vs recovery buckets) + §6; PRD R4 honest outcomes (no flattened
//   success, distinct skipped/resumable/terminalized).
// - "skips a resume loser without making it an initial outcome" → DESIGN §5 row
//   "not_owner (resume only) → not an initial result; skipped".
// - "routes initial shape %j to %s" → DESIGN §4 routing matrix (handler > template >
//   inline; unconditional initial inline fallback); PRD R3 shape compatibility.
// - "routes resume shape %j to %s" → DESIGN §4 resume asymmetry (nonempty
//   tasksTemplate gate, empty/malformed/missing → template resume fallback); PRD R3.
// - "preserves raw identity and coherent published projection" → DESIGN §3 (outcome is
//   the unchanged raw union) + §6 (published returns Mission id); PRD R4/R7.
// - "preserves handler Mission omission for %s" → DESIGN §6 (absent/empty handler
//   mission id stays omitted).
// - "preserves aggregate failure text %s" → DESIGN §6 exact existing failure strings,
//   template vs inline prefix; PRD R4.
// - "preserves handler failure %s" → DESIGN §6 handler-returned failure text and the
//   missing/not-found shape difference.
// - "keeps the handler registration diagnostic outside generic aggregate errors" →
//   DESIGN §3 (scheduleId is presentation context for the byte-identical
//   missing-handler message) + §6.
// - "preserves replay as initial skip but recovery resumable" → DESIGN §5 replayed row
//   (contention/resumable, never terminalized); PRD R4.
// - "does not swallow adapter infrastructure errors" → DESIGN §5 thrown-exception row
//   (escapes the module to existing caller handling); PRD §6 failure/refusal policy.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  publishReservedOccurrence,
  resumeOccurrencePublication,
  classifyInitialOutcome,
  classifyRecoveryOutcome,
  type InitialOccurrenceOutcome,
  type ResumeOccurrenceOutcome,
} from "../services/scheduledOccurrenceExecution.js";

const adapters = vi.hoisted(() => ({
  initialTemplate: vi.fn(), initialInline: vi.fn(), initialHandler: vi.fn(),
  resumeTemplate: vi.fn(), resumeInline: vi.fn(), resumeHandler: vi.fn(),
}));
vi.mock("../services/scheduledOccurrencePublication.js", () => ({
  publishScheduledOccurrence: adapters.initialTemplate,
  resumeScheduledOccurrencePublication: adapters.resumeTemplate,
}));
vi.mock("../services/inlineScheduledOccurrencePublication.js", () => ({
  publishInlineScheduledOccurrence: adapters.initialInline,
  resumeInlineScheduledOccurrencePublication: adapters.resumeInline,
}));
vi.mock("../services/scheduledHandlerDispatch.js", () => ({
  dispatchHandlerScheduledOccurrence: adapters.initialHandler,
  resumeHandlerScheduledOccurrenceDispatch: adapters.resumeHandler,
}));
const claim = { occurrenceId: "occurrence", leaseOwner: "worker", leaseExpiresAt: "2026-11-02T12:00:00.000Z" };
const initialInput = { scheduleId: "schedule", ...claim };
const raw = (outcome: InitialOccurrenceOutcome["outcome"]) => ({ outcome }) as InitialOccurrenceOutcome;
beforeEach(() => {
  for (const adapter of Object.values(adapters)) {
    adapter.mockReset();
    adapter.mockReturnValue({ outcome: "not_found" });
  }
});

const matrix = [
  ["published", "terminal_success", "terminalized"],
  ["dispatched", "terminal_success", "terminalized"],
  ["vetoed", "terminal_failure", "terminalized"],
  ["rejected_validation", "terminal_failure", "terminalized"],
  ["rejected_fingerprint", "terminal_failure", "terminalized"],
  ["schedule_missing", "terminal_failure", "terminalized"],
  ["handler_failed", "terminal_failure", "terminalized"],
  ["handler_not_registered", "terminal_failure", "terminalized"],
  ["not_found", "terminal_failure", "skipped"],
  ["schedule_guard_mismatch", "recoverable", "resumable"],
  ["guard_mismatch", "recoverable", "resumable"],
  ["governance_denied", "recoverable", "resumable"],
  ["schedule_vanished_mid_tx", "recoverable", "resumable"],
  ["replayed", "contention", "resumable"],
  ["already_publishing", "contention", "skipped"],
  ["illegal_source_state", "contention", "skipped"],
] as const;

describe("Scheduled Occurrence execution", () => {
  it.each(matrix)("classifies %s without flattening caller semantics", (name, initial, recovery) => {
    expect(classifyInitialOutcome(raw(name))).toBe(initial);
    expect(classifyRecoveryOutcome(raw(name))).toBe(recovery);
  });
  it("skips a resume loser without making it an initial outcome", () => {
    expect(classifyRecoveryOutcome({ outcome: "not_owner" } as ResumeOccurrenceOutcome)).toBe("skipped");
    adapters.resumeTemplate.mockReturnValue({ outcome: "not_owner" });
    const result = resumeOccurrencePublication({ occurrenceId: claim.occurrenceId, leaseOwner: claim.leaseOwner, schedule: null });
    expect(result.recoveryDisposition).toBe("skipped");
  });
  it.each([
    [{ handlerKey: "handler", templateId: "template", tasksTemplate: [{}] }, "handler"],
    [{ templateId: "template", tasksTemplate: [{}] }, "template"],
    [{ tasksTemplate: [{}] }, "inline"],
    [{ tasksTemplate: [] }, "inline"],
    [null, "inline"],
  ] as const)("routes initial shape %j to %s", (shapeSource, expected) => {
    const result = publishReservedOccurrence({ ...initialInput, shapeSource });
    expect(result.shape).toBe(expected);
    const selected = expected === "handler" ? adapters.initialHandler : expected === "template" ? adapters.initialTemplate : adapters.initialInline;
    expect(selected).toHaveBeenCalledExactlyOnceWith(claim);
    expect(Object.values(adapters).reduce((n, adapter) => n + adapter.mock.calls.length, 0)).toBe(1);
  });
  it.each([
    [{ handlerKey: "handler", templateId: "template", tasksTemplate: [{}] }, "handler"],
    [{ templateId: "template", tasksTemplate: [{}] }, "template"],
    [{ tasksTemplate: [{}] }, "inline"],
    [{ tasksTemplate: [] }, "template"],
    [null, "template"],
  ] as const)("routes resume shape %j to %s", (schedule, expected) => {
    const result = resumeOccurrencePublication({ occurrenceId: claim.occurrenceId, leaseOwner: claim.leaseOwner, schedule });
    expect(result.shape).toBe(expected);
    const selected = expected === "handler" ? adapters.resumeHandler : expected === "template" ? adapters.resumeTemplate : adapters.resumeInline;
    expect(selected).toHaveBeenCalledExactlyOnceWith({ occurrenceId: claim.occurrenceId, leaseOwner: claim.leaseOwner });
    expect(Object.values(adapters).reduce((n, adapter) => n + adapter.mock.calls.length, 0)).toBe(1);
  });
  it("preserves raw identity and coherent published projection", () => {
    const outcome = { outcome: "published", mission: { id: "mission" } };
    adapters.initialTemplate.mockReturnValue(outcome);
    const result = publishReservedOccurrence({ ...initialInput, shapeSource: { templateId: "template" } });
    expect(result.outcome).toBe(outcome);
    expect(result.projection).toEqual({ success: true, missionId: "mission" });
  });
  it.each([undefined, "", "handler-mission"])("preserves handler Mission omission for %s", (missionId) => {
    adapters.initialHandler.mockReturnValue({ outcome: "dispatched", handlerResult: { success: true, missionId } });
    const result = publishReservedOccurrence({ ...initialInput, shapeSource: { handlerKey: "handler" } });
    expect(result.projection).toEqual({ success: true, ...(missionId ? { missionId } : {}) });
  });
  it.each([
    ["vetoed", "vetoed by governance"],
    ["rejected_validation", "rejected (validation)"],
    ["rejected_fingerprint", "rejected (fingerprint mismatch)"],
    ["schedule_missing", "failed (schedule missing)"],
    ["not_found", "failed (occurrence not found)"],
  ] as const)("preserves aggregate failure text %s", (name, suffix) => {
    adapters.initialTemplate.mockReturnValue(raw(name));
    adapters.initialInline.mockReturnValue(raw(name));
    expect(publishReservedOccurrence({ ...initialInput, shapeSource: { templateId: "template" } }).projection)
      .toEqual({ success: false, error: `Scheduled occurrence publication ${suffix}` });
    expect(publishReservedOccurrence({ ...initialInput, shapeSource: null }).projection)
      .toEqual({ success: false, error: `Inline scheduled occurrence publication ${suffix}` });
  });
  it.each([
    ["schedule_missing", "Handler dispatch failed (schedule missing)"],
    ["not_found", "Handler dispatch failed (occurrence not found)"],
    ["handler_failed", "handler-error"],
  ] as const)("preserves handler failure %s", (outcome, error) => {
    adapters.initialHandler.mockReturnValue({ outcome, error: "handler-error" });
    expect(publishReservedOccurrence({ ...initialInput, shapeSource: { handlerKey: "handler" } }).projection).toEqual({ success: false, error });
  });
  it("keeps the handler registration diagnostic outside generic aggregate errors", () => {
    adapters.initialHandler.mockReturnValue({ outcome: "handler_not_registered", handlerKey: "absent" });
    const result = publishReservedOccurrence({ ...initialInput, shapeSource: { handlerKey: "absent" } });
    expect(result.projection).toEqual({ success: false, error: 'No handler registered for handlerKey "absent" on scheduled task schedule.' });
  });
  it("preserves replay as initial skip but recovery resumable", () => {
    adapters.initialInline.mockReturnValue(raw("replayed"));
    const result = publishReservedOccurrence({ ...initialInput, shapeSource: null });
    expect(result.projection).toEqual({ success: true, skipped: true });
    expect(result.recoveryDisposition).toBe("resumable");
  });
  it("does not swallow adapter infrastructure errors", () => {
    const failure = new Error("database failure");
    adapters.initialInline.mockImplementation(() => { throw failure; });
    expect(() => publishReservedOccurrence({ ...initialInput, shapeSource: null })).toThrow(failure);
    adapters.resumeTemplate.mockImplementation(() => { throw failure; });
    expect(() => resumeOccurrencePublication({ occurrenceId: "occurrence", leaseOwner: "worker", schedule: null })).toThrow(failure);
  });
});
