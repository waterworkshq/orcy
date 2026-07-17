/**
 * Canonical Task Publication Guard Re-Verify + Commit Authorization — PURE
 * read-only primitives (T3B Phase 3).
 *
 * These are the re-verify + commit-authorization primitives that T3C (atomic
 * publication) later composes INSIDE the publication transaction. Phase 3 does
 * NOT wire them into a tx — it just provides the pure read-only logic + checks.
 * Both primitives are callable inside any caller-supplied drizzle client (the
 * default `getDb()` client OR a `tx` from `db.transaction(cb)`); neither calls
 * `getDb()` (would escape the caller's transaction), opens its own transaction,
 * or emits effects.
 *
 * What this module does (Technical Plan § "Optimistic publication guard"):
 *
 *   1. {@link verifyPublicationGuard} — re-reads the current mutable state
 *      (Mission identity+version+status, Habitat existence, dependency
 *      snapshots, CURRENT enrollment fingerprint) and compares to the
 *      {@link PublicationGuard} captured at preparation/governance time. A
 *      mismatch rolls back without publication and re-prepares under the same
 *      pending attempt, reusing matching governance decisions.
 *   2. {@link authorizeCommitFromGovernance} — the stale-decision-revision
 *      check: for a `(guard, attemptId, prospectiveTaskId, proposal)`, confirm
 *      every CURRENTLY-enrolled interceptor has a recorded `allow` decision
 *      whose governance fingerprint matches the CURRENT enrollment. Only the
 *      matching revision authorizes commit; a stale revision (earlier
 *      fingerprint) does NOT; a veto denies; a missing decision denies.
 *
 * NO-ORIGIN-EXEMPTION (NON-NEGOTIABLE): neither primitive takes an
 * origin/exemption/bypass parameter. Workflow Recovery, Automation Rules,
 * plugins, schedules, imports, templates, and blocker clearance ALL traverse
 * the same gate once their adapters wire in (Story 2/3). Phase 3 enforces this
 * structurally (the signatures accept only `guard`/`input` + `db`) and with a
 * test that asserts no exemption seam exists.
 *
 * DORMANT: no production origin calls these yet. T3C is the sole intended
 * consumer.
 *
 * See: Task Creation and Clone Technical Plan § "Optimistic publication guard",
 * § "Stale-decision-revision"; ADR-0039 (managed runtime owns classification).
 */
import { eq, inArray } from "drizzle-orm";
import type { MissionStatus, TaskStatus } from "@orcy/shared";
import { missions, habitats, tasks } from "../db/schema/index.js";
import type { TaskPublicationDbClient } from "../repositories/taskPublication.js";
import {
  findGovernanceDecisionWithClient,
  type GovernanceDecisionRow,
} from "../repositories/taskPublicationGovernance.js";
import {
  ACTIVE_MISSION_STATUSES,
  PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER,
  type CanonicalTaskPublicationProposal,
  type PublicationGuard,
} from "./taskPublicationPreparation.js";
import {
  GOVERNED_EVENT,
  guardCarriesPhase1Sentinel,
  computeGovernanceFingerprint,
  freezeCurrentBatchAdmission,
  computeCurrentEnrollmentFingerprint,
  type FrozenBatchAdmissionSnapshot,
} from "./taskPublicationGovernance.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * One reason a guard re-verify produced a mismatch. `field` locates the
 * drift (dotted path for dependencies); `code` is the stable machine-readable
 * reason; `message` is human-readable.
 *
 * Mirrors the {@link PublicationError} closed-shape from Phase 1 so the
 * publication coordinator (T3C) can classify + surface re-verify mismatches
 * the same way it surfaces validation errors.
 */
export interface GuardMismatchReason {
  field: string;
  code: string;
  message: string;
}

/**
 * Closed re-verify result.
 *
 * Never throws for a re-verify DECISION — returns `{ outcome: "mismatch";
 * reasons }` carrying every detected drift. Infrastructure failures (a
 * repository throw) propagate as retryable transport errors; they are NOT
 * domain mismatches and must not be collapsed into this result. This mirrors
 * Phase 1's preparation contract ("validation DECISIONS never throw").
 */
export type GuardVerifyResult =
  | { outcome: "verified" }
  | { outcome: "mismatch"; reasons: GuardMismatchReason[] };

/**
 * Stable denial kind for T3C classification. `interceptorKey` is present when
 * the denial is attributable to a single enrolled interceptor (veto or missing
 * decision).
 */
export type CommitAuthorizationDenialKind =
  | "phase1_sentinel"
  | "stale_enrollment_fingerprint"
  | "missing_decision"
  | "veto";

/**
 * Closed commit-authorization result.
 *
 * Never throws for an authorization DECISION — a denial is returned for every
 * veto / missing / stale / sentinel case. Infrastructure failures (a ledger
 * read throw) propagate as retryable transport errors. This mirrors Phase 1/2's
 * "decisions never throw" contract.
 */
export type CommitAuthorizationResult =
  | { outcome: "authorized" }
  | {
      outcome: "denied";
      /** Stable machine-readable denial kind for T3C classification. */
      kind: CommitAuthorizationDenialKind;
      /** Human-readable reason. */
      reason: string;
      /** The interceptor that vetoed or is missing a decision (when applicable). */
      interceptorKey?: string;
    };

// ---------------------------------------------------------------------------
// Deliverable 1 — verifyPublicationGuard (PURE read-only re-verify)
// ---------------------------------------------------------------------------

/** Input for {@link verifyPublicationGuard}. */
export interface VerifyPublicationGuardInput {
  /**
   * The guard captured at preparation + stamped by governance. Re-verify
   * re-reads each mutable field and compares to this.
   */
  guard: PublicationGuard;
  /**
   * The caller-supplied drizzle client — the default `getDb()` client OR a
   * transactional `tx` from `db.transaction(cb)`. Re-verify reads through this
   * client so it observes the tx-consistent snapshot T3C will commit under.
   */
  db: TaskPublicationDbClient;
}

/**
 * Re-verify a publication guard against the CURRENT mutable state. PURE
 * read-only — performs no writes and emits no effects.
 *
 * Re-reads each guard field and compares:
 *   - **Sentinel** — a guard still carrying the Phase-1 placeholder is NEVER
 *     verified (it was never governed; cannot authorize commit).
 *   - **Mission** — re-read by `guard.missionId`; compare `version` (any
 *     mutation bumps it) and confirm `status` is still an
 *     {@link ACTIVE_MISSION_STATUSES} member (a Mission that went terminal /
 *     archived between governance and commit mismatches).
 *   - **Habitat** — re-read existence.
 *   - **Dependencies** — re-read each depended-on task; compare `version` +
 *     `status` to each `guard.dependencies` snapshot. A deleted or changed
 *     dependency mismatches.
 *   - **Enrollment fingerprint** — recompute the CURRENT `taskCreated`
 *     enrollment fingerprint (the SAME path governance-time `freezeBatchAdmission`
 *     takes) and compare to `guard.interceptorEnrollmentFingerprint`. Changed
 *     enrollment/configuration mismatches.
 *
 * Validation DECISIONS never throw — returns `{ outcome: "mismatch"; reasons }`
 * carrying every collected drift. Infrastructure failures (a repository throw)
 * propagate as retryable transport errors.
 *
 * NO-ORIGIN-EXEMPTION: this primitive accepts NO origin/exemption/bypass
 * parameter. Every origin traverses the same re-verify gate.
 */
export function verifyPublicationGuard(input: VerifyPublicationGuardInput): GuardVerifyResult {
  const { guard, db } = input;
  const reasons: GuardMismatchReason[] = [];

  // 1. Sentinel rejection — a guard never governed cannot authorize commit.
  if (guardCarriesPhase1Sentinel(guard)) {
    reasons.push({
      field: "interceptorEnrollmentFingerprint",
      code: "phase1_sentinel",
      message:
        "Guard still carries the Phase-1 interceptor-enrollment placeholder sentinel; it was never governed and cannot authorize commit.",
    });
    // The sentinel is definitive, but continue collecting other drifts so the
    // caller surfaces every defect in one round-trip (mirrors Phase 1).
  }

  // 2. Mission re-read (identity is implicit — read by guard.missionId).
  const mission = db.select().from(missions).where(eq(missions.id, guard.missionId)).get() as
    | {
        id: string;
        version: number;
        status: MissionStatus;
        isArchived: number | boolean;
        habitatId: string;
      }
    | undefined;

  if (!mission) {
    reasons.push({
      field: "missionId",
      code: "mission_not_found",
      message: `Mission "${guard.missionId}" no longer exists; the guard was captured against a Mission that has been deleted.`,
    });
  } else {
    if (mission.version !== guard.missionVersion) {
      reasons.push({
        field: "missionVersion",
        code: "mission_version_changed",
        message: `Mission "${guard.missionId}" version changed from ${guard.missionVersion} to ${mission.version} since governance.`,
      });
    }
    if (!ACTIVE_MISSION_STATUSES.has(mission.status)) {
      reasons.push({
        field: "missionStatus",
        code: "mission_status_inactive",
        message: `Mission "${guard.missionId}" status is "${mission.status}" (terminal); only ${[...ACTIVE_MISSION_STATUSES].join("|")} accept new Tasks.`,
      });
    }
    // isArchived is a separate gate (Phase 1 rejects archived; re-verify too).
    if (mission.isArchived) {
      reasons.push({
        field: "missionStatus",
        code: "mission_archived",
        message: `Mission "${guard.missionId}" is archived and does not accept new Task publication.`,
      });
    }
  }

  // 3. Habitat existence.
  const habitat = db.select().from(habitats).where(eq(habitats.id, guard.habitatId)).get();
  if (!habitat) {
    reasons.push({
      field: "habitatId",
      code: "habitat_not_found",
      message: `Habitat "${guard.habitatId}" no longer exists.`,
    });
  }

  // 4. Dependency re-read (version + status per depended-on task).
  if (guard.dependencies.length > 0) {
    const depIds = guard.dependencies.map((d) => d.taskId);
    const depRows = db
      .select({ id: tasks.id, version: tasks.version, status: tasks.status })
      .from(tasks)
      .where(inArray(tasks.id, depIds))
      .all() as Array<{ id: string; version: number; status: TaskStatus }>;
    const depById = new Map(depRows.map((r) => [r.id, r]));
    for (const snap of guard.dependencies) {
      const row = depById.get(snap.taskId);
      if (!row) {
        reasons.push({
          field: `dependencies.${snap.taskId}`,
          code: "dependency_deleted",
          message: `Selected dependency "${snap.taskId}" was deleted since governance.`,
        });
        continue;
      }
      if (row.version !== snap.version) {
        reasons.push({
          field: `dependencies.${snap.taskId}`,
          code: "dependency_version_changed",
          message: `Dependency "${snap.taskId}" version changed from ${snap.version} to ${row.version} since governance.`,
        });
      }
      if (row.status !== snap.status) {
        reasons.push({
          field: `dependencies.${snap.taskId}`,
          code: "dependency_status_changed",
          message: `Dependency "${snap.taskId}" status changed from "${snap.status}" to "${row.status}" since governance.`,
        });
      }
    }
  }

  // 5. Enrollment fingerprint — recompute the CURRENT fingerprint and compare.
  //    This mirrors the governance-time freezeBatchAdmission path exactly
  //    (snapshotEnrolledPreInterceptors + freezeInterceptorEntry +
  //    computeEnrollmentFingerprint) via the additive computeCurrentEnrollment-
  //    Fingerprint helper. A changed enrollment/configuration set mismatches.
  const currentEnrollmentFingerprint = computeCurrentEnrollmentFingerprint(guard.habitatId);
  if (currentEnrollmentFingerprint !== guard.interceptorEnrollmentFingerprint) {
    reasons.push({
      field: "interceptorEnrollmentFingerprint",
      code: "enrollment_fingerprint_changed",
      message:
        "Interceptor enrollment/configuration changed between governance and commit (the current enrollment fingerprint does not match the guard).",
    });
  }

  if (reasons.length > 0) {
    return { outcome: "mismatch", reasons };
  }
  return { outcome: "verified" };
}

// ---------------------------------------------------------------------------
// Deliverable 2 — authorizeCommitFromGovernance (stale-decision-revision check)
// ---------------------------------------------------------------------------

/** Input for {@link authorizeCommitFromGovernance}. */
export interface AuthorizeCommitFromGovernanceInput {
  /**
   * The guard captured at preparation + stamped by governance. The guard's
   * `interceptorEnrollmentFingerprint` is the revision token: only decisions
   * recorded under a governance fingerprint computed with THIS enrollment
   * fingerprint authorize commit.
   */
  guard: PublicationGuard;
  /** The attempt whose ledger holds the recorded decisions. */
  attemptId: string;
  /** The prospective Task whose decisions are being authorized. */
  prospectiveTaskId: string;
  /**
   * The canonical prepared proposal being committed. The governance
   * fingerprint covers the proposal, so this MUST be the CURRENT proposal the
   * publication tx is committing — a decision recorded under a different
   * (stale) proposal's fingerprint will NOT be found and authorization is
   * denied.
   */
  proposal: CanonicalTaskPublicationProposal;
  /**
   * The caller-supplied drizzle client — the default `getDb()` client OR a
   * transactional `tx`. Ledger reads go through this client so they observe
   * the tx-consistent snapshot.
   */
  db: TaskPublicationDbClient;
}

/**
 * The stale-decision-revision authorization check — PURE read-only.
 *
 * For a `(guard, attemptId, prospectiveTaskId, proposal)`: confirm EVERY
 * currently-enrolled interceptor has a recorded `allow` decision whose
 * governance fingerprint matches the CURRENT enrollment/configuration state.
 *
 * How it distinguishes a matching revision from a stale one: it re-freezes the
 * CURRENT batch admission (the SAME path governance-time `freezeBatchAdmission`
 * takes) and recomputes each interceptor's governance fingerprint via
 * {@link computeGovernanceFingerprint} (proposal + guard + interceptor +
 * frozenAdmission). It then looks up the decision by the EXACT ledger key
 * `(attemptId, prospectiveTaskId, interceptorKey, governanceFingerprint)`:
 *   - a decision recorded under an EARLIER enrollment/proposal/admission (a
 *     stale revision) produces a DIFFERENT governance fingerprint → the lookup
 *     MISSES → denied (`missing_decision`). Only the revision matching the
 *     CURRENT state is found → if `allow`, authorized.
 *   - a veto decision (explicit or failure) at the matching fingerprint →
 *     denied (`veto`) with the recorded reason.
 *   - an enrolled interceptor with NO recorded decision → denied
 *     (`missing_decision`).
 *
 * Short-circuit: if the CURRENT enrollment fingerprint does not match the
 * guard's, EVERY recomputed governance fingerprint will miss — denied early
 * with `stale_enrollment_fingerprint` (clearer than N per-interceptor misses).
 *
 * Validation DECISIONS never throw — returns `{ outcome: "denied" }` for every
 * denial case. Infrastructure failures (a ledger read throw) propagate.
 *
 * NO-ORIGIN-EXEMPTION: this primitive accepts NO origin/exemption/bypass
 * parameter. Every origin traverses the same authorization gate.
 */
export function authorizeCommitFromGovernance(
  input: AuthorizeCommitFromGovernanceInput,
): CommitAuthorizationResult {
  const { guard, attemptId, prospectiveTaskId, proposal, db } = input;

  // 1. Sentinel — a guard never governed cannot authorize commit.
  if (guardCarriesPhase1Sentinel(guard)) {
    return {
      outcome: "denied",
      kind: "phase1_sentinel",
      reason:
        "Guard still carries the Phase-1 interceptor-enrollment placeholder sentinel; it was never governed and cannot authorize commit.",
    };
  }

  // 2. Re-freeze the CURRENT batch admission (mirrors governance-time freeze).
  //    Used to recompute per-interceptor governance fingerprints against the
  //    live enrollment/configuration state. The frozen snapshot's
  //    `enrollmentFingerprint` is the revision token.
  const frozenAdmission: FrozenBatchAdmissionSnapshot = freezeCurrentBatchAdmission(
    guard.habitatId,
  );

  // 3. Stale-enrollment short-circuit: if the current enrollment fingerprint
  //    does not match the guard's, EVERY recomputed governance fingerprint
  //    will miss (decisions were recorded under the guard's earlier
  //    fingerprint). Deny early with a clear kind.
  if (frozenAdmission.enrollmentFingerprint !== guard.interceptorEnrollmentFingerprint) {
    return {
      outcome: "denied",
      kind: "stale_enrollment_fingerprint",
      reason:
        "Current interceptor enrollment/configuration does not match the guard's fingerprint; recorded decisions are under a stale revision and cannot authorize commit.",
    };
  }

  // 4. For each currently-enrolled interceptor: recompute the governance
  //    fingerprint against the CURRENT proposal + guard + frozenAdmission,
  //    look up the ledger decision, and require `allow`. First denial
  //    short-circuits (the decisive denial for THIS Task).
  for (const interceptor of frozenAdmission.enrolled) {
    const governanceFingerprint = computeGovernanceFingerprint({
      proposal,
      guard,
      interceptor,
      frozenAdmission,
    });

    const decision: GovernanceDecisionRow | null = findGovernanceDecisionWithClient(db, {
      attemptId,
      prospectiveTaskId,
      interceptorKey: interceptor.interceptorKey,
      governanceFingerprint,
    });

    if (!decision) {
      // No recorded decision under the CURRENT governance fingerprint → a
      // stale revision (recorded under an earlier fingerprint) or a Task that
      // was never governed. Either way, cannot authorize commit.
      return {
        outcome: "denied",
        kind: "missing_decision",
        reason: `No allow decision recorded for interceptor "${interceptor.interceptorKey}" under the current governance revision (attempt "${attemptId}", prospective Task "${prospectiveTaskId}").`,
        interceptorKey: interceptor.interceptorKey,
      };
    }

    if (decision.decision !== "allow") {
      // A veto (explicit or failure) at the matching fingerprint denies. The
      // human-readable reason travels in diagnostics.reason (JSON column typed
      // Record<string, unknown> at the schema level; coerce to string).
      const diag = decision.diagnostics;
      const recordedReason = diag && typeof diag.reason === "string" ? diag.reason : undefined;
      const vetoReason =
        recordedReason ?? `Interceptor "${interceptor.interceptorKey}" vetoed publication.`;
      return {
        outcome: "denied",
        kind: "veto",
        reason: vetoReason,
        interceptorKey: interceptor.interceptorKey,
      };
    }
    // `allow` — continue to the next enrolled interceptor.
  }

  // Every currently-enrolled interceptor has a matching `allow` decision.
  return { outcome: "authorized" };
}

// ---------------------------------------------------------------------------
// No-origin-exemption structural enforcement (re-exported for the assertion
// test — confirms the sentinel constant is the ONLY thing the primitives
// compare against, and that the public signatures carry NO exemption seam)
// ---------------------------------------------------------------------------

/**
 * The Phase-1 sentinel constant, re-exported here so the no-exemption test can
 * assert the primitives reject ONLY on the sentinel (not on any origin flag).
 */
export { PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER };
