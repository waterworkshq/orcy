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
import {
  attemptRuleRun,
  type AutomationFrozenAttemptDisposition,
  type AutomationAttemptSource,
} from "./automationAttemptLifecycle.js";
import type { AutomationAction } from "@orcy/shared";

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
      const deliveries = deliveryRepo.listDeliveriesForInbox(inbox.id);
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
 */
function classifyStaleDelivery(
  delivery: AutomationRuleDeliveryRow,
  revision: AutomationRuleRevision,
): { resume: true } | { resume: false; reason: string } {
  const checkpoints = deliveryRepo.listCheckpointsForDelivery(delivery.id);
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

/** Rebuild the normalized trigger from the FROZEN payload at consumption time. */
function rebuildTrigger(inbox: AutomationEventInboxRow) {
  const normalized = normalizeEventTrigger(inbox.habitatId, {
    type: inbox.eventType,
    data: inbox.payload,
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

  const ids = deliveryRepo.listDrainableDeliveryIds(now, limit);
  for (const id of ids) {
    report.considered++;
    const delivery = deliveryRepo.getDeliveryById(id);
    if (!delivery) continue;

    // Stale lease: classify each ordered action checkpoint BEFORE acting.
    if (delivery.state === "leased") {
      const revision = revisionRepo.getRuleRevisionById(delivery.ruleRevisionId);
      if (!revision) {
        report.errors.push(`Delivery ${id}: revision ${delivery.ruleRevisionId} is missing`);
        continue;
      }
      const classification = classifyStaleDelivery(delivery, revision);
      if (!classification.resume) {
        const marked = deliveryRepo.markStaleDeliveryAttention({
          deliveryId: delivery.id,
          now,
          reason: classification.reason,
          proofClassification: "unprovable",
        });
        count(marked ? "attention_required" : "lost_lease");
        continue;
      }
      count("stale_resume");
      // fall through: leaseDelivery re-leases under a NEW fence; the stale
      // worker's fence is superseded and can no longer terminalize.
    }

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
    report.leased++;
    const leased = lease.delivery;

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
      // Unresolvable frozen payload — durable skip, never a silent drop.
      const skipped = deliveryRepo.transitionLeasedDelivery({
        deliveryId: leased.id,
        fence: lease.fence,
        targetState: "terminal",
        terminalDisposition: "skipped:unresolvable_event",
        terminalDetail: `payload could not be normalized for ${inbox.eventType}`,
        now,
      });
      if (skipped) deliveryRepo.markInboxTerminalIfComplete(inbox.id, now);
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
            fence: lease.fence,
            eventDedupeKey: leased.eventDedupeKey,
          },
          inbox: { id: inbox.id, eventType: inbox.eventType, eventId: inbox.eventId },
          revision,
        },
      });
      count(disposition.kind === "executed" ? `executed:${disposition.outcome}` : disposition.kind);
    } catch (err) {
      report.errors.push(
        `Delivery ${leased.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return report;
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
