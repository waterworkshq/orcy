/**
 * Automation inbox + per-rule-generation deliveries + ordered action
 * checkpoints + operator disposition ledger.
 *
 * Concurrency model (mirrors the `terminalizeRuleRun` CAS precedent so
 * cross-backend write-count detection works on both better-sqlite3 and sql.js):
 *
 * - **Lease acquisition** is a compare-and-set
 *   `UPDATE ... SET lease_* WHERE id = ? AND (state = 'pending' OR
 *   (state = 'leased' AND lease_expires_at <= now))`. Exactly one competing
 *   worker wins; losers see `acquired: false`.
 * - **Delivery terminalization / attention** is a compare-and-set on the
 *   lease fence: `... WHERE id = ? AND lease_fence = ? AND state = 'leased'`.
 *   A stale worker holding a superseded fence can NEVER terminalize work
 *   owned by a newer lease or successor generation.
 * - **Checkpoint writes** are keyed `(delivery_id, action_index)` with
 *   `proved` transitions gated on the delivery still carrying this fence, so
 *   a stale worker cannot forge proof into a successor generation.
 */
import { eq, and, or, lte, sql, asc } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";
import {
  automationEventInbox,
  automationRuleDeliveries,
  automationDeliveryActionCheckpoints,
  automationDeliveryDispositions,
} from "../db/schema/index.js";
import { repositoryNotFoundError } from "../errors/repository.js";
import { canonicalJson, type AutomationDbClient } from "./automationRuleRevision.js";

export type AutomationDeliveryState =
  | "pending"
  | "leased"
  | "terminal"
  | "attention_required"
  | "waived";

export interface AutomationEventInboxRow {
  id: string;
  eventType: string;
  eventId: string;
  habitatId: string;
  payload: Record<string, unknown>;
  state: "pending" | "terminal";
  admittedAt: string;
  terminalAt: string | null;
}

export interface AutomationRuleDeliveryRow {
  id: string;
  inboxId: string;
  ruleRevisionId: string;
  ruleId: string;
  habitatId: string;
  eventDedupeKey: string;
  generation: number;
  predecessorDeliveryId: string | null;
  retryReason: string | null;
  state: AutomationDeliveryState;
  leaseOwner: string | null;
  leaseFence: string | null;
  leaseExpiresAt: string | null;
  automationRunId: string | null;
  proofClassification: string | null;
  retryCount: number;
  terminalDisposition: string | null;
  terminalDetail: string | null;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

export interface AutomationActionCheckpointRow {
  id: string;
  deliveryId: string;
  actionIndex: number;
  actionKey: string;
  actionType: string;
  idempotencyKey: string | null;
  state: "pending" | "proved" | "failed";
  receipt: Record<string, unknown> | null;
  terminalDisposition: string | null;
  predecessorCheckpointId: string | null;
  createdAt: string;
  updatedAt: string;
  provedAt: string | null;
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export interface AdmitInboxInput {
  eventType: string;
  eventId: string;
  habitatId: string;
  payload: Record<string, unknown>;
  now: string;
}

/**
 * Insert-or-read the unique `(event_type, event_id)` inbox entry. The payload
 * is frozen at first admission and never rewritten — a replay returns the
 * EXISTING row (its frozen payload wins over any locally supplied one).
 */
export function insertOrReadInboxEntry(
  input: AdmitInboxInput,
  client?: AutomationDbClient,
): { inbox: AutomationEventInboxRow; created: boolean } {
  const db = client ?? getDb();
  const existing = db
    .select()
    .from(automationEventInbox)
    .where(
      and(
        eq(automationEventInbox.eventType, input.eventType),
        eq(automationEventInbox.eventId, input.eventId),
      ),
    )
    .get();
  if (existing) {
    return { inbox: existing as unknown as AutomationEventInboxRow, created: false };
  }

  const id = uuid();
  db.insert(automationEventInbox)
    .values({
      id,
      eventType: input.eventType,
      eventId: input.eventId,
      habitatId: input.habitatId,
      payload: input.payload,
      state: "pending",
      admittedAt: input.now,
      terminalAt: null,
    })
    .run();

  const created = getInboxById(id, db);
  if (!created) throw repositoryNotFoundError("automationEventInbox", id);
  return { inbox: created, created: true };
}

export function getInboxById(
  id: string,
  client?: AutomationDbClient,
): AutomationEventInboxRow | null {
  const db = client ?? getDb();
  const row = db.select().from(automationEventInbox).where(eq(automationEventInbox.id, id)).get();
  return row ? (row as unknown as AutomationEventInboxRow) : null;
}

export function listInboxEntriesForHabitat(
  habitatId: string,
  options?: { state?: "pending" | "terminal" },
): AutomationEventInboxRow[] {
  const db = getDb();
  const conditions = [eq(automationEventInbox.habitatId, habitatId)];
  if (options?.state) conditions.push(eq(automationEventInbox.state, options.state));
  return db
    .select()
    .from(automationEventInbox)
    .where(and(...conditions))
    .orderBy(sql`${automationEventInbox.admittedAt} DESC`)
    .limit(100)
    .all() as unknown as AutomationEventInboxRow[];
}

/**
 * Flip the inbox entry to `terminal` iff every delivery for it is terminal or
 * waived. `attention_required` keeps the inbox pending — it is visible and is
 * NOT success. Idempotent (guarded by `state = 'pending'`).
 */
export function markInboxTerminalIfComplete(
  inboxId: string,
  now: string,
  client?: AutomationDbClient,
): boolean {
  const db = client ?? getDb();
  const result = db.run(sql`
    UPDATE automation_event_inbox
    SET state = 'terminal', terminal_at = ${now}
    WHERE id = ${inboxId}
      AND state = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM automation_rule_deliveries
        WHERE inbox_id = ${inboxId}
          AND state NOT IN ('terminal', 'waived')
      )
  `);
  const changes = (result as { changes?: number } | undefined)?.changes;
  if (typeof changes === "number") return changes === 1;
  // sql.js / mocks: post-update probe
  const row = db
    .select({ state: automationEventInbox.state, terminalAt: automationEventInbox.terminalAt })
    .from(automationEventInbox)
    .where(eq(automationEventInbox.id, inboxId))
    .get();
  return row != null && row.state === "terminal" && row.terminalAt === now;
}

/**
 * Inboxes stranded as `pending` with ZERO deliveries (a zero-match admission
 * from before the in-transaction terminalization, or an empty
 * event-type match). The drain pass sweeps these so they reach `terminal`.
 */
export function listPendingZeroDeliveryInboxIds(client?: AutomationDbClient): string[] {
  const db = client ?? getDb();
  const rows = db
    .select({ id: automationEventInbox.id })
    .from(automationEventInbox)
    .where(
      and(
        eq(automationEventInbox.state, "pending"),
        sql`NOT EXISTS (
          SELECT 1 FROM automation_rule_deliveries
          WHERE inbox_id = ${automationEventInbox.id}
        )`,
      ),
    )
    .all();
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

export interface CreateDeliveryInput {
  inboxId: string;
  ruleRevisionId: string;
  ruleId: string;
  habitatId: string;
  eventDedupeKey: string;
  generation: number;
  predecessorDeliveryId?: string | null;
  retryReason?: string | null;
  retryCount?: number;
  now: string;
}

/**
 * Create one `(event_dedupe_key, rule_revision_id, generation)` delivery.
 * Returns `created: false` when the generation identity already exists
 * (idempotent admission replay) — the existing row is returned untouched.
 */
export function createDelivery(
  input: CreateDeliveryInput,
  client?: AutomationDbClient,
): { delivery: AutomationRuleDeliveryRow; created: boolean } {
  const db = client ?? getDb();

  const existing = db
    .select()
    .from(automationRuleDeliveries)
    .where(
      and(
        eq(automationRuleDeliveries.eventDedupeKey, input.eventDedupeKey),
        eq(automationRuleDeliveries.ruleRevisionId, input.ruleRevisionId),
        eq(automationRuleDeliveries.generation, input.generation),
      ),
    )
    .get();
  if (existing) {
    return { delivery: existing as unknown as AutomationRuleDeliveryRow, created: false };
  }

  const id = uuid();
  db.insert(automationRuleDeliveries)
    .values({
      id,
      inboxId: input.inboxId,
      ruleRevisionId: input.ruleRevisionId,
      ruleId: input.ruleId,
      habitatId: input.habitatId,
      eventDedupeKey: input.eventDedupeKey,
      generation: input.generation,
      predecessorDeliveryId: input.predecessorDeliveryId ?? null,
      retryReason: input.retryReason ?? null,
      state: "pending",
      leaseOwner: null,
      leaseFence: null,
      leaseExpiresAt: null,
      automationRunId: null,
      proofClassification: null,
      retryCount: input.retryCount ?? 0,
      terminalDisposition: null,
      terminalDetail: null,
      createdAt: input.now,
      updatedAt: input.now,
      terminalAt: null,
    })
    .run();

  const created = getDeliveryById(id, db);
  if (!created) throw repositoryNotFoundError("automationRuleDelivery", id);
  return { delivery: created, created: true };
}

export function getDeliveryById(
  id: string,
  client?: AutomationDbClient,
): AutomationRuleDeliveryRow | null {
  const db = client ?? getDb();
  const row = db
    .select()
    .from(automationRuleDeliveries)
    .where(eq(automationRuleDeliveries.id, id))
    .get();
  return row ? (row as unknown as AutomationRuleDeliveryRow) : null;
}

export function listDeliveriesForInbox(
  inboxId: string,
  client?: AutomationDbClient,
): AutomationRuleDeliveryRow[] {
  const db = client ?? getDb();
  return db
    .select()
    .from(automationRuleDeliveries)
    .where(eq(automationRuleDeliveries.inboxId, inboxId))
    .orderBy(asc(automationRuleDeliveries.createdAt))
    .all() as unknown as AutomationRuleDeliveryRow[];
}

export function listLatestGenerationSuccessorDelivery(
  eventDedupeKey: string,
  ruleRevisionId: string,
): AutomationRuleDeliveryRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(automationRuleDeliveries)
    .where(
      and(
        eq(automationRuleDeliveries.eventDedupeKey, eventDedupeKey),
        eq(automationRuleDeliveries.ruleRevisionId, ruleRevisionId),
      ),
    )
    .orderBy(sql`${automationRuleDeliveries.generation} DESC`)
    .limit(1)
    .get();
  return row ? (row as unknown as AutomationRuleDeliveryRow) : null;
}

/**
 * Drainable deliveries: `pending`, or `leased` with an EXPIRED lease (stale).
 * A delivery whose lease is live remains pending from the drainer's
 * perspective — it is NOT drainable and NOT stale.
 */
export function listDrainableDeliveryIds(now: string, limit: number): string[] {
  const db = getDb();
  const rows = db
    .select({ id: automationRuleDeliveries.id })
    .from(automationRuleDeliveries)
    .where(
      or(
        eq(automationRuleDeliveries.state, "pending"),
        and(
          eq(automationRuleDeliveries.state, "leased"),
          lte(automationRuleDeliveries.leaseExpiresAt, now),
        ),
      ),
    )
    .orderBy(asc(automationRuleDeliveries.createdAt))
    .limit(limit)
    .all();
  return rows.map((r) => r.id);
}

/**
 * Lease acquisition CAS. One winner per delivery per lease epoch:
 *   - `pending` → leased (first lease, or re-lease after terminal states
 *     never reach here — terminal/attention/waived rows are excluded);
 *   - `leased` with expired lease → re-leased under a NEW fence (the stale
 *     worker's fence is superseded and can no longer terminalize).
 * Returns `acquired: false` when a live lease or a concurrent winner holds it.
 */
export function leaseDelivery(
  input: {
    deliveryId: string;
    leaseOwner: string;
    now: string;
    ttlMs: number;
  },
  client?: AutomationDbClient,
): { delivery: AutomationRuleDeliveryRow; acquired: boolean; fence: string } {
  const db = client ?? getDb();
  const fence = uuid();
  const expiresAt = new Date(new Date(input.now).getTime() + input.ttlMs).toISOString();

  const result = db.run(sql`
    UPDATE automation_rule_deliveries
    SET state = 'leased',
        lease_owner = ${input.leaseOwner},
        lease_fence = ${fence},
        lease_expires_at = ${expiresAt},
        updated_at = ${input.now}
    WHERE id = ${input.deliveryId}
      AND (
        state = 'pending'
        OR (state = 'leased' AND lease_expires_at <= ${input.now})
      )
  `);
  const changes = (result as { changes?: number } | undefined)?.changes;
  let acquired: boolean;
  if (typeof changes === "number") {
    acquired = changes === 1;
  } else {
    const probe = db
      .select({ fence: automationRuleDeliveries.leaseFence })
      .from(automationRuleDeliveries)
      .where(eq(automationRuleDeliveries.id, input.deliveryId))
      .get();
    acquired = probe != null && probe.fence === fence;
  }

  const delivery = getDeliveryById(input.deliveryId);
  if (!delivery) throw repositoryNotFoundError("automationRuleDelivery", input.deliveryId);
  return { delivery, acquired, fence };
}

/**
 * Fenced state transition for a LEASED delivery. The CAS requires BOTH the
 * current fence AND `state = 'leased'`, so:
 *   - a stale worker (superseded fence) cannot terminalize;
 *   - a second worker cannot double-terminalize;
 *   - terminal/waived/attention rows are immutable to this call.
 */
export function transitionLeasedDelivery(
  input: {
    deliveryId: string;
    fence: string;
    targetState: Extract<AutomationDeliveryState, "terminal" | "attention_required">;
    terminalDisposition?: string | null;
    terminalDetail?: string | null;
    proofClassification?: string | null;
    automationRunId?: string | null;
    now: string;
  },
  client?: AutomationDbClient,
): boolean {
  const db = client ?? getDb();
  const result = db.run(sql`
    UPDATE automation_rule_deliveries
    SET state = ${input.targetState},
        terminal_disposition = ${input.terminalDisposition ?? null},
        terminal_detail = ${input.terminalDetail ?? null},
        proof_classification = ${input.proofClassification ?? null},
        automation_run_id = COALESCE(${input.automationRunId ?? null}, automation_run_id),
        lease_owner = NULL,
        lease_fence = NULL,
        lease_expires_at = NULL,
        terminal_at = ${input.now},
        updated_at = ${input.now}
    WHERE id = ${input.deliveryId}
      AND lease_fence = ${input.fence}
      AND state = 'leased'
  `);
  const changes = (result as { changes?: number } | undefined)?.changes;
  if (typeof changes === "number") return changes === 1;
  // sql.js / mocks: post-update probe. A successful transition CLEARS the
  // lease (ownership revoked), so the probe verifies our write plus the
  // cleared fence; a stale worker's UPDATE matched zero rows and cannot have
  // produced this combination (its `now` differs from the winner's write).
  const probe = db
    .select({
      state: automationRuleDeliveries.state,
      updatedAt: automationRuleDeliveries.updatedAt,
      fence: automationRuleDeliveries.leaseFence,
    })
    .from(automationRuleDeliveries)
    .where(eq(automationRuleDeliveries.id, input.deliveryId))
    .get();
  return (
    probe != null &&
    probe.state === input.targetState &&
    probe.updatedAt === input.now &&
    probe.fence === null
  );
}

/**
 * Operator waive: `attention_required` → `waived`. Guarded IN the function on
 * source state (caller-side filtering is fragile). Returns false when the
 * delivery is not in `attention_required`.
 */
export function waiveDelivery(input: {
  deliveryId: string;
  now: string;
}): AutomationRuleDeliveryRow | null {
  const db = getDb();
  // Pre-check + post-verify (both required — see MEMORY's pre-check vs
  // in-transaction guard convention). The CAS itself guards
  // `state = 'attention_required'`; the post-verify compares our own
  // `updated_at` write so the sql.js no-changes path cannot mistake a prior
  // waive for this one.
  const before = getDeliveryById(input.deliveryId, db);
  if (!before || before.state !== "attention_required") return null;
  db.run(sql`
    UPDATE automation_rule_deliveries
    SET state = 'waived',
        terminal_disposition = COALESCE(terminal_disposition, 'waived'),
        terminal_at = ${input.now},
        updated_at = ${input.now}
    WHERE id = ${input.deliveryId}
      AND state = 'attention_required'
  `);
  const updated = getDeliveryById(input.deliveryId, db);
  if (!updated || updated.state !== "waived" || updated.updatedAt !== input.now) return null;
  return updated;
}

/**
 * Stale-lease attention transition (consumer-side proof-aware recovery).
 *
 * CAS is bound to the OBSERVED lease fence (not just `leased + expired`), so
 * a delivery that was re-leased under a NEWER fence (by a competing recovery
 * or by the OLD worker re-proving before classification committed) cannot be
 * yanked to `attention_required` by a stale observation. Callers MUST run
 * this under the recovery reservation (`BEGIN IMMEDIATE`) after re-reading
 * the checkpoint state, so a concurrently-proved checkpoint is either seen
 * (→ resume) or blocked until this commit clears the fence (→ the old
 * worker's later proof is rejected, never leaving attention with a proved
 * receipt).
 *
 * `attention_required` is visible and is NOT success — it never
 * auto-executes; only an audited operator waive or a risk-acknowledged
 * successor generation resolves it.
 */
export function markStaleDeliveryAttention(
  input: {
    deliveryId: string;
    /** The lease fence observed when the delivery was read. CAS is bound to it. */
    fence: string;
    now: string;
    reason: string;
    proofClassification: string;
  },
  client?: AutomationDbClient,
): boolean {
  const db = client ?? getDb();
  const result = db.run(sql`
    UPDATE automation_rule_deliveries
    SET state = 'attention_required',
        terminal_disposition = 'attention_required',
        terminal_detail = ${input.reason},
        proof_classification = ${input.proofClassification},
        lease_owner = NULL,
        lease_fence = NULL,
        lease_expires_at = NULL,
        terminal_at = ${input.now},
        updated_at = ${input.now}
    WHERE id = ${input.deliveryId}
      AND lease_fence = ${input.fence}
      AND state = 'leased'
      AND lease_expires_at <= ${input.now}
  `);
  const changes = (result as { changes?: number } | undefined)?.changes;
  if (typeof changes === "number") return changes === 1;
  const probe = db
    .select({
      state: automationRuleDeliveries.state,
      updatedAt: automationRuleDeliveries.updatedAt,
    })
    .from(automationRuleDeliveries)
    .where(eq(automationRuleDeliveries.id, input.deliveryId))
    .get();
  return probe != null && probe.state === "attention_required" && probe.updatedAt === input.now;
}

/**
 * Predecessor transition when an operator branches a successor generation:
 * `attention_required` → `terminal` with disposition `superseded`. The
 * predecessor's checkpoints/receipts stay immutable; only its state moves so
 * inbox terminality reflects that a successor now owns the unresolved work.
 */
export function markDeliverySuperseded(deliveryId: string, now: string): boolean {
  const db = getDb();
  const result = db.run(sql`
    UPDATE automation_rule_deliveries
    SET state = 'terminal',
        terminal_disposition = 'superseded',
        terminal_at = ${now},
        updated_at = ${now}
    WHERE id = ${deliveryId}
      AND state = 'attention_required'
  `);
  const changes = (result as { changes?: number } | undefined)?.changes;
  if (typeof changes === "number") return changes === 1;
  const probe = db
    .select({
      state: automationRuleDeliveries.state,
      updatedAt: automationRuleDeliveries.updatedAt,
      disposition: automationRuleDeliveries.terminalDisposition,
    })
    .from(automationRuleDeliveries)
    .where(eq(automationRuleDeliveries.id, deliveryId))
    .get();
  return (
    probe != null &&
    probe.state === "terminal" &&
    probe.disposition === "superseded" &&
    probe.updatedAt === now
  );
}

// ---------------------------------------------------------------------------
// Action checkpoints
// ---------------------------------------------------------------------------

/**
 * Stable action identity: canonical digest of the action definition, so a
 * reordered/edited action set (impossible within one immutable revision, but
 * possible across generations) never matches a proved checkpoint of a
 * DIFFERENT action by index alone.
 */
export function computeActionKey(action: Record<string, unknown>): string {
  return `v1:${canonicalJson(action)}`;
}

export function ensureCheckpointRow(input: {
  deliveryId: string;
  actionIndex: number;
  actionKey: string;
  actionType: string;
  now: string;
}): AutomationActionCheckpointRow {
  const db = getDb();
  const existing = db
    .select()
    .from(automationDeliveryActionCheckpoints)
    .where(
      and(
        eq(automationDeliveryActionCheckpoints.deliveryId, input.deliveryId),
        eq(automationDeliveryActionCheckpoints.actionIndex, input.actionIndex),
      ),
    )
    .get();
  if (existing) return existing as unknown as AutomationActionCheckpointRow;

  const id = uuid();
  db.insert(automationDeliveryActionCheckpoints)
    .values({
      id,
      deliveryId: input.deliveryId,
      actionIndex: input.actionIndex,
      actionKey: input.actionKey,
      actionType: input.actionType,
      idempotencyKey: null,
      state: "pending",
      receipt: null,
      terminalDisposition: null,
      predecessorCheckpointId: null,
      createdAt: input.now,
      updatedAt: input.now,
      provedAt: null,
    })
    .run();

  const created = db
    .select()
    .from(automationDeliveryActionCheckpoints)
    .where(eq(automationDeliveryActionCheckpoints.id, id))
    .get();
  if (!created) throw repositoryNotFoundError("automationDeliveryActionCheckpoint", id);
  return created as unknown as AutomationActionCheckpointRow;
}

export function listCheckpointsForDelivery(
  deliveryId: string,
  client?: AutomationDbClient,
): AutomationActionCheckpointRow[] {
  const db = client ?? getDb();
  return db
    .select()
    .from(automationDeliveryActionCheckpoints)
    .where(eq(automationDeliveryActionCheckpoints.deliveryId, deliveryId))
    .orderBy(asc(automationDeliveryActionCheckpoints.actionIndex))
    .all() as unknown as AutomationActionCheckpointRow[];
}

/**
 * Record an authoritative checkpoint outcome. Fenced: the write is ignored
 * (`false`) when the delivery no longer carries this lease fence, so a stale
 * worker cannot forge proof into a generation owned by a newer worker.
 */
export function recordCheckpointOutcome(input: {
  checkpointId: string;
  deliveryId: string;
  fence: string;
  state: "proved" | "failed";
  receipt?: Record<string, unknown> | null;
  terminalDisposition?: string | null;
  now: string;
}): boolean {
  const db = getDb();
  const result = db.run(sql`
    UPDATE automation_delivery_action_checkpoints
    SET state = ${input.state},
        receipt = ${input.receipt ? JSON.stringify(input.receipt) : null},
        terminal_disposition = ${input.terminalDisposition ?? null},
        proved_at = ${input.state === "proved" ? input.now : null},
        updated_at = ${input.now}
    WHERE id = ${input.checkpointId}
      AND EXISTS (
        SELECT 1 FROM automation_rule_deliveries
        WHERE id = ${input.deliveryId} AND lease_fence = ${input.fence}
      )
  `);
  const changes = (result as { changes?: number } | undefined)?.changes;
  if (typeof changes === "number") return changes === 1;
  // sql.js / mocks: post-update probe must match our write AND the delivery
  // still carrying our fence (the UPDATE's EXISTS guard).
  const probe = db
    .select({
      state: automationDeliveryActionCheckpoints.state,
      updatedAt: automationDeliveryActionCheckpoints.updatedAt,
    })
    .from(automationDeliveryActionCheckpoints)
    .where(eq(automationDeliveryActionCheckpoints.id, input.checkpointId))
    .get();
  if (probe == null || probe.state !== input.state || probe.updatedAt !== input.now) return false;
  const fenceRow = db
    .select({ fence: automationRuleDeliveries.leaseFence })
    .from(automationRuleDeliveries)
    .where(eq(automationRuleDeliveries.id, input.deliveryId))
    .get();
  return fenceRow != null && fenceRow.fence === input.fence;
}

/**
 * Carry proved predecessor-generation checkpoints into a successor delivery so
 * the successor NEVER reruns an already-proved action. `failed`/`pending`
 * checkpoints stay behind — only proved receipts are immutable history the
 * successor may rely on.
 */
export function carryForwardProvedCheckpoints(input: {
  predecessorDeliveryId: string;
  successorDeliveryId: string;
  now: string;
}): number {
  const db = getDb();
  const proved = db
    .select()
    .from(automationDeliveryActionCheckpoints)
    .where(
      and(
        eq(automationDeliveryActionCheckpoints.deliveryId, input.predecessorDeliveryId),
        eq(automationDeliveryActionCheckpoints.state, "proved"),
      ),
    )
    .all();

  let carried = 0;
  for (const checkpoint of proved) {
    const row = checkpoint as unknown as AutomationActionCheckpointRow;
    db.insert(automationDeliveryActionCheckpoints)
      .values({
        id: uuid(),
        deliveryId: input.successorDeliveryId,
        actionIndex: row.actionIndex,
        actionKey: row.actionKey,
        actionType: row.actionType,
        idempotencyKey: row.idempotencyKey,
        state: "proved",
        receipt: row.receipt,
        terminalDisposition: row.terminalDisposition,
        predecessorCheckpointId: row.id,
        createdAt: input.now,
        updatedAt: input.now,
        provedAt: row.provedAt,
      })
      .run();
    carried++;
  }
  return carried;
}

// ---------------------------------------------------------------------------
// Operator disposition ledger
// ---------------------------------------------------------------------------

export function recordDeliveryDisposition(input: {
  deliveryId: string;
  inboxId: string;
  kind: "waive" | "successor_generation";
  actorType: string;
  actorId: string;
  reason: string;
  outcome: string;
  now: string;
}): void {
  const db = getDb();
  db.insert(automationDeliveryDispositions)
    .values({
      id: uuid(),
      deliveryId: input.deliveryId,
      inboxId: input.inboxId,
      kind: input.kind,
      actorType: input.actorType,
      actorId: input.actorId,
      reason: input.reason,
      outcome: input.outcome,
      createdAt: input.now,
    })
    .run();
}

export function listDispositionsForDelivery(deliveryId: string): Array<{
  id: string;
  kind: string;
  actorType: string;
  actorId: string;
  reason: string;
  outcome: string;
  createdAt: string;
}> {
  const db = getDb();
  return db
    .select()
    .from(automationDeliveryDispositions)
    .where(eq(automationDeliveryDispositions.deliveryId, deliveryId))
    .orderBy(asc(automationDeliveryDispositions.createdAt))
    .all() as unknown as Array<{
    id: string;
    kind: string;
    actorType: string;
    actorId: string;
    reason: string;
    outcome: string;
    createdAt: string;
  }>;
}
