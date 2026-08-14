/**
 * Finding Triage Lifecycle — the single intent-level mutation authority for
 * routing and terminalization.
 *
 * Every route, work link, activation, and terminal resolution crosses this
 * command seam. HTTP, MCP, UI, scan, and Release Activation express intent to
 * this module; they do not sequence repository setters.
 *
 * Design invariants:
 * - Every command acquires the SQLite writer reservation (`BEGIN IMMEDIATE`)
 *   before its first authoritative read.
 * - All writes use one supplied client across the entire transaction.
 * - Exhausted contention maps to typed `busy` (HTTP → 503 + Retry-After),
 *   NEVER raw `SQLITE_BUSY` 500.
 * - Terminal rows cannot route, activate, or transition to non-terminal.
 * - Same normalized route fingerprint replays despite later Mission edits.
 * - Different/invalid intent conflicts WITHOUT writes.
 *
 * See ADR-0048 and the restored lifecycle technical plan for the full
 * specification.
 */

import { createHash } from "crypto";
import { sql } from "drizzle-orm";

import { getDb } from "../db/index.js";
import {
  getByIdWithClient,
  routeWithClient,
  terminalizeWithClient,
  activateGroupWithClient,
  listNonTerminalByCorrectiveMissionIdWithClient,
  type FindingTriage,
  type RouteUpdate,
} from "../repositories/findingTriage.js";
import {
  createMissionWithClient,
  getMissionByIdWithClient,
  activationVersionCasWithClient,
} from "../repositories/mission.js";
import { createMissionEventWithClient } from "../repositories/events/event-feature.js";
import {
  createWithClient as createResolutionWithClient,
  findByFindingSourceWithClient,
} from "../repositories/triageResolutions.js";
import { isSqliteError } from "../errors/sqlite.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import type {
  FindingTriageStatus,
  ResolutionKind,
  SuggestedBucket,
  TriageActorType,
} from "@orcy/shared";
import type { ActorType, Mission, MissionEventAction } from "../models/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supplied-client type for transaction participation. */
type LifecycleDbClient = ReturnType<typeof getDb>;

/** Authenticated actor for lifecycle commands. */
export interface LifecycleActor {
  type: TriageActorType;
  id: string;
}

/** Discriminated reasons a lifecycle command cannot proceed. */
export type ConflictReason =
  | "not_found"
  | "terminal"
  | "legacy_lineage_repair_required"
  | "different_route"
  | "different_payload"
  | "not_authorized"
  | "invalid_input"
  // Activation-specific reasons (restored lifecycle T5).
  | "missing_link"
  | "stale_mission_version"
  | "mission_not_activatable"
  | "mixed_group"
  | "gate_proof_mismatch";

/**
 * Outcome of a lifecycle command.
 *
 * - `applied` — the command executed and committed new state.
 * - `replayed` — the command is idempotent; existing committed state returned.
 * - `conflict` — the command cannot proceed; NO writes occurred.
 * - `busy` — writer reservation exhausted; caller should retry after the delay.
 */
export type LifecycleOutcome<T> =
  | { outcome: "applied"; value: T }
  | { outcome: "replayed"; value: T }
  | { outcome: "conflict"; reason: ConflictReason; current?: unknown }
  | { outcome: "busy"; retryAfterMs: number };

/** Internal result type returned by the inner command function. */
type CommandResult<T> =
  | { outcome: "applied"; value: T }
  | { outcome: "replayed"; value: T }
  | { outcome: "conflict"; reason: ConflictReason; current?: unknown };

// ---------------------------------------------------------------------------
// Route payload types
// ---------------------------------------------------------------------------

/** Route payload for `fix_now` — creates one ungated corrective Mission. */
export interface FixNowRoute {
  bucket: "fix_now";
  missionTitle: string;
  missionDescription: string;
  dependencies?: string[];
}

/** Route payload for deferred routes — creates one gated corrective Mission. */
export interface DeferredRoute {
  bucket: "defer_to_patch" | "defer_to_release";
  missionTitle: string;
  missionDescription: string;
  dependencies?: string[];
  releaseGateType: "patch" | "minor" | "major";
  releaseGateVersion: string;
}

/** Route payload for no-work routes — sets triaged with no Mission. */
export interface NoWorkRoute {
  bucket: "document_as_known_limitation";
}

/** Route payload for investigation-only routing — sets triaged with no Mission. */
export interface InvestigationRoute {
  bucket: "needs_investigation";
}

/** Discriminated union of all route payloads. */
export type RoutePayload = FixNowRoute | DeferredRoute | NoWorkRoute | InvestigationRoute;

/** Input accepted by {@link routeFinding}. */
export interface RouteFindingInput {
  findingId: string;
  actor: LifecycleActor;
  route: RoutePayload;
}

/** Input accepted by {@link resolveFinding}. */
export interface ResolveFindingInput {
  findingId: string;
  actor: LifecycleActor;
  resolution: string;
  resolutionKind: ResolutionKind;
  rootCause?: string;
}

/** Input accepted by {@link markFindingWontfix}. */
export interface WontfixFindingInput {
  findingId: string;
  actor: LifecycleActor;
  reason: string;
}

// ---------------------------------------------------------------------------
// Activation payload types (restored lifecycle T5)
// ---------------------------------------------------------------------------

/** Result of a successful (or replayed) activation command. */
export interface ActivationResult {
  /** The SAME corrective Mission — never a replacement; its id never changes. */
  mission: Mission;
  /** Every activated Finding (the complete eligible group), post-activation. */
  findings: FindingTriage[];
}

/** Input accepted by {@link activateCorrectiveMission} (manual, human-only). */
export interface ManualActivateInput {
  findingId: string;
  /** Authenticated human actor (transport derives identity; body cannot supply it). */
  actor: LifecycleActor;
  /** The Mission version the caller observed; CASed against the live row. */
  expectedMissionVersion: number;
}

/**
 * Input accepted by {@link activateCorrectiveMissionForRelease} (internal
 * Release-mode activation).
 *
 * `gateProof` is the caller's proof that the Mission's gate is satisfied by
 * Release history: the Release reconciler derives the satisfied gate
 * (type + version) from persisted Release history BEFORE calling, and the
 * kernel re-verifies the proof against the Mission's LIVE gate inside the
 * transaction — a gate that changed, or a proof for a different gate, is a
 * `gate_proof_mismatch` conflict with zero writes.
 */
export interface ReleaseActivateInput {
  findingId: string;
  /** Persisted Release identity; attribution on every activated row. */
  releaseId: string;
  /**
   * Proof the Mission's gate is satisfied by this Release's history. The
   * version is `string | null` because a Mission gate may be type-only
   * (e.g. `releaseGateType: "minor"` with no pinned version) — the kernel
   * compares the proof against the LIVE gate with strict equality, so a
   * type-only gate requires a type-only proof.
   */
  gateProof: {
    releaseGateType: "patch" | "minor" | "major" | null;
    releaseGateVersion: string | null;
  };
}

// ---------------------------------------------------------------------------
// withImmediateLifecycleTransaction
// ---------------------------------------------------------------------------

const MAX_BUSY_RETRIES = 4;
const BASE_BACKOFF_MS = 50;

/** Maximum backoff cap to avoid excessive waits. */
const MAX_BACKOFF_MS = 2000;

/**
 * Detects whether an error represents SQLite write-lock contention.
 *
 * drizzle-orm wraps better-sqlite3 errors; the real `message`/`code` (e.g.
 * `SQLITE_BUSY`) may live on `.cause`, not the thrown error's own properties.
 * sql.js errors lack `name`/`code` entirely — fall back to message regex.
 */
function isLifecycleBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  // Direct better-sqlite3 SqliteError
  const code = (err as { code?: string }).code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_BUSY_RECOVERY" || code === "SQLITE_LOCKED") {
    return true;
  }

  // Drizzle-wrapped: real error on .cause
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const causeCode = (cause as { code?: string }).code;
    if (
      causeCode === "SQLITE_BUSY" ||
      causeCode === "SQLITE_BUSY_RECOVERY" ||
      causeCode === "SQLITE_LOCKED"
    ) {
      return true;
    }
    if (/SQLITE_BUSY/i.test(cause.message)) return true;
  }

  // sql.js fallback: message regex
  if (/SQLITE_BUSY/i.test(err.message)) return true;

  return false;
}

/** Synchronous bounded sleep via Atomics.wait (Node.js main thread / workers). */
function syncSleep(ms: number): void {
  if (ms <= 0) return;
  try {
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, ms);
  } catch {
    // SharedArrayBuffer unavailable (e.g. disabled by the environment) —
    // busy-wait is the only synchronous fallback. Keep it short.
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // spin
    }
  }
}

/** Computes backoff with jitter for the given attempt index (0-based). */
function backoffDelay(attempt: number): number {
  const exponential = BASE_BACKOFF_MS * Math.pow(2, attempt);
  const jitter = Math.random() * BASE_BACKOFF_MS;
  return Math.min(exponential + jitter, MAX_BACKOFF_MS);
}

/**
 * Immediate lifecycle transaction wrapper.
 *
 * Acquires `BEGIN IMMEDIATE` before any command read, retries pre-begin
 * `SQLITE_BUSY` with bounded backoff/jitter, passes the same client to every
 * supplied-client primitive, and maps exhausted contention to typed `busy`.
 *
 * - `applied`/`replayed` → `COMMIT` (writes durable).
 * - `conflict` → `ROLLBACK` (no partial writes).
 * - Error throw → `ROLLBACK` + re-throw (unless busy → retry or typed busy).
 *
 * Never nest this wrapper inside Drizzle's default deferred transaction.
 */
export function withImmediateLifecycleTransaction<T>(
  fn: (client: LifecycleDbClient) => CommandResult<T>,
  db?: LifecycleDbClient,
): LifecycleOutcome<T> {
  const client = db ?? getDb();
  let lastBusyAttempt = -1;

  for (let attempt = 0; attempt <= MAX_BUSY_RETRIES; attempt++) {
    // Phase 1: acquire the writer reservation
    try {
      client.run(sql`BEGIN IMMEDIATE`);
    } catch (beginErr) {
      if (isLifecycleBusyError(beginErr)) {
        lastBusyAttempt = attempt;
        if (attempt < MAX_BUSY_RETRIES) {
          syncSleep(backoffDelay(attempt));
          continue;
        }
        return { outcome: "busy", retryAfterMs: backoffDelay(MAX_BUSY_RETRIES + 1) };
      }
      throw beginErr;
    }

    // Phase 2: execute the command under the reservation
    try {
      const result = fn(client);

      if (result.outcome === "applied" || result.outcome === "replayed") {
        client.run(sql`COMMIT`);
      } else {
        // conflict — no writes should have occurred
        client.run(sql`ROLLBACK`);
      }
      return result;
    } catch (err) {
      // Rollback on any error
      try {
        client.run(sql`ROLLBACK`);
      } catch {
        // Already rolled back or not in a transaction (defensive)
      }

      if (isLifecycleBusyError(err)) {
        lastBusyAttempt = attempt;
        if (attempt < MAX_BUSY_RETRIES) {
          syncSleep(backoffDelay(attempt));
          continue;
        }
        return { outcome: "busy", retryAfterMs: backoffDelay(MAX_BUSY_RETRIES + 1) };
      }
      throw err;
    }
  }

  // Exhausted all retries
  void lastBusyAttempt;
  return { outcome: "busy", retryAfterMs: backoffDelay(MAX_BUSY_RETRIES + 1) };
}

// ---------------------------------------------------------------------------
// Route fingerprinting
// ---------------------------------------------------------------------------

/**
 * Normalized immutable route fingerprint.
 *
 * Captures the route intent (bucket, Mission title/description, gate, sorted
 * dependencies) EXCLUDING actor, timestamps, and Mission version. Mission
 * gate/dependency edits after routing never change this fingerprint — a network
 * retry uses the STORED fingerprint, not the current Mission shape.
 */
export function computeRouteFingerprint(route: RoutePayload): string {
  const normalized: Record<string, unknown> = {
    bucket: route.bucket,
  };

  if (route.bucket === "fix_now") {
    normalized.dependencies = (route.dependencies ?? []).slice().sort();
    normalized.missionTitle = route.missionTitle;
    normalized.missionDescription = route.missionDescription;
  } else if (route.bucket === "defer_to_patch" || route.bucket === "defer_to_release") {
    normalized.dependencies = (route.dependencies ?? []).slice().sort();
    normalized.missionTitle = route.missionTitle;
    normalized.missionDescription = route.missionDescription;
    normalized.releaseGateType = route.releaseGateType;
    normalized.releaseGateVersion = route.releaseGateVersion;
  }

  // Sort keys for deterministic JSON (insertion order is alphabetical by construction)
  const sortedKeys = Object.keys(normalized).sort();
  const sorted: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sorted[key] = normalized[key];
  }

  const canonical = JSON.stringify(sorted);
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True for routes that create a corrective Mission (fix_now, deferred). */
function isWorkBearingRoute(route: RoutePayload): boolean {
  return (
    route.bucket === "fix_now" ||
    route.bucket === "defer_to_patch" ||
    route.bucket === "defer_to_release"
  );
}

/** Maps {@link TriageActorType} to the event-store {@link ActorType}. */
function mapActorType(type: TriageActorType): ActorType {
  return type;
}

/**
 * Publishes SSE after a successful route command. Called AFTER the transaction
 * commits — SSE is an after-commit projection and never authority.
 */
function publishRouteSse(
  habitatId: string,
  findingId: string,
  status: FindingTriageStatus,
  bucket: SuggestedBucket,
): void {
  sseBroadcaster.publish(habitatId, {
    type: "triage.finding_updated",
    data: { habitatId, findingId, status, bucket },
  });
}

/**
 * Publishes SSE after a successful terminal command.
 */
function publishTerminalSse(
  habitatId: string,
  findingId: string,
  status: FindingTriageStatus,
): void {
  sseBroadcaster.publish(habitatId, {
    type: "triage.finding_updated",
    data: { habitatId, findingId, status, bucket: null },
  });
}

// ---------------------------------------------------------------------------
// routeFinding
// ---------------------------------------------------------------------------

/**
 * Routes a finding into its lifecycle bucket.
 *
 * - `fix_now`: creates ONE ungated corrective Mission, sets `in_progress`,
 *   records activation attribution.
 * - `defer_to_patch`/`defer_to_release`: creates ONE gated corrective Mission
 *   with dependency placement, sets `triaged`.
 * - `document_as_known_limitation`: sets `triaged` with no Mission.
 * - `needs_investigation`: sets `triaged` with no Mission.
 *
 * Mission creation + dependencies + link + Mission event commit on ONE supplied
 * client. Same normalized fingerprint replays; different payload conflicts.
 */
export function routeFinding(
  input: RouteFindingInput,
  db?: LifecycleDbClient,
): LifecycleOutcome<FindingTriage> {
  const outcome = withImmediateLifecycleTransaction<FindingTriage>((client) => {
    // 1. Read finding under the writer reservation
    const finding = getByIdWithClient(client, input.findingId);
    if (!finding) {
      return { outcome: "conflict" as const, reason: "not_found" as ConflictReason };
    }

    // 2. Terminal closure
    if (finding.status === "resolved" || finding.status === "wontfix") {
      return {
        outcome: "conflict" as const,
        reason: "terminal" as ConflictReason,
        current: finding.status,
      };
    }

    // 3. Legacy lineage repair required
    if (finding.legacyLineageRepairRequired) {
      return {
        outcome: "conflict" as const,
        reason: "legacy_lineage_repair_required" as ConflictReason,
      };
    }

    // 4. Compute fingerprint
    const fingerprint = computeRouteFingerprint(input.route);

    // 5. Replay / conflict detection
    if (finding.routeFingerprint !== null) {
      if (finding.routeFingerprint === fingerprint) {
        // Same route — replay
        return { outcome: "replayed" as const, value: finding };
      }

      // Different fingerprint — check permitted reroute:
      // triaged + no link + work-bearing after a no-work route
      const isPermittedReroute =
        finding.status === "triaged" &&
        finding.correctiveMissionId === null &&
        isWorkBearingRoute(input.route) &&
        (finding.bucket === "needs_investigation" ||
          finding.bucket === "document_as_known_limitation");

      if (!isPermittedReroute) {
        return {
          outcome: "conflict" as const,
          reason: "different_route" as ConflictReason,
          current: {
            status: finding.status,
            bucket: finding.bucket,
            fingerprint: finding.routeFingerprint,
          },
        };
      }
      // Permitted reroute: proceed with new fingerprint (fall through)
    }

    // 6. Create corrective Mission for work-bearing routes
    let correctiveMissionId: string | null = null;

    if (input.route.bucket === "fix_now") {
      const mission = createMissionWithClient(client, {
        habitatId: finding.habitatId,
        title: input.route.missionTitle,
        description: input.route.missionDescription,
        dependsOn: input.route.dependencies,
        createdBy: input.actor.id,
      });
      correctiveMissionId = mission.id;

      createMissionEventWithClient(client, {
        missionId: mission.id,
        actorType: mapActorType(input.actor.type),
        actorId: input.actor.id,
        action: "created" as MissionEventAction,
        metadata: {
          title: mission.title,
          source: "finding_triage_route",
          findingId: input.findingId,
          routeBucket: input.route.bucket,
        },
      });
    } else if (
      input.route.bucket === "defer_to_patch" ||
      input.route.bucket === "defer_to_release"
    ) {
      const mission = createMissionWithClient(client, {
        habitatId: finding.habitatId,
        title: input.route.missionTitle,
        description: input.route.missionDescription,
        dependsOn: input.route.dependencies,
        releaseGateType: input.route.releaseGateType,
        releaseGateVersion: input.route.releaseGateVersion,
        createdBy: input.actor.id,
      });
      correctiveMissionId = mission.id;

      createMissionEventWithClient(client, {
        missionId: mission.id,
        actorType: mapActorType(input.actor.type),
        actorId: input.actor.id,
        action: "created" as MissionEventAction,
        metadata: {
          title: mission.title,
          source: "finding_triage_route",
          findingId: input.findingId,
          routeBucket: input.route.bucket,
          releaseGateType: input.route.releaseGateType,
          releaseGateVersion: input.route.releaseGateVersion,
        },
      });
    }

    // 7. Write Finding route state
    const newStatus: FindingTriageStatus =
      input.route.bucket === "fix_now" ? "in_progress" : "triaged";
    const now = new Date().toISOString();

    const update: RouteUpdate = {
      status: newStatus,
      bucket: input.route.bucket,
      routeFingerprint: fingerprint,
      correctiveMissionId,
      triagedAt: newStatus === "triaged" ? now : finding.triagedAt,
      triagedByType: newStatus === "triaged" ? input.actor.type : finding.triagedByType,
      triagedById: newStatus === "triaged" ? input.actor.id : finding.triagedById,
      activatedAt: newStatus === "in_progress" ? now : null,
      activatedByType: newStatus === "in_progress" ? input.actor.type : null,
      activatedById: newStatus === "in_progress" ? input.actor.id : null,
      activationCause: newStatus === "in_progress" ? ("manual" as const) : null,
      activationReleaseId: null,
      updatedAt: now,
    };

    const updated = routeWithClient(client, input.findingId, update);
    return { outcome: "applied" as const, value: updated };
  }, db);

  // After-commit SSE projection
  if (outcome.outcome === "applied" || outcome.outcome === "replayed") {
    publishRouteSse(
      outcome.value.habitatId,
      outcome.value.id,
      outcome.value.status,
      outcome.value.bucket ?? "needs_investigation",
    );
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// activateCorrectiveMission (manual + internal Release-mode kernel)
// ---------------------------------------------------------------------------

/**
 * Publishes SSE after a successful activation command. After-commit
 * projection only — never authority.
 */
function publishActivationSse(outcome: LifecycleOutcome<ActivationResult>): void {
  if (outcome.outcome !== "applied" && outcome.outcome !== "replayed") return;
  for (const finding of outcome.value.findings) {
    if (finding.status !== "in_progress") continue;
    sseBroadcaster.publish(finding.habitatId, {
      type: "triage.finding_updated",
      data: {
        habitatId: finding.habitatId,
        findingId: finding.id,
        status: finding.status,
        bucket: finding.bucket,
      },
    });
  }
}

/** Arguments for the shared activation kernel (manual and Release modes). */
interface ActivationKernelArgs {
  findingId: string;
  mode: "manual" | "release";
  /** Event-store actor type: `human` (manual) or `system` (Release). */
  actorType: ActorType;
  actorId: string;
  /** Manual: the caller-observed version, CASed. Release: the in-tx read. */
  expectedMissionVersion: number | null;
  releaseId: string | null;
  gateProof: ReleaseActivateInput["gateProof"] | null;
}

/**
 * The shared activation kernel. Runs inside ONE immediate lifecycle
 * transaction over the corrective Mission and ALL its linked non-terminal
 * Findings:
 *
 * 1. reads the Finding, rejects terminal / repair-required / missing link;
 * 2. replays when the complete group is already activated (manual/release
 *    races converge here — the loser's `BEGIN IMMEDIATE` serializes behind
 *    the winner and then reads the winner's committed group);
 * 3. rejects archived/terminal Missions, mixed group states, and partial
 *    eligibility with ZERO writes;
 * 4. compare-and-swaps the Mission version (manual additionally clears ONLY
 *    `releaseGateType`/`releaseGateVersion`; Release retains the gate);
 * 5. writes ONE same-transaction Mission `updated` audit event (failure
 *    rolls back the activation);
 * 6. activates the whole homogeneous group in one atomic statement.
 *
 * No Mission field other than gate/version/updatedAt changes; dependencies,
 * deadlines, Tasks, and status are retained. The Mission id never changes
 * and no replacement Mission is created.
 */
function runActivationCommand(
  client: LifecycleDbClient,
  args: ActivationKernelArgs,
): CommandResult<ActivationResult> {
  const finding = getByIdWithClient(client, args.findingId);
  if (!finding) {
    return { outcome: "conflict" as const, reason: "not_found" as ConflictReason };
  }
  if (finding.status === "resolved" || finding.status === "wontfix") {
    return {
      outcome: "conflict" as const,
      reason: "terminal" as ConflictReason,
      current: finding.status,
    };
  }
  if (finding.legacyLineageRepairRequired) {
    return {
      outcome: "conflict" as const,
      reason: "legacy_lineage_repair_required" as ConflictReason,
    };
  }

  const missionId = finding.correctiveMissionId;
  if (!missionId) {
    return {
      outcome: "conflict" as const,
      reason: "missing_link" as ConflictReason,
      current: "Finding has no corrective Mission link",
    };
  }
  const mission = getMissionByIdWithClient(client, missionId);
  if (!mission) {
    return {
      outcome: "conflict" as const,
      reason: "missing_link" as ConflictReason,
      current: "Linked corrective Mission no longer exists",
    };
  }

  const group = listNonTerminalByCorrectiveMissionIdWithClient(client, missionId);

  // Replay: the complete group is already activated. This is where a
  // manual/Release race converges — the loser reads the winner's committed
  // activation and returns it without a second write.
  if (finding.status === "in_progress" && finding.activatedAt !== null) {
    if (group.every((f) => f.status === "in_progress")) {
      return { outcome: "replayed" as const, value: { mission, findings: group } };
    }
    return {
      outcome: "conflict" as const,
      reason: "mixed_group" as ConflictReason,
      current: { findingStatus: "in_progress", groupStatuses: group.map((f) => f.status) },
    };
  }

  if (mission.isArchived || mission.status === "done" || mission.status === "failed") {
    return {
      outcome: "conflict" as const,
      reason: "mission_not_activatable" as ConflictReason,
      current: { status: mission.status, isArchived: mission.isArchived },
    };
  }

  // Homogeneous group: EVERY linked non-terminal Finding must be `triaged`
  // and eligible as ONE group. Mixed states or partial eligibility reject
  // with zero writes — activation is all-or-none over the shared Mission.
  const ineligible = group.filter((f) => f.status !== "triaged" || f.legacyLineageRepairRequired);
  if (ineligible.length > 0) {
    return {
      outcome: "conflict" as const,
      reason: "mixed_group" as ConflictReason,
      current: {
        ineligible: ineligible.map((f) => ({
          id: f.id,
          status: f.status,
          legacyLineageRepairRequired: f.legacyLineageRepairRequired,
        })),
      },
    };
  }

  // Release mode: the caller's gate proof must match the Mission's LIVE gate.
  // The reconciler derives the proof from Release history; a changed gate or
  // a proof for a different gate conflicts before any write.
  if (args.mode === "release") {
    if (
      mission.releaseGateType !== args.gateProof?.releaseGateType ||
      mission.releaseGateVersion !== args.gateProof?.releaseGateVersion
    ) {
      return {
        outcome: "conflict" as const,
        reason: "gate_proof_mismatch" as ConflictReason,
        current: {
          missionGate: {
            releaseGateType: mission.releaseGateType,
            releaseGateVersion: mission.releaseGateVersion,
          },
          proof: args.gateProof ?? null,
        },
      };
    }
  }

  // Gate/version compare-and-swap. Manual clears ONLY the gate fields;
  // Release retains them. Manual CASes the caller-observed version; Release
  // CASes the version read under this same writer reservation.
  const expectedVersion =
    args.mode === "manual" ? (args.expectedMissionVersion as number) : mission.version;
  const priorGate =
    mission.releaseGateType !== null
      ? {
          releaseGateType: mission.releaseGateType,
          releaseGateVersion: mission.releaseGateVersion,
        }
      : null;
  const cas = activationVersionCasWithClient(client, missionId, expectedVersion, {
    clearReleaseGate: args.mode === "manual",
  });
  if (cas.status === "not_found") {
    return {
      outcome: "conflict" as const,
      reason: "missing_link" as ConflictReason,
      current: "Linked corrective Mission no longer exists",
    };
  }
  if (cas.status === "version_mismatch") {
    return {
      outcome: "conflict" as const,
      reason: "stale_mission_version" as ConflictReason,
      current: { currentVersion: cas.currentVersion },
    };
  }

  // Same-transaction Mission `updated` audit event. A failure here throws and
  // rolls back the gate-CAS AND the group activation (fail-closed).
  createMissionEventWithClient(client, {
    missionId,
    actorType: args.actorType,
    actorId: args.actorId,
    action: "updated" as MissionEventAction,
    metadata: {
      source:
        args.mode === "manual"
          ? "finding_triage_manual_activation"
          : "finding_triage_release_activation",
      findingIds: group.map((f) => f.id),
      ...(args.releaseId !== null ? { releaseId: args.releaseId } : {}),
      priorGate,
      changedFields:
        args.mode === "manual" ? ["releaseGateType", "releaseGateVersion", "version"] : ["version"],
    },
  });

  // Activate the complete eligible group in ONE atomic statement.
  const now = new Date().toISOString();
  const findings = activateGroupWithClient(
    client,
    group.map((f) => f.id),
    {
      activatedAt: now,
      activatedByType: args.mode === "manual" ? "human" : "system",
      activatedById: args.actorId,
      activationCause: args.mode === "manual" ? "manual" : "release",
      activationReleaseId: args.mode === "release" ? args.releaseId : null,
      updatedAt: now,
    },
  );

  return { outcome: "applied" as const, value: { mission: cas.mission, findings } };
}

/**
 * Manual activation of the Finding's EXISTING corrective Mission (human-only).
 *
 * The preferred manual flow: activate the existing linked Mission — never
 * create a replacement, never clear dependencies, never force Mission/Task
 * status. Oversized groups are ALLOWED (no cap on manual activation),
 * attributed `manual`, and consume no Release budget.
 *
 * The immediate transaction requires every linked non-terminal Finding to be
 * `triaged` and eligible as ONE homogeneous group, compare-and-swaps
 * `expectedMissionVersion`, clears ONLY `releaseGateType`/`releaseGateVersion`,
 * writes a same-transaction Mission `updated` audit event, and activates the
 * whole group. An already-activated group replays.
 */
export function activateCorrectiveMission(
  input: ManualActivateInput,
  db?: LifecycleDbClient,
): LifecycleOutcome<ActivationResult> {
  if (input.actor.type !== "human") {
    return {
      outcome: "conflict",
      reason: "not_authorized",
      current: "activate is human-only",
    };
  }
  if (
    typeof input.expectedMissionVersion !== "number" ||
    !Number.isInteger(input.expectedMissionVersion) ||
    input.expectedMissionVersion < 0
  ) {
    return {
      outcome: "conflict",
      reason: "invalid_input",
      current: "expectedMissionVersion (non-negative integer) is required",
    };
  }

  const outcome = withImmediateLifecycleTransaction<ActivationResult>(
    (client) =>
      runActivationCommand(client, {
        findingId: input.findingId,
        mode: "manual",
        actorType: "human",
        actorId: input.actor.id,
        expectedMissionVersion: input.expectedMissionVersion,
        releaseId: null,
        gateProof: null,
      }),
    db,
  );

  publishActivationSse(outcome);
  return outcome;
}

/**
 * Internal Release-mode activation (restored lifecycle T5).
 *
 * Same kernel and transaction shape as manual activation, but:
 * - the satisfied gate is RETAINED (Release history is never cleared);
 * - every activated row is attributed to the Release
 *   (`activation_cause='release'`, `activation_release_id`);
 * - the caller MUST prove the gate is satisfied by Release history via
 *   `gateProof`, re-verified against the Mission's live gate in-transaction.
 *
 * NOT HTTP-reachable. Callable ONLY from the internal Release service
 * boundary (the T7 reconciler) — no public actor may spoof Release
 * attribution.
 *
 * @internal
 */
export function activateCorrectiveMissionForRelease(
  input: ReleaseActivateInput,
  db?: LifecycleDbClient,
): LifecycleOutcome<ActivationResult> {
  const outcome = withImmediateLifecycleTransaction<ActivationResult>(
    (client) =>
      runActivationCommand(client, {
        findingId: input.findingId,
        mode: "release",
        actorType: "system",
        actorId: input.releaseId,
        expectedMissionVersion: null,
        releaseId: input.releaseId,
        gateProof: input.gateProof,
      }),
    db,
  );

  publishActivationSse(outcome);
  return outcome;
}

/**
 * Reserved-client Release-mode kernel entry for the T7 epoch reconciler.
 *
 * Runs the SAME activation kernel (`runActivationCommand`) on a client that
 * ALREADY holds the writer reservation (an outer `BEGIN IMMEDIATE` opened by
 * the reconciler's per-group transaction) — no nested transaction is opened,
 * so the kernel's writes and the epoch group's disposition commit atomically
 * in the caller's transaction. The caller owns retry/busy mapping and SSE
 * publication (SSE is an after-commit projection, never authority).
 *
 * @internal NOT HTTP-reachable; callable only from the Release reconciler.
 */
export function runReleaseActivationOnReservedClient(
  client: LifecycleDbClient,
  input: ReleaseActivateInput,
):
  | { outcome: "applied"; value: ActivationResult }
  | { outcome: "replayed"; value: ActivationResult }
  | { outcome: "conflict"; reason: ConflictReason; current?: unknown } {
  return runActivationCommand(client, {
    findingId: input.findingId,
    mode: "release",
    actorType: "system",
    actorId: input.releaseId,
    expectedMissionVersion: null,
    releaseId: input.releaseId,
    gateProof: input.gateProof,
  });
}

// ---------------------------------------------------------------------------
// resolveFinding
// ---------------------------------------------------------------------------

/**
 * Resolves a finding (human-only). Writes terminal `resolved` status and
 * exactly one Finding-sourced Resolution Record atomically.
 *
 * Non-empty resolution text + kind required; root cause may be unknown.
 * Same payload replays; different payload conflicts.
 */
export function resolveFinding(
  input: ResolveFindingInput,
  db?: LifecycleDbClient,
): LifecycleOutcome<FindingTriage> {
  // Pre-transaction validation
  if (input.actor.type !== "human") {
    return { outcome: "conflict", reason: "not_authorized", current: "resolve is human-only" };
  }
  if (!input.resolution || input.resolution.trim().length === 0) {
    return {
      outcome: "conflict",
      reason: "invalid_input",
      current: "non-empty resolution text required",
    };
  }

  const outcome = withImmediateLifecycleTransaction<FindingTriage>((client) => {
    const finding = getByIdWithClient(client, input.findingId);
    if (!finding) {
      return { outcome: "conflict" as const, reason: "not_found" as ConflictReason };
    }

    // Already wontfix — cannot re-resolve
    if (finding.status === "wontfix") {
      return {
        outcome: "conflict" as const,
        reason: "terminal" as ConflictReason,
        current: finding.status,
      };
    }

    // Idempotency: check existing Finding-sourced Resolution
    const existing = findByFindingSourceWithClient(client, finding.habitatId, input.findingId);
    if (existing) {
      if (
        existing.resolution === input.resolution &&
        existing.resolutionKind === input.resolutionKind
      ) {
        // Same payload — replay
        const current = getByIdWithClient(client, input.findingId);
        return { outcome: "replayed" as const, value: current! };
      }
      return {
        outcome: "conflict" as const,
        reason: "different_payload" as ConflictReason,
        current: {
          existingResolution: existing.resolution,
          existingKind: existing.resolutionKind,
        },
      };
    }

    // Write terminal Finding state
    const now = new Date().toISOString();
    const updated = terminalizeWithClient(client, input.findingId, {
      status: "resolved",
      resolvedAt: now,
      resolvedByType: input.actor.type,
      resolvedById: input.actor.id,
      resolutionNote: input.resolution,
      updatedAt: now,
    });

    // Write exactly one Finding-sourced Resolution Record
    createResolutionWithClient(client, {
      habitatId: finding.habitatId,
      clusterKey: finding.clusterKey,
      skillCategory: "convention",
      source: "finding_triage",
      sourceId: input.findingId,
      rootCause: input.rootCause,
      resolution: input.resolution,
      resolutionKind: input.resolutionKind,
      resolvedByType: input.actor.type,
      resolvedById: input.actor.id,
    });

    return { outcome: "applied" as const, value: updated };
  }, db);

  if (outcome.outcome === "applied" || outcome.outcome === "replayed") {
    publishTerminalSse(outcome.value.habitatId, outcome.value.id, outcome.value.status);
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// markFindingWontfix
// ---------------------------------------------------------------------------

/**
 * Marks a finding as wontfix (human-only). Writes terminal `wontfix` status and
 * exactly one Finding-sourced Resolution Record with kind `wontfix`.
 *
 * Non-empty reason required. Same payload replays; different payload conflicts.
 */
export function markFindingWontfix(
  input: WontfixFindingInput,
  db?: LifecycleDbClient,
): LifecycleOutcome<FindingTriage> {
  // Pre-transaction validation
  if (input.actor.type !== "human") {
    return { outcome: "conflict", reason: "not_authorized", current: "wontfix is human-only" };
  }
  if (!input.reason || input.reason.trim().length === 0) {
    return { outcome: "conflict", reason: "invalid_input", current: "non-empty reason required" };
  }

  const outcome = withImmediateLifecycleTransaction<FindingTriage>((client) => {
    const finding = getByIdWithClient(client, input.findingId);
    if (!finding) {
      return { outcome: "conflict" as const, reason: "not_found" as ConflictReason };
    }

    // Already resolved — cannot change to wontfix
    if (finding.status === "resolved") {
      return {
        outcome: "conflict" as const,
        reason: "terminal" as ConflictReason,
        current: finding.status,
      };
    }

    // Idempotency: check existing Finding-sourced Resolution
    const existing = findByFindingSourceWithClient(client, finding.habitatId, input.findingId);
    if (existing) {
      if (existing.resolution === input.reason && existing.resolutionKind === "wontfix") {
        const current = getByIdWithClient(client, input.findingId);
        return { outcome: "replayed" as const, value: current! };
      }
      return {
        outcome: "conflict" as const,
        reason: "different_payload" as ConflictReason,
        current: {
          existingResolution: existing.resolution,
          existingKind: existing.resolutionKind,
        },
      };
    }

    // Write terminal Finding state
    const now = new Date().toISOString();
    const updated = terminalizeWithClient(client, input.findingId, {
      status: "wontfix",
      resolvedAt: now,
      resolvedByType: input.actor.type,
      resolvedById: input.actor.id,
      resolutionNote: input.reason,
      updatedAt: now,
    });

    // Write exactly one Finding-sourced Resolution Record
    createResolutionWithClient(client, {
      habitatId: finding.habitatId,
      clusterKey: finding.clusterKey,
      skillCategory: "convention",
      source: "finding_triage",
      sourceId: input.findingId,
      resolution: input.reason,
      resolutionKind: "wontfix",
      resolvedByType: input.actor.type,
      resolvedById: input.actor.id,
    });

    return { outcome: "applied" as const, value: updated };
  }, db);

  if (outcome.outcome === "applied" || outcome.outcome === "replayed") {
    publishTerminalSse(outcome.value.habitatId, outcome.value.id, outcome.value.status);
  }

  return outcome;
}
