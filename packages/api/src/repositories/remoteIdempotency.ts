import { getDb } from "../db/index.js";
import { remoteIdempotencyKeys } from "../db/schema/index.js";
import { eq, and, lt } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryUpdateError,
  repositoryNotFoundError,
} from "../errors/repository.js";

export interface CreateIdempotencyKeyInput {
  habitatId: string;
  remoteParticipantId: string;
  remoteCredentialId?: string | null;
  action: string;
  idempotencyKey: string;
  requestHash: string;
  expiresAt: string;
}

export interface RemoteIdempotencyKeyRow {
  id: string;
  habitatId: string;
  remoteParticipantId: string;
  remoteCredentialId: string | null;
  action: string;
  idempotencyKey: string;
  requestHash: string;
  status: string;
  responseStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  expiresAt: string;
  createdAt: string;
  completedAt: string | null;
}

const fields = {
  id: remoteIdempotencyKeys.id,
  habitatId: remoteIdempotencyKeys.habitatId,
  remoteParticipantId: remoteIdempotencyKeys.remoteParticipantId,
  remoteCredentialId: remoteIdempotencyKeys.remoteCredentialId,
  action: remoteIdempotencyKeys.action,
  idempotencyKey: remoteIdempotencyKeys.idempotencyKey,
  requestHash: remoteIdempotencyKeys.requestHash,
  status: remoteIdempotencyKeys.status,
  responseStatus: remoteIdempotencyKeys.responseStatus,
  responseBody: remoteIdempotencyKeys.responseBody,
  errorMessage: remoteIdempotencyKeys.errorMessage,
  expiresAt: remoteIdempotencyKeys.expiresAt,
  createdAt: remoteIdempotencyKeys.createdAt,
  completedAt: remoteIdempotencyKeys.completedAt,
} as const;

export function getOrCreateIdempotencyKey(input: CreateIdempotencyKeyInput): {
  row: RemoteIdempotencyKeyRow;
  created: boolean;
} {
  const db = getDb();
  const id = uuid();
  try {
    db.insert(remoteIdempotencyKeys)
      .values({
        id,
        habitatId: input.habitatId,
        remoteParticipantId: input.remoteParticipantId,
        remoteCredentialId: input.remoteCredentialId ?? null,
        action: input.action,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        status: "pending",
        expiresAt: input.expiresAt,
        // Explicit ISO timestamp — the column default (`datetime('now')`) is
        // space-separated and zone-less, which stale-pending aging (below)
        // would have to normalize. Inserting ISO keeps every row this code
        // creates trivially parseable.
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing({
        target: [
          remoteIdempotencyKeys.remoteParticipantId,
          remoteIdempotencyKeys.action,
          remoteIdempotencyKeys.idempotencyKey,
        ],
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("remoteIdempotencyKey", err as Error, id);
  }

  // Re-select after insert-or-skip — handles both first insert and concurrent race
  const row = db
    .select(fields)
    .from(remoteIdempotencyKeys)
    .where(
      and(
        eq(remoteIdempotencyKeys.remoteParticipantId, input.remoteParticipantId),
        eq(remoteIdempotencyKeys.action, input.action),
        eq(remoteIdempotencyKeys.idempotencyKey, input.idempotencyKey),
      ),
    )
    .get();
  if (!row) throw repositoryNotFoundError("remoteIdempotencyKey", id);

  // If the row's id matches our generated id, we created it; otherwise a concurrent caller did
  return { row, created: row.id === id };
}

export function getIdempotencyKey(
  remoteParticipantId: string,
  action: string,
  idempotencyKey: string,
): RemoteIdempotencyKeyRow | null {
  const db = getDb();
  const rows = db
    .select(fields)
    .from(remoteIdempotencyKeys)
    .where(
      and(
        eq(remoteIdempotencyKeys.remoteParticipantId, remoteParticipantId),
        eq(remoteIdempotencyKeys.action, action),
        eq(remoteIdempotencyKeys.idempotencyKey, idempotencyKey),
      ),
    )
    .all();
  return rows.length > 0 ? rows[0] : null;
}

export interface TakeoverStalePendingInput {
  remoteParticipantId: string;
  action: string;
  idempotencyKey: string;
}

export interface TakeoverStalePendingResult {
  row: RemoteIdempotencyKeyRow | null;
  taken: boolean;
}

/**
 * Parse a `createdAt` value into an epoch timestamp. Rows written before the
 * explicit-ISO insert convention carry the SQLite column default
 * (`datetime('now')` → `"YYYY-MM-DD HH:MM:SS"`, UTC, space-separated, no
 * zone) — normalize those; an unparseable value ages to 0 so a corrupt row
 * is takeover-eligible (recoverable) rather than permanently blocking.
 */
function parseCreatedAtEpoch(raw: string): number {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(" ", "T")}Z`
    : raw;
  const t = Date.parse(normalized);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Atomically take over a pending idempotency record that has been pending
 * longer than `olderThanMs` — the retry-aware window that lets a well-behaved
 * client re-execute with the SAME key after a retryable failure (e.g. the
 * busy path deliberately leaves the record pending) instead of being told the
 * key is in flight forever.
 *
 * Compare-and-set, mirroring `acquireAttemptLeaseWithClient`: the WHERE
 * predicate encodes BOTH the observed identity and the pending+stale-state
 * precondition, so two concurrent post-window retries are serialized by
 * SQLite's single writer — exactly one swap matches; the loser's UPDATE
 * no-ops and the re-read (fresh `id`/`createdAt`) reports `taken: false`.
 * The winner is whoever's generated `id` survives, the same idiom
 * `getOrCreateIdempotencyKey` uses for its `created` classification.
 *
 * Swapping the `id` (not just bumping `createdAt`) is what makes the win
 * decidable without `changes()`: the re-read row either carries this call's
 * UUID or someone else's. Nothing references this table's `id` externally —
 * the route's complete/fail calls flow through the record id the middleware
 * attaches after this returns.
 */
export function takeoverStalePendingIdempotencyKey(
  input: TakeoverStalePendingInput,
  opts: { olderThanMs: number; now?: Date },
): TakeoverStalePendingResult {
  const db = getDb();
  const row = getIdempotencyKey(
    input.remoteParticipantId,
    input.action,
    input.idempotencyKey,
  );
  if (!row || row.status !== "pending") return { row, taken: false };

  const nowMs = (opts.now ?? new Date()).getTime();
  const ageMs = nowMs - parseCreatedAtEpoch(row.createdAt);
  if (ageMs < opts.olderThanMs) return { row, taken: false };

  const newId = uuid();
  try {
    db.update(remoteIdempotencyKeys)
      .set({ id: newId, createdAt: new Date(nowMs).toISOString() })
      .where(
        and(
          eq(remoteIdempotencyKeys.id, row.id),
          eq(remoteIdempotencyKeys.status, "pending"),
          eq(remoteIdempotencyKeys.createdAt, row.createdAt),
        ),
      )
      .run();
  } catch (err) {
    throw repositoryUpdateError("remoteIdempotencyKey", err as Error, row.id);
  }

  const after = getIdempotencyKey(
    input.remoteParticipantId,
    input.action,
    input.idempotencyKey,
  );
  return { row: after ?? row, taken: after?.id === newId };
}

export function completeIdempotencyKey(
  id: string,
  responseStatus: number,
  responseBody?: Record<string, unknown>,
): RemoteIdempotencyKeyRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remoteIdempotencyKeys)
      .set({
        status: "completed",
        responseStatus,
        responseBody: responseBody !== undefined ? JSON.stringify(responseBody) : null,
        completedAt: now,
      })
      .where(eq(remoteIdempotencyKeys.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remoteIdempotencyKey", err as Error, id);
  }
  return (
    db
      .select(fields)
      .from(remoteIdempotencyKeys)
      .where(eq(remoteIdempotencyKeys.id, id))
      .all()[0] ?? null
  );
}

export function failIdempotencyKey(
  id: string,
  errorMessage: string,
  responseStatus?: number,
): RemoteIdempotencyKeyRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remoteIdempotencyKeys)
      .set({
        status: "failed",
        errorMessage,
        responseStatus: responseStatus ?? null,
        completedAt: now,
      })
      .where(eq(remoteIdempotencyKeys.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remoteIdempotencyKey", err as Error, id);
  }
  return (
    db
      .select(fields)
      .from(remoteIdempotencyKeys)
      .where(eq(remoteIdempotencyKeys.id, id))
      .all()[0] ?? null
  );
}

export function deleteExpiredIdempotencyKeys(): number {
  const db = getDb();
  const now = new Date().toISOString();
  const expired = db
    .select({ id: remoteIdempotencyKeys.id })
    .from(remoteIdempotencyKeys)
    .where(lt(remoteIdempotencyKeys.expiresAt, now))
    .all();
  for (const row of expired) {
    db.delete(remoteIdempotencyKeys).where(eq(remoteIdempotencyKeys.id, row.id)).run();
  }
  return expired.length;
}
