/**
 * Effective-time grant classification — the single pure decision primitive for
 * remote grant authority.
 *
 * A persisted grant row's `status` records what a writer last did; it is NOT
 * authority. Authority is a function of (stored status, stored timestamps,
 * `now`). This module answers that question and nothing else: it never fetches,
 * never mutates, never caches across requests, and never reads a clock of its
 * own — the caller supplies one `now` so a single authorization decision
 * evaluates every candidate grant against the same instant.
 *
 * The persisted row is left exactly as written. Nothing here clears a historical
 * stamp, and no sweep is required for correctness: `expireActiveGrants` remains
 * a storage primitive, and the results below hold when it never runs.
 */

import { z } from "zod";

/** Milliseconds in one grace-window hour. */
export const GRACE_WINDOW_MS_PER_HOUR = 3_600_000;

/** The provisionable grace-window range (`createGrantSchema`). */
export const MIN_GRACE_WINDOW_HOURS = 0;
export const MAX_GRACE_WINDOW_HOURS = 720;

/**
 * An evaluated timestamp must be accepted by the EXISTING provisioning
 * date-time grammar — `z.string().datetime()`, the same validator
 * `createGrantSchema` uses for `expiresAt`. Reusing the validator is what keeps
 * authorization from widening past what an admin can actually provision; a
 * hand-rolled `Date.parse` would silently accept date-only and numeric strings
 * that provisioning rejects.
 */
const PROVISIONED_DATETIME = z.string().datetime();

/**
 * The persisted fields this evaluator reads. `RemoteGrantRow` satisfies this
 * structurally, so no cast is needed at any consumer.
 */
export interface GrantTimeInput {
  status: string;
  expiresAt: string | null;
  expiredAt: string | null;
  revokedAt: string | null;
  graceWindowHours: number;
}

/** Effective authority class of one grant at one instant. */
export type EffectiveGrantState = "active" | "grace" | "blocked";

export interface EffectiveGrantTime {
  state: EffectiveGrantState;
  /**
   * Bounded, non-sensitive diagnostic reason. Server-side only — the remote
   * surface returns generic codes, never this string.
   */
  reason: string;
  /** Epoch ms of the selected grace start, or null when no start was selected. */
  graceStartMs: number | null;
  /** Epoch ms of the exclusive grace end, or null when no start was selected. */
  graceEndMs: number | null;
}

/**
 * Tri-state stamp read. `absent` and `invalid` are distinct on purpose: several
 * statuses treat a missing secondary field as "ignore" but a malformed present
 * one as "block", and collapsing them would fail open.
 */
type Stamp = { kind: "absent" } | { kind: "invalid" } | { kind: "at"; ms: number };

/**
 * Only `null` means absent. Anything else present must parse under the
 * provisioning grammar; an empty string or any other malformed value is invalid
 * (fail-closed). A field the caller marks ignored is never passed here, so it
 * cannot affect the result even when malformed or future-dated.
 */
function readStamp(value: string | null): Stamp {
  if (value === null) return { kind: "absent" };
  if (typeof value !== "string") return { kind: "invalid" };
  if (!PROVISIONED_DATETIME.safeParse(value).success) return { kind: "invalid" };
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? { kind: "at", ms } : { kind: "invalid" };
}

function result(
  state: EffectiveGrantState,
  reason: string,
  graceStartMs: number | null = null,
  graceEndMs: number | null = null,
): EffectiveGrantTime {
  return { state, reason, graceStartMs, graceEndMs };
}

const blocked = (reason: string) => result("blocked", reason);

/**
 * Classify the grace window. Called ONLY once a grace start has been selected,
 * so an invalid window can never remove active authority before expiry.
 *
 * The window is half-open: `start <= now < end`. The exact end is blocked, and
 * a zero-hour window provides no grace at all.
 */
function graceFrom(
  grant: GrantTimeInput,
  now: number,
  startMs: number,
  reason: string,
): EffectiveGrantTime {
  const hours = grant.graceWindowHours;
  if (
    !Number.isInteger(hours) ||
    hours < MIN_GRACE_WINDOW_HOURS ||
    hours > MAX_GRACE_WINDOW_HOURS
  ) {
    return result("blocked", "grace_window_invalid", startMs, null);
  }

  const endMs = startMs + hours * GRACE_WINDOW_MS_PER_HOUR;
  if (!Number.isFinite(endMs)) {
    return result("blocked", "grace_window_invalid", startMs, null);
  }
  if (now < startMs) {
    return result("blocked", "grace_start_in_future", startMs, endMs);
  }
  if (now >= endMs) {
    return result("blocked", "grace_window_elapsed", startMs, endMs);
  }
  return result("grace", reason, startMs, endMs);
}

/**
 * `active`: historical transition stamps are IGNORED, because an explicit
 * reactivation leaves `expiredAt`/`revokedAt` in place and those stamps must not
 * veto restored authority. `expiresAt` is the only configured deadline.
 */
function evaluateActive(grant: GrantTimeInput, now: number): EffectiveGrantTime {
  const expires = readStamp(grant.expiresAt);

  if (expires.kind === "absent") {
    return result("active", "active_non_expiring");
  }
  if (expires.kind === "invalid") {
    return blocked("expires_at_invalid");
  }
  if (now < expires.ms) {
    // The window is deliberately not evaluated here.
    return result("active", "active_before_expiry");
  }
  // At or past the configured deadline, authority is no longer active.
  return graceFrom(grant, now, expires.ms, "active_at_expiry");
}

/**
 * `expired` / `grace`: `expiresAt` is authoritative when present and must be in
 * the past. `expiredAt` is a sweep/legacy stamp — it is ignored entirely when
 * `expiresAt` exists, and it can neither shorten nor extend that deadline. A
 * present `revokedAt` is evaluated and may only SHORTEN the window.
 */
function evaluateExpiredOrGrace(grant: GrantTimeInput, now: number): EffectiveGrantTime {
  const expires = readStamp(grant.expiresAt);

  if (expires.kind === "absent") {
    // Legacy rows with no configured deadline must carry a usable sweep stamp,
    // otherwise there is no honest grace start to measure from.
    const expired = readStamp(grant.expiredAt);
    if (expired.kind === "absent") return blocked("legacy_expiry_start_missing");
    if (expired.kind === "invalid") return blocked("legacy_expiry_start_invalid");
    if (expired.ms > now) return blocked("legacy_expiry_start_in_future");
    return withOptionalEarlierRevocation(grant, now, expired.ms, "legacy_expiry_start");
  }

  if (expires.kind === "invalid") return blocked("expires_at_invalid");
  if (expires.ms > now) return blocked("expires_at_in_future");

  return withOptionalEarlierRevocation(grant, now, expires.ms, "natural_expiry");
}

/** A present, valid, past `revokedAt` may only move the grace start earlier. */
function withOptionalEarlierRevocation(
  grant: GrantTimeInput,
  now: number,
  startMs: number,
  reason: string,
): EffectiveGrantTime {
  const revoked = readStamp(grant.revokedAt);
  if (revoked.kind === "absent") return graceFrom(grant, now, startMs, reason);
  if (revoked.kind === "invalid") return blocked("revoked_at_invalid");
  if (revoked.ms > now) return blocked("revoked_at_in_future");
  return graceFrom(grant, now, Math.min(startMs, revoked.ms), reason);
}

/**
 * `soft_revoked`: `revokedAt` is REQUIRED and must be in the past. A present
 * `expiresAt` may shorten the window but never extend it, so a future scheduled
 * deadline is legitimate here. With no `expiresAt`, a present `expiredAt` plays
 * the same shortening role so an earlier legacy expiry survives a later soft
 * revocation.
 */
function evaluateSoftRevoked(grant: GrantTimeInput, now: number): EffectiveGrantTime {
  const revoked = readStamp(grant.revokedAt);
  if (revoked.kind === "absent") return blocked("revoked_at_missing");
  if (revoked.kind === "invalid") return blocked("revoked_at_invalid");
  if (revoked.ms > now) return blocked("revoked_at_in_future");

  const expires = readStamp(grant.expiresAt);
  if (expires.kind === "invalid") return blocked("expires_at_invalid");

  if (expires.kind === "absent") {
    const expired = readStamp(grant.expiredAt);
    if (expired.kind === "absent") {
      return graceFrom(grant, now, revoked.ms, "soft_revocation");
    }
    if (expired.kind === "invalid") return blocked("expired_at_invalid");
    if (expired.ms > now) return blocked("expired_at_in_future");
    return graceFrom(grant, now, Math.min(revoked.ms, expired.ms), "soft_revocation");
  }

  const startMs = expires.ms <= now ? Math.min(revoked.ms, expires.ms) : revoked.ms;
  return graceFrom(grant, now, startMs, "soft_revocation");
}

/**
 * Classify one persisted grant at the supplied instant.
 *
 * Per-status precedence (the owner contract's table):
 * - `hard_revoked`, `frozen`, and any unknown status are blocked outright — no
 *   timestamp or window restores authority.
 * - `active` ignores `expiredAt`/`revokedAt` entirely and evaluates the window
 *   only once `now` reaches `expiresAt`.
 * - `expired`/`grace` use `expiresAt` when present, else a valid past
 *   `expiredAt`; an evaluated `revokedAt` may only shorten.
 * - `soft_revoked` requires a valid past `revokedAt`; an evaluated `expiresAt`
 *   (or, when absent, `expiredAt`) may only shorten.
 *
 * Every failure to establish a required start is fail-closed for that grant: no
 * `now` fallback fabricates grace. A malformed evaluated field blocks only this
 * grant — another qualifying grant may still authorize independently.
 */
export function evaluateGrantTime(grant: GrantTimeInput, now: number): EffectiveGrantTime {
  if (!Number.isFinite(now)) return blocked("now_not_finite");

  switch (grant.status) {
    case "active":
      return evaluateActive(grant, now);
    case "expired":
    case "grace":
      return evaluateExpiredOrGrace(grant, now);
    case "soft_revoked":
      return evaluateSoftRevoked(grant, now);
    default:
      return blocked("status_denies_authority");
  }
}

/**
 * Ordinary authority only — no grace. Use for read, stream, visibility, claim,
 * comment, Pulse, evidence and notification WRITE gates, and for the
 * exact-same-grant triage predicate.
 */
export function isEffectivelyActive(grant: GrantTimeInput, now: number): boolean {
  return evaluateGrantTime(grant, now).state === "active";
}

/**
 * Any authority at all: active OR inside grace. Deliberately broader than read
 * authority — the generic remote-connection validator uses this to decide
 * whether a connection is still worth keeping, and grace must not buy a stream
 * or a read.
 */
export function isEffectivelyUsable(grant: GrantTimeInput, now: number): boolean {
  return evaluateGrantTime(grant, now).state !== "blocked";
}
