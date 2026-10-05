/**
 * T2 — effect receipt repository (authority-and-effects contract, ticket rev 6).
 *
 * Owns the CAS discipline of the receipt outbox family:
 *   - reservation (id-scoped, cap-guarded on BOTH lease branches — B4)
 *   - fenced ack / dead-letter transitions (lease-token fenced)
 *   - separate exhausted-row transitions (holder-fenced at cap; expiry sweep)
 *   - derived parent aggregate writes (S-2: fenced on parent.state='pending';
 *     no direct dead_letter→delivered edge exists anywhere)
 *   - admin dead_letter-only requeue (audited, append-only)
 *   - scanner delegation EXISTS check (keyed on the event ROW id)
 *
 * Canonical key encodings (B2/S-4) live here: JSON.stringify of a typed array
 * — deterministic, delimiter-free, collision-safe for arbitrary ids. One
 * encoder owns the serialized form; no caller concatenates.
 */
import { getDb } from "../db/index.js";
import {
  effectReceipts,
  effectReceiptTargets,
  effectReceiptAttempts,
  effectReceiptAdminActions,
  type EffectReceiptRow,
  type EffectReceiptTargetRow,
} from "../db/schema/index.js";
import { eq, and, lte, inArray, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

/** Declared constant (rev 6 B5) — deliberately not env-configurable. */
export const EFFECT_RECEIPT_MAX_ATTEMPTS = 8;

/** Receipt lease duration (seconds) minted at reservation. */
export const EFFECT_RECEIPT_LEASE_SECONDS = 30;

export type EffectReceiptState = "pending" | "delivered" | "dead_letter";
export type EffectReceiptConsumer = EffectReceiptRow["consumer"];

/** Allowlisted error-code vocabulary (B7) — the only error representation anywhere. */
export const EFFECT_ERROR_CODES = [
  "consumer_threw",
  "write_error",
  "evaluation_error",
  "lease_expired",
  "rate_limited",
  "recovery_deferred",
  "start_failed",
  "outcome_unrecovered",
  "deadline",
  "plugin_removed_or_disabled",
] as const;
export type EffectErrorCode = (typeof EFFECT_ERROR_CODES)[number];

export function isEffectErrorCode(code: string): code is EffectErrorCode {
  return (EFFECT_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * B7 redaction boundary (classifySendFailure precedent): every handler /
 * consumer error string collapses to a fixed code BEFORE any log or persist.
 * Raw messages are never captured, logged, or persisted.
 */
export function classifyEffectError(_raw: string | undefined): EffectErrorCode {
  return "consumer_threw";
}

/** Canonical dispatch unit identity (B2): ["taskEvent",<eventRowId>,"signalDetector",<pluginId>,<contributionId>]. */
export function encodeDispatchKey(
  eventRowId: string,
  pluginId: string,
  contributionId: string,
): string {
  return JSON.stringify(["taskEvent", eventRowId, "signalDetector", pluginId, contributionId]);
}

/** Canonical frozen target identity (S-4): ["signalDetector",<pluginId>,<contributionId>]. */
export function encodeTargetKey(pluginId: string, contributionId: string): string {
  return JSON.stringify(["signalDetector", pluginId, contributionId]);
}

export type EffectDbClient = ReturnType<typeof getDb>;

/**
 * Exact cross-backend CAS outcome (R4): every fenced UPDATE selects
 * `.returning({ id })`, which yields exactly the rows THIS statement matched
 * on BOTH drivers (better-sqlite3 and sql.js) — unlike `run().changes`
 * (absent on sql.js) or a post-state re-read (which can certify a LATER
 * owner's outcome). The SQL predicate stays in the UPDATE for atomicity;
 * RETURNING attributes the outcome to this statement's match only.
 */
function matchedRows(rows: unknown): boolean {
  return Array.isArray(rows) && rows.length > 0;
}

export interface InsertEffectReceiptInput {
  id?: string;
  subjectType: "task_event" | "pulse";
  subjectId: string;
  habitatId: string;
  taskId?: string | null;
  consumer: EffectReceiptConsumer;
  state?: EffectReceiptState;
  deliveredAt?: string;
  causalSnapshot?: Record<string, unknown> | null;
  createdAt?: string;
  tx?: EffectDbClient;
}

/** Inserts one receipt row on the supplied client (act-tx / composer tx compose). */
export function insertReceipt(input: InsertEffectReceiptInput): void {
  const db = input.tx ?? getDb();
  db.insert(effectReceipts)
    .values({
      id: input.id ?? uuid(),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      habitatId: input.habitatId,
      taskId: input.taskId ?? null,
      consumer: input.consumer,
      state: input.state ?? "pending",
      deliveredAt: input.deliveredAt ?? null,
      causalSnapshot: input.causalSnapshot ?? null,
      createdAt: input.createdAt ?? new Date().toISOString(),
    })
    .run();
}

export interface InsertEffectTargetInput {
  receiptId: string;
  habitatId: string;
  pluginId: string;
  contributionId: string;
  createdAt?: string;
  tx?: EffectDbClient;
}

/** Inserts one frozen detector target row (target_key canonical, S-4). */
export function insertTarget(input: InsertEffectTargetInput): string {
  const db = input.tx ?? getDb();
  const id = uuid();
  db.insert(effectReceiptTargets)
    .values({
      id,
      receiptId: input.receiptId,
      habitatId: input.habitatId,
      targetKey: encodeTargetKey(input.pluginId, input.contributionId),
      pluginId: input.pluginId,
      contributionId: input.contributionId,
      createdAt: input.createdAt ?? new Date().toISOString(),
    })
    .run();
  return id;
}

export function getReceiptById(id: string): EffectReceiptRow | null {
  return getDb().select().from(effectReceipts).where(eq(effectReceipts.id, id)).get() ?? null;
}

export function getTargetById(id: string): EffectReceiptTargetRow | null {
  return (
    getDb().select().from(effectReceiptTargets).where(eq(effectReceiptTargets.id, id)).get() ?? null
  );
}

export function listTargetsForReceipt(receiptId: string): EffectReceiptTargetRow[] {
  return getDb()
    .select()
    .from(effectReceiptTargets)
    .where(eq(effectReceiptTargets.receiptId, receiptId))
    .all();
}

/** All pending receipts in creation order (deliverer scan input; bounded). */
export function listPendingReceipts(limit = 200): EffectReceiptRow[] {
  return getDb()
    .select()
    .from(effectReceipts)
    .where(eq(effectReceipts.state, "pending"))
    .orderBy(effectReceipts.createdAt)
    .limit(limit)
    .all();
}

/** All pending detector targets in creation order (deliverer scan input; bounded). */
export function listPendingTargets(limit = 200): EffectReceiptTargetRow[] {
  return getDb()
    .select()
    .from(effectReceiptTargets)
    .where(eq(effectReceiptTargets.state, "pending"))
    .orderBy(effectReceiptTargets.createdAt)
    .limit(limit)
    .all();
}

/**
 * Sibling terminal-state lookup (B5/R-1 eligibility). Read-only, pre-reservation,
 * zero cost: an ineligible row is never written, never reserved, burns no attempt.
 */
export function siblingReceiptState(
  subjectId: string,
  consumer: EffectReceiptConsumer,
): EffectReceiptState | null {
  const row = getDb()
    .select({ state: effectReceipts.state })
    .from(effectReceipts)
    .where(
      and(
        eq(effectReceipts.subjectType, "task_event"),
        eq(effectReceipts.subjectId, subjectId),
        eq(effectReceipts.consumer, consumer),
      ),
    )
    .get();
  return row?.state ?? null;
}

/**
 * Scanner delegation check: does a `detector_dispatch` receipt own this
 * task-event ROW id? Keyed on the true row id — never the legacy tuple.
 */
export function isTaskEventReceiptOwned(eventRowId: string): boolean {
  const row = getDb()
    .select({ id: effectReceipts.id })
    .from(effectReceipts)
    .where(
      and(
        eq(effectReceipts.subjectType, "task_event"),
        eq(effectReceipts.subjectId, eventRowId),
        eq(effectReceipts.consumer, "detector_dispatch"),
      ),
    )
    .get();
  return row !== undefined;
}

export interface Reservation {
  acquired: boolean;
  fence: string | null;
  attempt: number;
}

function leaseExpiry(now: string): string {
  return new Date(new Date(now).getTime() + EFFECT_RECEIPT_LEASE_SECONDS * 1000).toISOString();
}

/**
 * Fenced, id-scoped reservation (B4 final invariant):
 * `id=:id AND attempts<cap AND state='pending' AND (lease_token IS NULL OR
 *  lease_expires_at<=:now)` — the cap guards BOTH lease branches, the id
 * scopes the whole predicate (no table-wide match), and attempts++ is atomic.
 */
export function reserveReceipt(
  id: string,
  owner: string,
  now: string,
  tx?: EffectDbClient,
): Reservation {
  const db = tx ?? getDb();
  const token = uuid();
  const rows = db
    .update(effectReceipts)
    .set({
      leaseOwner: owner,
      leaseToken: token,
      leaseExpiresAt: leaseExpiry(now),
      attempts: sql`${effectReceipts.attempts} + 1`,
    })
    .where(
      and(
        eq(effectReceipts.id, id),
        eq(effectReceipts.state, "pending"),
        sql`${effectReceipts.attempts} < ${EFFECT_RECEIPT_MAX_ATTEMPTS}`,
        sql`(${effectReceipts.leaseToken} IS NULL OR ${effectReceipts.leaseExpiresAt} <= ${now})`,
      ),
    )
    .returning({ attempts: effectReceipts.attempts })
    .all();
  if (!matchedRows(rows)) return { acquired: false, fence: null, attempt: 0 };
  return { acquired: true, fence: token, attempt: rows[0]!.attempts };
}

/** Same fenced reservation for a frozen detector target row. */
export function reserveTarget(
  id: string,
  owner: string,
  now: string,
  tx?: EffectDbClient,
): Reservation {
  const db = tx ?? getDb();
  const token = uuid();
  const rows = db
    .update(effectReceiptTargets)
    .set({
      leaseOwner: owner,
      leaseToken: token,
      leaseExpiresAt: leaseExpiry(now),
      attempts: sql`${effectReceiptTargets.attempts} + 1`,
    })
    .where(
      and(
        eq(effectReceiptTargets.id, id),
        eq(effectReceiptTargets.state, "pending"),
        sql`${effectReceiptTargets.attempts} < ${EFFECT_RECEIPT_MAX_ATTEMPTS}`,
        sql`(${effectReceiptTargets.leaseToken} IS NULL OR ${effectReceiptTargets.leaseExpiresAt} <= ${now})`,
      ),
    )
    .returning({ attempts: effectReceiptTargets.attempts })
    .all();
  if (!matchedRows(rows)) return { acquired: false, fence: null, attempt: 0 };
  return { acquired: true, fence: token, attempt: rows[0]!.attempts };
}

/** Append-only attempt history row. */
export function recordAttempt(
  receiptId: string,
  targetId: string | null,
  attempt: number,
  code: EffectErrorCode | "delivered" | "superseded" | "deferred",
  now: string,
  tx?: EffectDbClient,
): void {
  const db = tx ?? getDb();
  db.insert(effectReceiptAttempts)
    .values({
      id: uuid(),
      receiptId,
      targetId,
      attempt,
      code,
      actor: "deliverer",
      occurredAt: now,
    })
    .run();
}

/**
 * Fenced ack (delivered): only the current lease holder, only from pending.
 * A stale deliverer whose lease was superseded acks zero rows.
 */
export function ackReceiptDelivered(
  id: string,
  fence: string,
  now: string,
  tx?: EffectDbClient,
): boolean {
  const db = tx ?? getDb();
  const rows = db
    .update(effectReceipts)
    .set({
      state: "delivered",
      deliveredAt: now,
      leaseToken: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(effectReceipts.id, id),
        eq(effectReceipts.state, "pending"),
        eq(effectReceipts.leaseToken, fence),
      ),
    )
    .returning({ id: effectReceipts.id })
    .all();
  return matchedRows(rows);
}

/** Fenced target ack (delivered) + derived parent recompute (S-2 fencing) in the same tx. */
export function ackTargetDeliveredAndDeriveParent(
  targetId: string,
  fence: string,
  now: string,
  tx: EffectDbClient,
): boolean {
  const rows = tx
    .update(effectReceiptTargets)
    .set({
      state: "delivered",
      deliveredAt: now,
      leaseToken: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(effectReceiptTargets.id, targetId),
        eq(effectReceiptTargets.state, "pending"),
        eq(effectReceiptTargets.leaseToken, fence),
      ),
    )
    .returning({ id: effectReceiptTargets.id })
    .all();
  if (!matchedRows(rows)) return false;
  deriveParentStateForTarget(targetId, now, tx);
  return true;
}

/**
 * S-2 derived parent aggregate recompute. BOTH derived writes are CAS-fenced
 * on the parent's own `state='pending'` — there is NO direct
 * dead_letter→delivered edge anywhere; the full legal path is
 * `dead_letter --admin requeue--> pending --child-terminal all-complete--> delivered`.
 */
export function deriveParentStateForTarget(
  targetId: string,
  now: string,
  tx: EffectDbClient,
): void {
  const target = tx
    .select({ receiptId: effectReceiptTargets.receiptId })
    .from(effectReceiptTargets)
    .where(eq(effectReceiptTargets.id, targetId))
    .get();
  if (!target) return;
  deriveParentState(target.receiptId, now, tx);
}

export function deriveParentState(receiptId: string, now: string, tx: EffectDbClient): void {
  const children = tx
    .select({ state: effectReceiptTargets.state })
    .from(effectReceiptTargets)
    .where(eq(effectReceiptTargets.receiptId, receiptId))
    .all();
  if (children.length === 0) return; // zero-child receipts are born delivered (S-1)
  const anyDead = children.some((c) => c.state === "dead_letter");
  const allDelivered = children.every((c) => c.state === "delivered");
  if (anyDead) {
    tx.update(effectReceipts)
      .set({ state: "dead_letter", lastErrorCode: "outcome_unrecovered" })
      .where(and(eq(effectReceipts.id, receiptId), eq(effectReceipts.state, "pending")))
      .run();
    return;
  }
  if (allDelivered) {
    tx.update(effectReceipts)
      .set({ state: "delivered", deliveredAt: now })
      .where(and(eq(effectReceipts.id, receiptId), eq(effectReceipts.state, "pending")))
      .run();
  }
}

/**
 * Fenced consumer failure for a receipt: attempt bookkeeping + fixed error
 * code under the lease fence. Returns "dead_letter" when this failure hits
 * the cap (the caller does NOT separately reserve the cap row — a cap-guarded
 * reservation cannot match it, B4).
 */
export function failReceiptFenced(
  id: string,
  fence: string,
  attempt: number,
  code: EffectErrorCode,
  now: string,
  tx?: EffectDbClient,
): "pending" | "dead_letter" | "lost_fence" {
  const db = tx ?? getDb();
  const dead = attempt >= EFFECT_RECEIPT_MAX_ATTEMPTS;
  const rows = db
    .update(effectReceipts)
    .set({
      lastErrorCode: code,
      ...(dead ? { state: "dead_letter" as const } : {}),
      leaseToken: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(effectReceipts.id, id),
        eq(effectReceipts.state, "pending"),
        eq(effectReceipts.leaseToken, fence),
      ),
    )
    .returning({ id: effectReceipts.id })
    .all();
  if (!matchedRows(rows)) return "lost_fence";
  return dead ? "dead_letter" : "pending";
}

/**
 * Fenced consumer failure for a frozen target. When the failure dead-letters,
 * a live run row is terminalized (`failed`/`outcome_unrecovered`) in the SAME
 * tx (B6) and the derived parent dead_letter write runs (S-2, fenced on
 * parent pending).
 */
export function failTargetFenced(
  targetId: string,
  fence: string,
  attempt: number,
  code: EffectErrorCode,
  now: string,
  tx: EffectDbClient,
  terminalizeRun: ((t: EffectDbClient) => void) | null,
): "pending" | "dead_letter" | "lost_fence" {
  const dead = attempt >= EFFECT_RECEIPT_MAX_ATTEMPTS;
  const rows = tx
    .update(effectReceiptTargets)
    .set({
      lastErrorCode: code,
      ...(dead ? { state: "dead_letter" as const } : {}),
      leaseToken: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(effectReceiptTargets.id, targetId),
        eq(effectReceiptTargets.state, "pending"),
        eq(effectReceiptTargets.leaseToken, fence),
      ),
    )
    .returning({ id: effectReceiptTargets.id })
    .all();
  if (!matchedRows(rows)) return "lost_fence";
  if (dead) {
    terminalizeRun?.(tx);
    deriveParentStateForTarget(targetId, now, tx);
  }
  return dead ? "dead_letter" : "pending";
}

/**
 * Expiry sweep (B4/B5): pending cap-exhausted rows whose lease has expired
 * dead-letter. No live lease exists on these rows, so no actor's live work is
 * ever killed. Runs on the deliverer pass.
 */
export function sweepExpiredCapRows(now: string): number {
  const db = getDb();
  const expiredReceipts = db
    .select({ id: effectReceipts.id })
    .from(effectReceipts)
    .where(
      and(
        eq(effectReceipts.state, "pending"),
        sql`${effectReceipts.attempts} >= ${EFFECT_RECEIPT_MAX_ATTEMPTS}`,
        lte(effectReceipts.leaseExpiresAt, now),
      ),
    )
    .all();
  for (const row of expiredReceipts) {
    db.transaction((tx) => {
      tx.update(effectReceipts)
        .set({ state: "dead_letter", lastErrorCode: "lease_expired" })
        .where(
          and(
            eq(effectReceipts.id, row.id),
            eq(effectReceipts.state, "pending"),
            lte(effectReceipts.leaseExpiresAt, now),
          ),
        )
        .run();
    });
  }

  const expiredTargets = db
    .select({ id: effectReceiptTargets.id })
    .from(effectReceiptTargets)
    .where(
      and(
        eq(effectReceiptTargets.state, "pending"),
        sql`${effectReceiptTargets.attempts} >= ${EFFECT_RECEIPT_MAX_ATTEMPTS}`,
        lte(effectReceiptTargets.leaseExpiresAt, now),
      ),
    )
    .all();
  for (const row of expiredTargets) {
    db.transaction((tx) => {
      tx.update(effectReceiptTargets)
        .set({ state: "dead_letter", lastErrorCode: "lease_expired" })
        .where(
          and(
            eq(effectReceiptTargets.id, row.id),
            eq(effectReceiptTargets.state, "pending"),
            lte(effectReceiptTargets.leaseExpiresAt, now),
          ),
        )
        .run();
      deriveParentStateForTarget(row.id, now, tx);
    });
  }
  return expiredReceipts.length + expiredTargets.length;
}

export interface RequeueResult {
  ok: boolean;
  reason?: "not_found" | "not_dead_letter" | "not_owned_by_habitat";
  receiptId: string;
  targetId?: string | null;
}

/**
 * Admin dead_letter-only requeue (C4). Audited (append-only admin action).
 *
 * Non-detector receipts: dead_letter→pending, attempts=0, lease cleared.
 * Per-target scope (detector receipts): resets ONLY that target.
 * Whole-receipt scope on a detector receipt (S-2 liveness): resets ONLY its
 * dead_letter children (completed children never re-run; active/pending
 * children and their live leases untouched), then — if every child is
 * terminal `delivered` — derives all-complete→delivered in the SAME audited
 * tx (no future child-terminal event exists to derive from).
 */
export function adminRequeue(
  receiptId: string,
  actorType: string,
  actorId: string,
  habitatId: string,
  targetId?: string,
): RequeueResult {
  const db = getDb();
  const receipt = getReceiptById(receiptId);
  if (!receipt) return { ok: false, reason: "not_found", receiptId };
  if (receipt.habitatId !== habitatId)
    return { ok: false, reason: "not_owned_by_habitat", receiptId };

  const now = new Date().toISOString();
  const children = listTargetsForReceipt(receiptId);

  if (children.length > 0) {
    if (targetId) {
      const target = children.find((c) => c.id === targetId);
      if (!target) return { ok: false, reason: "not_found", receiptId, targetId };
      if (target.state !== "dead_letter")
        return { ok: false, reason: "not_dead_letter", receiptId, targetId };
      db.transaction((tx) => {
        tx.update(effectReceiptTargets)
          .set({
            state: "pending",
            attempts: 0,
            leaseToken: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorCode: null,
          })
          .where(
            and(
              eq(effectReceiptTargets.id, targetId),
              eq(effectReceiptTargets.state, "dead_letter"),
            ),
          )
          .run();
        insertAdminAction(tx, receiptId, targetId, actorType, actorId, now);
        // Parent stays untouched by a per-target action (S-2b): the derived
        // delivery write is fenced on parent.state='pending' — a dead-lettered
        // parent remains dead-lettered until its own admin requeue.
      });
      return { ok: true, receiptId, targetId };
    }
    if (receipt.state !== "dead_letter") return { ok: false, reason: "not_dead_letter", receiptId };
    db.transaction((tx) => {
      tx.update(effectReceipts)
        .set({
          state: "pending",
          attempts: 0,
          leaseToken: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          deliveredAt: null,
        })
        .where(and(eq(effectReceipts.id, receiptId), eq(effectReceipts.state, "dead_letter")))
        .run();
      tx.update(effectReceiptTargets)
        .set({
          state: "pending",
          attempts: 0,
          leaseToken: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          deliveredAt: null,
        })
        .where(
          and(
            eq(effectReceiptTargets.receiptId, receiptId),
            eq(effectReceiptTargets.state, "dead_letter"),
          ),
        )
        .run();
      insertAdminAction(tx, receiptId, null, actorType, actorId, now);
      // S-2 liveness: with every child already terminal delivered, no future
      // child-terminal tx exists — derive all-complete→delivered in THIS tx.
      deriveParentState(receiptId, now, tx);
    });
    return { ok: true, receiptId };
  }

  if (receipt.state !== "dead_letter") return { ok: false, reason: "not_dead_letter", receiptId };
  db.transaction((tx) => {
    tx.update(effectReceipts)
      .set({
        state: "pending",
        attempts: 0,
        leaseToken: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        deliveredAt: null,
      })
      .where(and(eq(effectReceipts.id, receiptId), eq(effectReceipts.state, "dead_letter")))
      .run();
    insertAdminAction(tx, receiptId, targetId ?? null, actorType, actorId, now);
  });
  return { ok: true, receiptId, targetId: targetId ?? null };
}

function insertAdminAction(
  tx: EffectDbClient,
  receiptId: string,
  targetId: string | null,
  actorType: string,
  actorId: string,
  now: string,
): void {
  tx.insert(effectReceiptAdminActions)
    .values({
      id: uuid(),
      receiptId,
      targetId,
      action: "requeue",
      actorType,
      actorId,
      occurredAt: now,
    })
    .run();
}

export interface AdminListFilter {
  habitatId: string;
  state?: EffectReceiptState;
  consumer?: EffectReceiptConsumer;
  limit?: number;
  offset?: number;
}

/** Admin inspect listing (C4: authorize-before-query is the route's job). */
export function listReceiptsForAdmin(filter: AdminListFilter): {
  receipts: EffectReceiptRow[];
  targets: EffectReceiptTargetRow[];
  total: number;
} {
  const db = getDb();
  const conditions = [eq(effectReceipts.habitatId, filter.habitatId)];
  if (filter.state) conditions.push(eq(effectReceipts.state, filter.state));
  if (filter.consumer) conditions.push(eq(effectReceipts.consumer, filter.consumer));

  const receipts = db
    .select()
    .from(effectReceipts)
    .where(and(...conditions))
    .orderBy(effectReceipts.createdAt)
    .limit(filter.limit ?? 50)
    .offset(filter.offset ?? 0)
    .all();
  const totalRow = db
    .select({ count: sql<number>`count(*)` })
    .from(effectReceipts)
    .where(and(...conditions))
    .get();

  const ids = receipts.map((r) => r.id);
  const targets =
    ids.length > 0
      ? db
          .select()
          .from(effectReceiptTargets)
          .where(inArray(effectReceiptTargets.receiptId, ids))
          .all()
      : [];
  return { receipts, targets, total: totalRow?.count ?? 0 };
}

export function listAttemptsForReceipt(receiptId: string) {
  return getDb()
    .select()
    .from(effectReceiptAttempts)
    .where(eq(effectReceiptAttempts.receiptId, receiptId))
    .orderBy(effectReceiptAttempts.occurredAt)
    .all();
}

export function listAdminActionsForReceipt(receiptId: string) {
  return getDb()
    .select()
    .from(effectReceiptAdminActions)
    .where(eq(effectReceiptAdminActions.receiptId, receiptId))
    .orderBy(effectReceiptAdminActions.occurredAt)
    .all();
}
