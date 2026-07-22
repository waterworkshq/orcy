/**
 * Dispatch Target Adapter Registry — DORMANT.
 *
 * Phase 1 of T4A. Defines the adapter CONTRACT that Phase 2's dispatcher worker
 * composes: for each dispatch target kind (client-stream, webhook/chat/
 * automation/plugin/post-interceptor ingress, transition subscribers — Technical
 * Plan line 450), an adapter attempts the target and returns `accepted` (Orcy
 * attempted the ephemeral client stream OR durably handed work to the internal
 * subsystem — external completion is NOT required) or `attention` (the target
 * needs retry / diagnostic intervention).
 *
 * NO adapters are registered in Phase 1 (T4B registers the real target classes).
 * An unregistered `targetKind` is a Phase-2 worker policy decision (not this
 * module's concern).
 *
 * DORMANT: no production origin creates post-cutover Tasks until cutover.
 */
import { taskCreationEnvelopes, taskCreationDispatchTargets } from "../db/schema/index.js";

/** Envelope row passed to an adapter (audit history; drives dispatch). */
type EnvelopeRow = typeof taskCreationEnvelopes.$inferSelect;

/** Dispatch-target row passed to an adapter (the row being attempted). */
type TargetRow = typeof taskCreationDispatchTargets.$inferSelect;

/**
 * The outcome of an adapter attempt on a single dispatch target.
 *
 * - `accepted` — per Technical Plan line 474: "Orcy attempted the ephemeral
 *   client stream OR durably handed work to the internal subsystem." External
 *   completion is NOT required; the observation checkpoint opens once every
 *   required target reaches `accepted`.
 * - `attention` — a retryable or diagnostic-worthy failure. The Phase 2 worker
 *   records `error` on the target row and re-attempts per its retry policy.
 */
export type DispatchTargetAttemptOutcome =
  | { outcome: "accepted" }
  | { outcome: "attention"; error: string };

/**
 * Adapter contract for a dispatch target kind.
 *
 * Implementations MUST be idempotent — the Phase 2 worker is at-least-once; a
 * replay after a crash re-attempts already-completed work.
 */
export interface DispatchTargetAdapter {
  /** The target kind this adapter handles (e.g. "mission_projection"). */
  targetKind: string;
  /**
   * Attempt the target. Receives the immutable envelope (provenance + causal
   * context) and the target row (kind + key + current retry state) so the
   * adapter can route to the correct internal subsystem.
   */
  attempt(envelope: EnvelopeRow, target: TargetRow): Promise<DispatchTargetAttemptOutcome>;
}

// ---------------------------------------------------------------------------
// Registry (module-level Map — mirrors packages/daemon/src/session/adapters.ts)
// ---------------------------------------------------------------------------

const adapters = new Map<string, DispatchTargetAdapter>();

/**
 * Register a dispatch target adapter. An adapter registered for an existing
 * `targetKind` overwrites the prior registration (last-writer-wins; supports
 * hot-reload and test isolation).
 */
export function registerDispatchAdapter(adapter: DispatchTargetAdapter): void {
  adapters.set(adapter.targetKind, adapter);
}

/**
 * Resolve the adapter for a target kind, or `undefined` if no adapter is
 * registered (an unregistered kind is a Phase-2 worker policy decision).
 */
export function resolveDispatchAdapter(targetKind: string): DispatchTargetAdapter | undefined {
  return adapters.get(targetKind);
}
