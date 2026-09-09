import { logger } from "../lib/logger.js";
import { getDb } from "../db/index.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as attemptRepo from "../repositories/notificationDeliveryAttempt.js";
import * as stateRepo from "../repositories/notificationChannelState.js";
import {
  NOTIFICATION_DISPOSITION_BUDGET_EXHAUSTED,
  NOTIFICATION_DISPOSITION_DESTINATION_AUTHORIZATION_REMOVED,
  NOTIFICATION_DISPOSITION_NO_AUTHORIZED_DESTINATION,
  NOTIFICATION_DISPOSITION_DESTINATION_DISABLED,
  NOTIFICATION_DISPOSITION_DESTINATION_REMOVED,
  NOTIFICATION_DISPOSITION_NO_SLACK_INTEGRATION,
  NOTIFICATION_DISPOSITION_NO_DISCORD_INTEGRATION,
  NOTIFICATION_DISPOSITION_UNKNOWN_AFTER_LEASE,
  NOTIFICATION_RETRY_BACKOFF_MS,
  NOTIFICATION_WORKER_TICK_MS,
  listDueUnits,
  type DueUnitRow,
} from "../repositories/notificationChannelState.js";
import { dispatchChannel, type TrustedChannelDestination } from "./notificationDeliveryService.js";
import type { NotificationStateDbClient } from "../repositories/notificationChannelState.js";
import type { NotificationDelivery, NotificationEvent } from "@orcy/shared";

export {
  NOTIFICATION_DISPOSITION_NO_SLACK_INTEGRATION,
  NOTIFICATION_DISPOSITION_NO_DISCORD_INTEGRATION,
};

/** Delivery statuses that cancel pending push work (terminal user actions). */
const USER_CANCEL_STATUSES = new Set(["acknowledged", "snoozed", "muted", "cleared"]);

/** Fixed disposition for a destination whose headers JSON cannot be parsed. */
const NOTIFICATION_DISPOSITION_DESTINATION_HEADERS_MALFORMED =
  "destination headers malformed";

const SCAN_LIMIT = 50;

// ---------------------------------------------------------------------------
// Worker lifetime — generation tokens + owned in-flight sends (mirrors the
// accepted webhook retry worker: a pass started under an older generation
// stops claiming; stop() drains bounded before closeDb).
// ---------------------------------------------------------------------------

let workerInterval: ReturnType<typeof setInterval> | null = null;
let generation = 0;
const inFlightSends = new Set<Promise<void>>();
/** Drain bound: the 10 s fetch cap plus slack — a send cannot outlive this. */
const STOP_DRAIN_BOUND_MS = 15_000;

/**
 * One worker pass. Scans the single three-shape eligibility set, processes
 * each unit in isolation (a failing unit never blocks the pass), and owns the
 * sends it launched: the pass resolves only once their fenced outcome writes
 * settled.
 */
export async function processNotificationQueue(
  opts: { now?: string; leaseOwner?: string } = {},
): Promise<void> {
  const passGeneration = generation;
  const owner = opts.leaseOwner ?? `notification-worker:${passGeneration}`;
  const now = opts.now ?? new Date().toISOString();
  const rows = listDueUnits(SCAN_LIMIT, now);
  const launched: Promise<void>[] = [];

  for (const row of rows) {
    if (passGeneration !== generation) {
      // Superseded by stop/restart: no new claims from this pass.
      break;
    }
    try {
      const send = processDueUnit(row, owner, now);
      if (send) launched.push(send);
    } catch (err) {
      // No raw error serialization — the unit/delivery ids are the context.
      logger.error({ unitId: row.unitId, errorCode: "pass_row_failed" }, "Notification delivery pass row failed");
      // Per-row isolation: the unit stays recoverable via the scan.
    }
  }

  await Promise.allSettled(launched);
}

function processDueUnit(
  row: DueUnitRow,
  owner: string,
  now: string,
): Promise<void> | null {
  const base = row.baseChannel ?? row.channelKey.split(":")[0]!;
  const deliveryId = row.deliveryId;

  // Janitor first: an expired claim whose budget is already spent has no live
  // owner and cannot resume — terminalize truthfully (outcome unknown) and
  // resolve its stranded attempt row. Never fires while a lease is live.
  if (row.state === "claimed" && row.reservationsUsed >= row.reservationsTotal) {
    runAtomicOutcomeBundle((tx) => {
      const landed = stateRepo.terminalizeExpiredClaimedUnit(
        {
          unitId: row.unitId,
          state: "exhausted",
          disposition: NOTIFICATION_DISPOSITION_UNKNOWN_AFTER_LEASE,
          now,
        },
        tx,
      );
      if (!landed) return;
      attemptRepo.markPendingAttemptsTerminalForUnit(
        {
          deliveryId,
          channel: base,
          destinationId: row.destinationId,
          status: "failed",
          error: NOTIFICATION_DISPOSITION_UNKNOWN_AFTER_LEASE,
          now,
        },
        tx,
      );
      stateRepo.aggregateDeliveryCompletionIfAllTerminal(deliveryId, now, tx);
    });
    return null;
  }

  // Destination boundary recheck BEFORE spending a reservation (webhook
  // units): current existence/enabled/authorization/config — a destination
  // that can no longer lawfully receive this notification terminalizes
  // skipped with a fixed disposition, no send, no reservation.
  if (base === "webhook") {
    const disposition = destinationRejection(row, now);
    if (disposition !== null) {
      runAtomicOutcomeBundle((tx) => {
        const landed = stateRepo.terminalizeUnitForDisposition(
          {
            unitId: row.unitId,
            state: "skipped",
            disposition,
            now,
          },
          tx,
        );
        if (!landed) return;
        if (row.state === "claimed") {
          // Expired owner terminalized by the recheck: resolve its stranded
          // pending attempt truthfully — only when the transition landed (a
          // live owner's attempt stays theirs; the unit was not ours to take).
          attemptRepo.markPendingAttemptsTerminalForUnit(
            {
              deliveryId,
              channel: base,
              destinationId: row.destinationId,
              status: "failed",
              error: NOTIFICATION_DISPOSITION_UNKNOWN_AFTER_LEASE,
              now,
            },
            tx,
          );
        }
        stateRepo.aggregateDeliveryCompletionIfAllTerminal(deliveryId, now, tx);
      });
      return null;
    }
  }

  // Claim: spends one reservation atomically under a fresh fence. For an
  // expired-claimed unit this is the RESUME — the crashed owner's stranded
  // pending attempt row is resolved (outcome unknown) before the new one.
  const claim = stateRepo.claimUnitForDispatch({
    unitId: row.unitId,
    owner,
    now,
    ttlMs: stateRepo.NOTIFICATION_LEASE_TTL_MS,
  });
  if (!claim.acquired || claim.fence === null) return null;

  if (row.state === "claimed") {
    // Resume: resolve the crashed owner's stranded pending attempt row —
    // idempotent by status predicate, ordered before our attempt creation.
    attemptRepo.markPendingAttemptsTerminalForUnit({
      deliveryId,
      channel: base,
      destinationId: row.destinationId,
      status: "failed",
      error: NOTIFICATION_DISPOSITION_UNKNOWN_AFTER_LEASE,
      now,
    });
  }

  // Dispatch-boundary delivery recheck (post-claim): a recipient terminal
  // action cancels the claimed unit — the fenced outcome below must lose.
  const delivery = deliveryRepo.getNotificationDeliveryById(deliveryId);
  if (!delivery) return null;
  if (USER_CANCEL_STATUSES.has(delivery.status)) {
    runAtomicOutcomeBundle((tx) => {
      stateRepo.recordFencedUnitOutcome(
        {
          unitId: row.unitId,
          fence: claim.fence!,
          outcome: "cancelled",
          disposition: stateRepo.NOTIFICATION_DISPOSITION_CANCELLED,
          now,
        },
        tx,
      );
    });
    return null;
  }

  const event = eventRepo.getNotificationEventById(delivery.eventId);
  if (!event) {
    runAtomicOutcomeBundle((tx) => {
      const landed = stateRepo.recordFencedUnitOutcome(
        {
          unitId: row.unitId,
          fence: claim.fence!,
          outcome: "skipped",
          disposition: "notification event missing",
          now,
        },
        tx,
      );
      if (landed) {
        stateRepo.aggregateDeliveryCompletionIfAllTerminal(deliveryId, now, tx);
      }
    });
    return null;
  }

  // The worker pre-creates its own attempt row: the single attempt identity
  // for this reservation (plugin-returned attemptIds are informational only).
  const attemptNumber = stateRepo.getUnitById(row.unitId)?.reservationsUsed ?? 1;
  const attempt = attemptRepo.createDeliveryAttempt({
    deliveryId,
    channel: base,
    destinationId: row.destinationId,
    attempt: attemptNumber,
    status: "pending",
  });

  const destination = base === "webhook" ? trustedDestination(row) : null;

  const send: Promise<void> = (async () => {
    let result: Awaited<ReturnType<typeof dispatchChannel>>;
    try {
      result = await dispatchChannel(delivery, event, base, destination);
    } catch (err) {
      // Fixed error code only — raw exception text (which can embed
      // destination URLs, secrets, parser output) never persists or logs.
      logger.error(
        { unitId: row.unitId, deliveryId, channel: base, errorCode: "delivery_failed" },
        "Notification send threw",
      );
      result = { channel: base, success: false, error: classifySendFailure(String(err)) };
    }
    applyFencedOutcome({
      row,
      fence: claim.fence!,
      attemptId: attempt.id,
      result,
      now,
    });
  })();
  inFlightSends.add(send);
  void send
    .catch((err) => {
      logger.error({ unitId: row.unitId, errorCode: "send_failed" }, "Notification delivery send failed");
    })
    .finally(() => {
      inFlightSends.delete(send);
    });
  return send;
}

/** Maps a pure-sender result to the fenced unit/attempt outcome. */function applyFencedOutcome(input: {
  row: DueUnitRow;
  fence: string;
  attemptId: string;
  result: { success: boolean; skipped?: boolean; error?: string; statusCode?: number };
  now: string;
}): void {
  const { row, fence, attemptId, result, now } = input;

  // A1+R4 — THE ATOMIC BUNDLE: the fenced unit write, this reservation's
  // attempt-row outcome, and the delivery aggregate run in ONE transaction.
  // A crash (or failed CAS) between any two writes rolls back the WHOLE
  // bundle — the unit returns to its claimed pre-state, the attempt stays
  // pending, the delivery stays pending: exactly the recoverable prestate a
  // later pass (or lease expiry) can resolve. Nothing terminal is ever left
  // stranded beside unfinished bookkeeping.
  //
  // A fence that loses the unit CAS means we are NOT the owner: ZERO attempt
  // or aggregate writes (no fallback branch, no physical-outcome-wins
  // exception — a reconciled outcome stands as written by the winner).
  runAtomicOutcomeBundle((tx) => {
    // Fresh post-claim counts INSIDE the tx — the scan row is stale by one
    // reservation (this claim's). Gates the exhaustion branch correctly.
    const unitNow = stateRepo.getUnitById(row.unitId);
    const used = unitNow?.reservationsUsed ?? row.reservationsUsed;
    const total = unitNow?.reservationsTotal ?? row.reservationsTotal;

    if (result.skipped) {
      const disposition = fixedSkipDisposition(input.result.error);
      const landed = stateRepo.recordFencedUnitOutcome(
        {
          unitId: row.unitId,
          fence,
          outcome: "skipped",
          disposition,
          now,
        },
        tx,
      );
      if (!landed) return;
      attemptRepo.updateDeliveryAttempt(
        attemptId,
        {
          status: "skipped",
          error: disposition,
          finishedAt: now,
        },
        tx,
      );
      stateRepo.aggregateDeliveryCompletionIfAllTerminal(row.deliveryId, now, tx);
      return;
    }

    if (result.success) {
      const landed = stateRepo.recordFencedUnitOutcome(
        {
          unitId: row.unitId,
          fence,
          outcome: "sent",
          now,
        },
        tx,
      );
      if (!landed) return;
      attemptRepo.updateDeliveryAttempt(
        attemptId,
        {
          status: "sent",
          statusCode: result.statusCode ?? null,
          finishedAt: now,
        },
        tx,
      );
      stateRepo.aggregateDeliveryCompletionIfAllTerminal(row.deliveryId, now, tx);
      return;
    }

    const errorCode = result.error ? classifySendFailure(result.error) : null;
    if (used >= total) {
      const landed = stateRepo.recordFencedUnitOutcome(
        {
          unitId: row.unitId,
          fence,
          outcome: "exhausted",
          disposition: NOTIFICATION_DISPOSITION_BUDGET_EXHAUSTED,
          now,
        },
        tx,
      );
      if (!landed) return;
      attemptRepo.updateDeliveryAttempt(
        attemptId,
        {
          status: "failed",
          statusCode: result.statusCode ?? null,
          error: errorCode,
          finishedAt: now,
        },
        tx,
      );
      stateRepo.aggregateDeliveryCompletionIfAllTerminal(row.deliveryId, now, tx);
      return;
    }

    const delay = NOTIFICATION_RETRY_BACKOFF_MS[used - 1] ?? 2_000;
    const nextEligibleAt = new Date(new Date(now).getTime() + delay).toISOString();
    const landed = stateRepo.recordFencedUnitOutcome(
      {
        unitId: row.unitId,
        fence,
        outcome: "cooldown",
        nextEligibleAt,
        now,
      },
      tx,
    );
    if (!landed) return;
    attemptRepo.updateDeliveryAttempt(
      attemptId,
      {
        status: "retry_scheduled",
        statusCode: result.statusCode ?? null,
        error: errorCode,
        nextRetryAt: nextEligibleAt,
        finishedAt: now,
      },
      tx,
    );
  });
}

/**
 * Runs one persistence bundle in a single DB transaction. No network or
 * plugin invocation may run inside. A throw anywhere in the body rolls back
 * everything — logged with a fixed error code, never raw error text. Safe
 * when called inside an outer transaction: drizzle's `transaction` nests via
 * SAVEPOINT (verified on both drivers), so enqueue/cancel callers may
 * compose without BEGIN-in-BEGIN hazards.
 */
function runAtomicOutcomeBundle(body: (tx: NotificationStateDbClient) => void): void {
  getDb().transaction((tx) => {
    body(tx);
  });
}

/**
 * Skip reasons are FIXED text by contract: the in-tree skip dispositions pass
 * through verbatim; anything else (plugin-returned text, transport strings)
 * collapses to the fixed `skipped` code. Raw error text never persists.
 */
function fixedSkipDisposition(raw: string | undefined): string {
  if (raw === NOTIFICATION_DISPOSITION_NO_SLACK_INTEGRATION) return raw;
  if (raw === NOTIFICATION_DISPOSITION_NO_DISCORD_INTEGRATION) return raw;
  if (raw === NOTIFICATION_DISPOSITION_NO_AUTHORIZED_DESTINATION) return raw;
  return "skipped";
}

/**
 * THE redaction boundary: every raw sender/plugin/transport error string
 * collapses to a bounded fixed code here, before it can persist (attempt
 * `error`, unit `disposition`) or be logged. The HTTP status code — where
 * present — is safe classification metadata and is preserved on the attempt
 * row. Raw parser messages, destination URLs, and secrets never survive
 * this function's output, so no downstream truncation can leak them.
 */
function classifySendFailure(raw: string | undefined): string {
  return "delivery_failed";
}

/**
 * Destination boundary check for a webhook unit against its CURRENT
 * subscription row. Returns the fixed rejection disposition, or null when the
 * destination remains authorized.
 */
function destinationRejection(row: DueUnitRow, now: string): string | null {
  const destination = row.destination;
  if (destination === null || destination.url === null) {
    return NOTIFICATION_DISPOSITION_DESTINATION_REMOVED;
  }
  if (destination.enabled !== 1) {
    return NOTIFICATION_DISPOSITION_DESTINATION_DISABLED;
  }
  // Authorization recheck: the events list must still carry the namespaced
  // opt-in for THIS notification type (parsed defensively — malformed legacy
  // JSON terminalizes with fixed text, never a parser error).
  let events: unknown;
  try {
    events = destination.events !== null ? JSON.parse(destination.events) : [];
  } catch {
    return NOTIFICATION_DISPOSITION_DESTINATION_AUTHORIZATION_REMOVED;
  }
  const optIn = `notification:${row.eventType}`;
  if (!Array.isArray(events) || !events.includes(optIn)) {
    return NOTIFICATION_DISPOSITION_DESTINATION_AUTHORIZATION_REMOVED;
  }
  let headers: unknown;
  try {
    headers = destination.headers !== null ? JSON.parse(destination.headers) : {};
  } catch {
    return NOTIFICATION_DISPOSITION_DESTINATION_HEADERS_MALFORMED;
  }
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    return NOTIFICATION_DISPOSITION_DESTINATION_HEADERS_MALFORMED;
  }
  return null;
}

/** Builds the TRUSTED destination context from the subscription row — the
 * only lawful source of an outbound URL (never event payload). */
function trustedDestination(row: DueUnitRow): TrustedChannelDestination | null {
  const destination = row.destination;
  if (!destination || destination.url === null) return null;
  let headers: Record<string, string> = {};
  try {
    const parsed = destination.headers !== null ? JSON.parse(destination.headers) : {};
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      headers = parsed as Record<string, string>;
    }
  } catch {
    headers = {};
  }
  return {
    id: row.destinationId!,
    url: destination.url,
    secret: destination.secret ?? null,
    headers,
  };
}

/**
 * Starts the background delivery worker (60 s tick). Interval-only start: the
 * first pass fires one tick later, by which time initDb() has completed.
 */
export function startNotificationDeliveryWorker(
  intervalMs: number = NOTIFICATION_WORKER_TICK_MS,
): void {
  if (workerInterval) return;
  generation += 1;
  workerInterval = setInterval(() => {
    void processNotificationQueue().catch((err) => {
      logger.error({ errorCode: "delivery_tick_failed" }, "Notification delivery tick failed");
    });
  }, intervalMs);
}

/**
 * Stops the worker: no new ticks, no new claims from superseded generations,
 * and every in-flight send is owned — resolves after their fenced outcome
 * writes landed or the bounded drain window elapsed. Await before closeDb so
 * teardown never races outcome writes.
 */
export async function stopNotificationDeliveryWorker(): Promise<void> {
  generation += 1;
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
  const pending = [...inFlightSends];
  if (pending.length === 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, STOP_DRAIN_BOUND_MS);
    void Promise.allSettled(pending).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Re-exported types used by callers/tests.
export type { NotificationDelivery, NotificationEvent };
