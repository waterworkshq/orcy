/**
 * Automation inbox handoff + consumer services for `release.shipped`.
 *
 * # Admission (`admitReleaseShippedEventToInbox`)
 * One transaction (manual `BEGIN IMMEDIATE` on the shared connection, or the
 * caller's already-open transaction via `client`) freezes:
 *   - the immutable `(event_type, event_id)` inbox entry with its full payload;
 *   - the MATCHED executable rule-REVISION set (the full immutable revisions,
 *     not live rule ids). A rule whose live row predates the revision feature
 *     is backfilled from its current state inside the same transaction.
 * Later live-rule edit/delete cannot change what executes.
 *
 * # Consumer (`drainAutomationInbox`)
 * Leases/fences each drainable delivery (pending, or leased with an EXPIRED
 * lease — a live lease stays pending) and passes the PERSISTED full revision
 * plus the Release event identity and the attempt-generation key to the
 * canonical lifecycle (`attemptRuleRun` frozen overload). No caller bypasses
 * `attemptRuleRun`.
 *
 * # Stale-lease proof-aware recovery
 * On a stale lease the consumer classifies each ordered action checkpoint
 * BEFORE acting:
 *   - a `proved` checkpoint never reruns (this generation or any successor,
 *     via predecessor carry-forward);
 *   - an unproved action may resume the SAME generation under a new fence
 *     only when every unresolved action declares an end-to-end idempotency
 *     contract (see `RESUME_SAFE_ACTION_TYPES`);
 *   - otherwise the delivery becomes `attention_required` and NEVER
 *     re-executes automatically.
 *
 * # Operator dispositions
 * `waiveAutomationDelivery` (after external reconciliation) and
 * `createAutomationDeliverySuccessorGeneration` (explicit, reason + duplicate
 * -risk acknowledgement) are audited in the append-only disposition ledger.
 * Predecessor generations and proved receipts stay immutable; a stale worker
 * cannot complete a successor (fence CAS).
 *
 * The inbox entry is terminal only when every frozen revision is terminal,
 * durably skipped, or waived. `attention_required` remains visible and is NOT
 * success.
 */
import { sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as outboxRepo from "../repositories/automationRunCompletionOutbox.js";
import * as revisionRepo from "../repositories/automationRuleRevision.js";
import type {
  AutomationRuleRevision,
  AutomationDbClient,
} from "../repositories/automationRuleRevision.js";
import * as deliveryRepo from "../repositories/automationRuleDelivery.js";
import type {
  AutomationRuleDeliveryRow,
  AutomationEventInboxRow,
} from "../repositories/automationRuleDelivery.js";
import { normalizeEventTrigger } from "./automationEventService.js";
import { notifyAutomationRunCompleted } from "./automationExecutor.js";
import {
  attemptRuleRun,
  type AutomationFrozenAttemptDisposition,
  type AutomationAttemptSource,
} from "./automationAttemptLifecycle.js";
import type { AutomationAction, AutomationRule, AutomationRunStatus } from "@orcy/shared";

export const RELEASE_SHIPPED_EVENT_TYPE = "release.shipped";

/** Default lease TTL for one consumer pass over a delivery. */
export const DEFAULT_LEASE_TTL_MS = 60_000;

/**
 * Action types with a DECLARED end-to-end idempotency contract — re-executing
 * them converges to the same durable state, so a stale lease may resume the
 * same generation and rerun them:
 *   - `change_priority` sets an absolute value;
 *   - `mark_risk` is a pure marker (the executor writes nothing).
 * Every other action type (notify, create_signal, create_task, assign,
 * release_assignment, request_review, call_webhook, plugin) can produce a
 * duplicate external effect on rerun and has no provider receipt we can
 * query — those classify to `attention_required` when unproved.
 */
export const RESUME_SAFE_ACTION_TYPES: ReadonlySet<string> = new Set([
  "change_priority",
  "mark_risk",
]);

// ---------------------------------------------------------------------------
// Local immediate-transaction helper (automation-scoped)
// ---------------------------------------------------------------------------

/**
 * Automation-scoped `BEGIN IMMEDIATE` wrapper (the
 * `scheduledOccurrenceReservation` precedent — deliberately NOT drizzle's
 * deferred `db.transaction`, so overlapping admissions serialize at lock
 * acquisition rather than at first write). When the caller supplies a client
 * it MUST already hold the writer reservation (e.g., the Release
 * transaction); no nested BEGIN is opened.
 */
function withInboxTransaction<T>(
  client: AutomationDbClient | undefined,
  fn: (db: AutomationDbClient) => T,
): T {
  if (client) return fn(client);
  const db = getDb();
  db.run(sql`BEGIN IMMEDIATE`);
  try {
    const result = fn(db);
    db.run(sql`COMMIT`);
    return result;
  } catch (err) {
    try {
      db.run(sql`ROLLBACK`);
    } catch {
      // already rolled back
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Admission — the API surface the Release detection (next ticket) calls
// ---------------------------------------------------------------------------

export interface AdmitReleaseShippedInput {
  habitatId: string;
  /** Stable producer-supplied event identity (unique per Release). */
  eventId: string;
  payload: Record<string, unknown>;
  now?: string;
}

export type AdmitReleaseShippedResult =
  | { outcome: "admitted"; inboxId: string; deliveries: number }
  | { outcome: "replayed"; inboxId: string; deliveries: number };

/**
 * Freeze the Release event + its matched executable revisions in ONE
 * transaction. Idempotent: the same `(event_type, event_id)` replays and
 * returns the EXISTING frozen state without re-matching rules (a later rule
 * edit cannot inject itself into an already-admitted event).
 */
export function admitReleaseShippedEventToInbox(
  input: AdmitReleaseShippedInput,
  client?: AutomationDbClient,
): AdmitReleaseShippedResult {
  const now = input.now ?? new Date().toISOString();

  return withInboxTransaction(client, (db) => {
    const { inbox, created: inboxCreated } = deliveryRepo.insertOrReadInboxEntry(
      {
        eventType: RELEASE_SHIPPED_EVENT_TYPE,
        eventId: input.eventId,
        habitatId: input.habitatId,
        payload: input.payload,
        now,
      },
      db,
    );
    if (!inboxCreated) {
      const deliveries = deliveryRepo.listDeliveriesForInbox(inbox.id, db);
      // A stranded pre-fix zero-delivery inbox (pending forever) reaches
      // terminal on replay too — idempotent.
      if (deliveries.length === 0) {
        deliveryRepo.markInboxTerminalIfComplete(inbox.id, now, db);
      }
      return { outcome: "replayed", inboxId: inbox.id, deliveries: deliveries.length };
    }

    // Match the enabled rules for this trigger NOW; freeze the FULL revision
    // each matched rule currently resolves to (backfilling legacy rules that
    // predate the revision feature from their live state, in this tx).
    const rules = ruleRepo.getEnabledRulesByHabitatAndTrigger(
      input.habitatId,
      RELEASE_SHIPPED_EVENT_TYPE,
    );
    let deliveries = 0;
    for (const rule of rules) {
      let revision: AutomationRuleRevision | null = revisionRepo.getLatestRuleRevision(rule.id, db);
      if (!revision) {
        revision = revisionRepo.createRuleRevision(
          rule,
          { type: "system", id: "inbox_admission_backfill" },
          db,
        );
      }
      deliveryRepo.createDelivery(
        {
          inboxId: inbox.id,
          ruleRevisionId: revision.id,
          ruleId: rule.id,
          habitatId: input.habitatId,
          eventDedupeKey: `${RELEASE_SHIPPED_EVENT_TYPE}:${input.eventId}`,
          generation: 1,
          now,
        },
        db,
      );
      deliveries++;
    }
    // Zero matching rules → nothing to consume. Terminalize the inbox IN the
    // admission transaction (FU2): otherwise it would stay `pending` forever
    // (the drainer enumerates delivery ids and finds none).
    if (deliveries === 0) {
      deliveryRepo.markInboxTerminalIfComplete(inbox.id, now, db);
    }
    return { outcome: "admitted", inboxId: inbox.id, deliveries };
  });
}

// ---------------------------------------------------------------------------
// Consumer — lease/fence + canonical lifecycle dispatch
// ---------------------------------------------------------------------------

export interface DrainAutomationInboxOptions {
  now?: string;
  leaseTtlMs?: number;
  limit?: number;
  leaseOwner?: string;
}

export interface DrainAutomationInboxReport {
  considered: number;
  leased: number;
  outcomes: Record<string, number>;
  errors: string[];
}

/**
 * Proof classification of a stale-leased delivery against its frozen
 * revision's ordered actions. `resume` requires every UNPROVED action to
 * declare an end-to-end idempotency contract; proved actions are skipped by
 * the lifecycle regardless.
 *
 * `checkpoints` MUST be the state observed under the recovery reservation
 * (re-checked inside the `BEGIN IMMEDIATE`), so a checkpoint proved
 * concurrently cannot silently flip the classification underneath the
 * attention write.
 */
function classifyStaleDelivery(
  delivery: AutomationRuleDeliveryRow,
  revision: AutomationRuleRevision,
  checkpoints: deliveryRepo.AutomationActionCheckpointRow[],
): { resume: true } | { resume: false; reason: string } {
  const proved = new Set(checkpoints.filter((c) => c.state === "proved").map((c) => c.actionIndex));
  const actions = (revision.actions ?? []) as Array<Record<string, unknown>>;
  for (let i = 0; i < actions.length; i++) {
    if (proved.has(i)) continue;
    const actionType = String(actions[i].type ?? "unknown");
    if (!RESUME_SAFE_ACTION_TYPES.has(actionType)) {
      return {
        resume: false,
        reason:
          `action ${i} (${actionType}) has no proved checkpoint and declares no ` +
          `end-to-end idempotency contract — completion cannot be proved, delivery ` +
          `requires operator disposition`,
      };
    }
  }
  return { resume: true };
}

/**
 * Stale-lease recovery under ONE `BEGIN IMMEDIATE` reservation (FU2). The
 * whole classify + (re-lease | mark-attention) decision is a single atomic
 * unit, closing the TOCTOU where the old worker's `recordCheckpointOutcome`
 * (which checks only the lease fence, not expiry) could land between the
 * recovery's checkpoint read and its attention write:
 *
 *   - re-reads the delivery and its checkpoints INSIDE the reservation (a
 *     concurrently-proved checkpoint is either already visible → resume, or
 *     blocked until this reservation commits → its later write is rejected by
 *     the now-cleared fence);
 *   - the attention CAS is bound to the OBSERVED fence, so a delivery
 *     re-leased under a newer fence can never be yanked to attention by a
 *     stale observation.
 *
 * `revision` is the immutable frozen revision the caller already resolved.
 */
function recoverStaleDelivery(input: {
  deliveryId: string;
  revision: AutomationRuleRevision;
  leaseOwner: string;
  now: string;
  ttlMs: number;
}):
  | { kind: "attention" }
  | { kind: "lost" }
  | { kind: "resume"; lease: { delivery: AutomationRuleDeliveryRow; fence: string } } {
  return withInboxTransaction(undefined, (db) => {
    // Consistent snapshot under the reservation.
    const delivery = deliveryRepo.getDeliveryById(input.deliveryId, db);
    if (!delivery) return { kind: "lost" };
    // Re-validate drainability/staleness: a concurrently re-leased (live) or
    // terminalized delivery is not ours to classify.
    if (
      delivery.state !== "leased" ||
      delivery.leaseExpiresAt === null ||
      delivery.leaseExpiresAt > input.now
    ) {
      return { kind: "lost" };
    }
    const observedFence = delivery.leaseFence;
    if (observedFence === null) return { kind: "lost" };

    // Re-read checkpoint state under the reservation — the classification
    // input is the committed-at-reservation view, not a stale pre-read.
    const checkpoints = deliveryRepo.listCheckpointsForDelivery(delivery.id, db);
    const classification = classifyStaleDelivery(delivery, input.revision, checkpoints);

    if (!classification.resume) {
      const marked = deliveryRepo.markStaleDeliveryAttention(
        {
          deliveryId: delivery.id,
          fence: observedFence,
          now: input.now,
          reason: classification.reason,
          proofClassification: "unprovable",
        },
        db,
      );
      return marked ? { kind: "attention" } : { kind: "lost" };
    }

    // Resume-safe: re-lease under a NEW fence (superseding the stale worker's
    // fence) inside the same reservation.
    const lease = deliveryRepo.leaseDelivery(
      {
        deliveryId: delivery.id,
        leaseOwner: input.leaseOwner,
        now: input.now,
        ttlMs: input.ttlMs,
      },
      db,
    );
    if (!lease.acquired) return { kind: "lost" };
    return { kind: "resume", lease: { delivery: lease.delivery, fence: lease.fence } };
  });
}

/** Rebuild the normalized trigger from the FROZEN payload at consumption time. */
function rebuildTrigger(inbox: AutomationEventInboxRow) {
  const payload = inbox.payload ?? {};
  const payloadEventId = typeof payload.eventId === "string" ? payload.eventId : "";
  const normalized = normalizeEventTrigger(inbox.habitatId, {
    type: inbox.eventType,
    data: {
      ...payload,
      eventId: payloadEventId.length > 0 ? payloadEventId : inbox.eventId,
    },
  });
  if (!normalized) return null;
  return {
    triggerType: normalized.triggerType,
    triggerEventId: normalized.triggerEventId,
    targetType: normalized.targetType,
    targetId: normalized.targetId,
    payload: inbox.payload,
  };
}

/**
 * One consumer pass over the inbox. Terminal deliveries complete the picture
 * (nothing to do); a non-terminal generation with a LIVE lease remains
 * pending; an EXPIRED lease is classified before any action.
 */
export async function drainAutomationInbox(
  options?: DrainAutomationInboxOptions,
): Promise<DrainAutomationInboxReport> {
  const now = options?.now ?? new Date().toISOString();
  const ttlMs = options?.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const limit = options?.limit ?? 50;
  const leaseOwner = options?.leaseOwner ?? `drain:${uuid()}`;

  const report: DrainAutomationInboxReport = {
    considered: 0,
    leased: 0,
    outcomes: {},
    errors: [],
  };
  const count = (kind: string): void => {
    report.outcomes[kind] = (report.outcomes[kind] ?? 0) + 1;
  };

  // Reconciliation sweep (FU2): pending inboxes stranded with ZERO deliveries
  // (a zero-match admission from before the in-transaction terminalization,
  // or an empty event-type match) reach `terminal` so they stop pending
  // forever. The sweep's reads/writes are separate atomic statements, so a
  // concurrent admission (one tx) never exposes a partially-admitted inbox to
  // the sweep.
  for (const inboxId of deliveryRepo.listPendingZeroDeliveryInboxIds()) {
    deliveryRepo.markInboxTerminalIfComplete(inboxId, now);
  }

  const ids = deliveryRepo.listDrainableDeliveryIds(now, limit);
  for (const id of ids) {
    report.considered++;
    const delivery = deliveryRepo.getDeliveryById(id);
    if (!delivery) continue;

    let leased: AutomationRuleDeliveryRow;
    let fence: string;
    let resumeAfterReservation = false;

    // Stale lease: classify + (re-lease | mark attention) under ONE
    // `BEGIN IMMEDIATE` reservation (FU2 TOCTOU fix).
    if (delivery.state === "leased") {
      const revision = revisionRepo.getRuleRevisionById(delivery.ruleRevisionId);
      if (!revision) {
        report.errors.push(`Delivery ${id}: revision ${delivery.ruleRevisionId} is missing`);
        continue;
      }
      const recovery = recoverStaleDelivery({
        deliveryId: delivery.id,
        revision,
        leaseOwner,
        now,
        ttlMs,
      });
      if (recovery.kind === "attention") {
        count("attention_required");
        continue;
      }
      if (recovery.kind === "lost") {
        count("lost_lease");
        continue;
      }
      count("stale_resume");
      // The reservation re-leased under a NEW fence; the stale worker's fence
      // is superseded and can no longer terminalize or forge proof.
      leased = recovery.lease.delivery;
      fence = recovery.lease.fence;
      resumeAfterReservation = true;
    } else {
      const lease = deliveryRepo.leaseDelivery({
        deliveryId: delivery.id,
        leaseOwner,
        now,
        ttlMs,
      });
      if (!lease.acquired) {
        count("lost_lease");
        continue;
      }
      leased = lease.delivery;
      fence = lease.fence;
    }
    report.leased++;

    const revision = revisionRepo.getRuleRevisionById(leased.ruleRevisionId);
    const inbox = deliveryRepo.getInboxById(leased.inboxId);
    if (!revision || !inbox) {
      report.errors.push(
        `Delivery ${leased.id}: ${!revision ? "revision" : "inbox"} row is missing`,
      );
      continue;
    }

    const trigger = rebuildTrigger(inbox);
    if (!trigger) {
      // Unresolvable frozen payload — durable skip, never a silent drop. The
      // delivery transition + inbox terminality are one atomic unit.
      const skipped = withInboxTransaction(undefined, (db) => {
        const transitioned = deliveryRepo.transitionLeasedDelivery(
          {
            deliveryId: leased.id,
            fence,
            targetState: "terminal",
            terminalDisposition: "skipped:unresolvable_event",
            terminalDetail: `payload could not be normalized for ${inbox.eventType}`,
            now,
          },
          db,
        );
        if (transitioned) deliveryRepo.markInboxTerminalIfComplete(inbox.id, now, db);
        return transitioned;
      });
      count(skipped ? "skipped" : "fenced_out");
      continue;
    }

    try {
      const disposition: AutomationFrozenAttemptDisposition = await attemptRuleRun({
        rule: revisionRepo.materializeRuleFromRevision(revision),
        source: "event" as AutomationAttemptSource,
        trigger: {
          triggerType: trigger.triggerType,
          triggerEventId: trigger.triggerEventId,
          habitatId: leased.habitatId,
          targetType: trigger.targetType,
          targetId: trigger.targetId,
          payload: trigger.payload,
        },
        eventDedupeKey: leased.eventDedupeKey,
        now,
        frozen: {
          delivery: {
            id: leased.id,
            generation: leased.generation,
            fence,
            eventDedupeKey: leased.eventDedupeKey,
          },
          inbox: { id: inbox.id, eventType: inbox.eventType, eventId: inbox.eventId },
          revision,
          resumeAfterReservation,
        },
      });
      count(disposition.kind === "executed" ? `executed:${disposition.outcome}` : disposition.kind);
    } catch (err) {
      report.errors.push(
        `Delivery ${leased.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Deliver any durable completion outbox rows produced by this pass (or
  // earlier crashed passes). Best-effort: the outbox rows stay undelivered
  // and the next drain/boot retries them.
  deliverAutomationCompletionOutbox({ now });

  return report;
}

// ---------------------------------------------------------------------------
// Durable completion outbox delivery (FU2)
// ---------------------------------------------------------------------------

export interface DeliverCompletionOutboxOptions {
  now?: string;
  limit?: number;
}

/**
 * Deliver pending durable automation-run completion rows. Each row was
 * persisted in the crash-atomic terminal bundle; delivering here (at the end
 * of every drain, which covers boot + interval + eager passes) fires the
 * in-process `notifyAutomationRunCompleted` subscriber hooks at least once
 * and marks the row delivered. A crash mid-delivery leaves the row
 * undelivered and the next drain retries it; consumers must be CAS-idempotent
 * (the workflow-gate consumer CASes on satisfied), so a retried delivery
 * converges.
 *
 * Rows whose run row is gone (live rule deleted after terminalization) are
 * marked delivered-with-error — there is nothing left to notify.
 */
export function deliverAutomationCompletionOutbox(
  options?: DeliverCompletionOutboxOptions,
): number {
  const now = options?.now ?? new Date().toISOString();
  const rows = outboxRepo.listUndeliveredCompletions({ limit: options?.limit ?? 50 });
  let delivered = 0;
  for (const row of rows) {
    const run = runRepo.getRuleRunById(row.runId);
    if (!run) {
      outboxRepo.markCompletionDeliveryError(row.id, "run row missing (rule deleted)", now);
      continue;
    }
    // The completion hooks only need stable identity (`rule.id`, `run`'s
    // target fields); the live rule may have been edited or deleted since the
    // run terminalized, so fall back to the run row's own lineage.
    const rule: AutomationRule =
      ruleRepo.getAutomationRuleById(row.ruleId) ?? ({ id: row.ruleId } as AutomationRule);
    notifyAutomationRunCompleted({
      run,
      rule,
      outcome: row.outcome as AutomationRunStatus,
      habitatId: row.habitatId,
    });
    if (outboxRepo.markCompletionDelivered(row.id, now)) delivered++;
  }
  return delivered;
}

// ---------------------------------------------------------------------------
// Operator dispositions
// ---------------------------------------------------------------------------

export interface WaiveDeliveryInput {
  deliveryId: string;
  actorType: string;
  actorId: string;
  reason: string;
  now?: string;
}

export type WaiveDeliveryResult =
  | { outcome: "waived"; delivery: AutomationRuleDeliveryRow }
  | { outcome: "not_found" }
  | { outcome: "conflict"; state: string };

/** Operator waive AFTER external reconciliation. Audited; immutable history. */
export function waiveAutomationDelivery(input: WaiveDeliveryInput): WaiveDeliveryResult {
  const now = input.now ?? new Date().toISOString();
  return withInboxTransaction(undefined, (db) => {
    void db;
    const delivery = deliveryRepo.getDeliveryById(input.deliveryId);
    if (!delivery) return { outcome: "not_found" };
    const updated = deliveryRepo.waiveDelivery({ deliveryId: input.deliveryId, now });
    if (!updated) return { outcome: "conflict", state: delivery.state };
    deliveryRepo.recordDeliveryDisposition({
      deliveryId: input.deliveryId,
      inboxId: delivery.inboxId,
      kind: "waive",
      actorType: input.actorType,
      actorId: input.actorId,
      reason: input.reason,
      outcome: "waived",
      now,
    });
    deliveryRepo.markInboxTerminalIfComplete(delivery.inboxId, now);
    return { outcome: "waived", delivery: updated };
  });
}

export interface SuccessorDeliveryInput {
  deliveryId: string;
  actorType: string;
  actorId: string;
  reason: string;
  /** MUST be true — the caller acknowledges the duplicate-effect risk of re-executing unproved actions. */
  ackDuplicateRisk: boolean;
  now?: string;
}

export type SuccessorDeliveryResult =
  | { outcome: "created"; deliveryId: string; generation: number }
  | { outcome: "not_found" }
  | { outcome: "risk_ack_required" }
  | { outcome: "conflict"; state: string };

/**
 * Explicit audited successor attempt generation for the UNRESOLVED action set
 * only: proved checkpoints are carried forward (never rerun); pending/failed
 * actions re-execute in the new generation. The predecessor generation and
 * its proved receipts stay immutable.
 */
export function createAutomationDeliverySuccessorGeneration(
  input: SuccessorDeliveryInput,
): SuccessorDeliveryResult {
  const now = input.now ?? new Date().toISOString();
  if (!input.ackDuplicateRisk) return { outcome: "risk_ack_required" };

  return withInboxTransaction(undefined, (db) => {
    const delivery = deliveryRepo.getDeliveryById(input.deliveryId);
    if (!delivery) return { outcome: "not_found" };
    if (delivery.state !== "attention_required") {
      return { outcome: "conflict", state: delivery.state };
    }
    // Only the LATEST generation may branch — a stale worker (or operator
    // acting on a superseded row) cannot create parallel successors.
    const latest = deliveryRepo.listLatestGenerationSuccessorDelivery(
      delivery.eventDedupeKey,
      delivery.ruleRevisionId,
    );
    if (!latest || latest.id !== delivery.id) {
      return { outcome: "conflict", state: latest ? `generation_${latest.generation}` : "unknown" };
    }

    const created = deliveryRepo.createDelivery(
      {
        inboxId: delivery.inboxId,
        ruleRevisionId: delivery.ruleRevisionId,
        ruleId: delivery.ruleId,
        habitatId: delivery.habitatId,
        eventDedupeKey: delivery.eventDedupeKey,
        generation: delivery.generation + 1,
        predecessorDeliveryId: delivery.id,
        retryReason: input.reason,
        retryCount: delivery.retryCount + 1,
        now,
      },
      db,
    );
    if (!created.created) {
      return { outcome: "conflict", state: `generation_${created.delivery.generation}_exists` };
    }
    deliveryRepo.carryForwardProvedCheckpoints({
      predecessorDeliveryId: delivery.id,
      successorDeliveryId: created.delivery.id,
      now,
    });
    // The predecessor's attention is resolved by branching: state moves to
    // terminal/superseded (checkpoints + receipts immutable) so inbox
    // terminality reflects the successor owning the unresolved work.
    deliveryRepo.markDeliverySuperseded(delivery.id, now);
    deliveryRepo.recordDeliveryDisposition({
      deliveryId: delivery.id,
      inboxId: delivery.inboxId,
      kind: "successor_generation",
      actorType: input.actorType,
      actorId: input.actorId,
      reason: input.reason,
      outcome: `successor_generation_${delivery.generation + 1}`,
      now,
    });
    return {
      outcome: "created",
      deliveryId: created.delivery.id,
      generation: created.delivery.generation,
    };
  });
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

export interface InboxDeliveryView {
  delivery: AutomationRuleDeliveryRow;
  checkpoints: deliveryRepo.AutomationActionCheckpointRow[];
  dispositions: Array<{
    id: string;
    kind: string;
    actorType: string;
    actorId: string;
    reason: string;
    outcome: string;
    createdAt: string;
  }>;
}

export interface InboxOverview {
  inbox: AutomationEventInboxRow;
  deliveries: InboxDeliveryView[];
}

/** Inbox + delivery visibility surface (attention_required must be visible). */
export function getInboxOverview(inboxId: string): InboxOverview | null {
  const inbox = deliveryRepo.getInboxById(inboxId);
  if (!inbox) return null;
  const deliveries = deliveryRepo.listDeliveriesForInbox(inboxId).map((delivery) => ({
    delivery,
    checkpoints: deliveryRepo.listCheckpointsForDelivery(delivery.id),
    dispositions: deliveryRepo.listDispositionsForDelivery(delivery.id),
  }));
  return { inbox, deliveries };
}

/** List inbox entries for a habitat with per-delivery attention visibility. */
export function listHabitatInbox(habitatId: string): InboxOverview[] {
  return deliveryRepo
    .listInboxEntriesForHabitat(habitatId)
    .map((inbox) => getInboxOverview(inbox.id))
    .filter((o): o is InboxOverview => o !== null);
}

// Re-exported for consumers/tests that need the frozen-revision materializer.
export { materializeRuleFromRevision } from "../repositories/automationRuleRevision.js";
export type { AutomationAction };
