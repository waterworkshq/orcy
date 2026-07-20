/**
 * T10A Milestone 4 — Preflight Pipeline + PreparedImport + Authority Separation.
 *
 * Composes M1's manifest v3 types + import-attempt repo, M2's declared legacy
 * adapter, and M3's 8 domain handlers into a single PURE pipeline producing the
 * immutable {@link PreparedImport} consumed by T10B's atomic transaction
 * (`publishImportAggregateWithClient`). After M4, T10A is functionally
 * complete: a v3 manifest (or a v1/v2 input routed through the adapter) flows
 * end-to-end through preflight and produces the prepared object T10B applies.
 *
 * # Architecture
 *
 *   {@link prepareImport} — the entry point. Composes:
 *     1. Dormancy gate ({@link isCreationPublicationEnabled} — the flag is OFF
 *        by default; the legacy `importHabitat` path stays byte-identical +
 *        active until T11 flips it).
 *     2. Version detection + adapter dispatch (M2's {@link adaptUnknown}).
 *     3. Strict v3 zod schema parse (defensive — rejects gross malformations).
 *     4. Manifest digest + summary computation (the prepared basis).
 *     5. {@link reserveImportAttempt} — the BEGIN IMMEDIATE reservation tx
 *        (parallel to `reserveScheduledOccurrence`). Reserves the import
 *        attempt row + the coordination attempt + stamps the link, atomically.
 *     6. {@link runPreflightPipeline} — PURE except for the accepted
 *        governance-ledger exception: authority check, per-domain validate,
 *        IdentityMap build, reference resolution, prospective governance,
 *        guard capture. Step 6 (prospective governance) writes governance
 *        decision-ledger rows via `recordGovernanceDecisionWithClient` (the
 *        T3B-2 reusable-decision pattern, same as T9A). These ledger rows are
 *        the durable cache that makes identical re-preparation reuse
 *        decisions; they are part of the kernel's governance contract, not
 *        a violation of "preflight is read-only." Every other step is read-
 *        only.
 *     7. Outcome — success → {@link PreparedImport}; failure →
 *        {@link terminalRejectImportAttemptWithCoordination} +
 *        `{outcome:"rejected_preflight"}`.
 *
 *   {@link runPreflightPipeline} — PURE except for the accepted governance-
 *     ledger exception. The 6-step orchestrator that runs the M3 handlers in
 *     {@link MANIFEST_DOMAIN_NAMES} order (load-bearing — drift #8: the
 *     mission handler's `resolveReferences` does cross-domain column lookup
 *     against the idMap populated by `columns.prepare`). Returns either the
 *     prepared import body (without prefilledAttemptId) or the accumulated
 *     {@link ManifestDomainError} list.
 *
 * # Authority-separation contract (three checks)
 *
 * The T10A ticket separates three checks the v0.31 patches conflated. M4
 * enforces (b) + (c); (a) is T10C's route-middleware concern:
 *   (a) Caller authorization to target habitat — T10C wires
 *       `requireHabitatAccess` on the replacement route.
 *   (b) Manifest completeness + declared destructive intent — preflight step
 *       (2). Every declared domain carries an explicit `replace | preserve |
 *       reset`; legacy v1/v2 are remap-only; `restore` requires same-lineage
 *       proof. The v0.31 nonempty-payload heuristic is retired.
 *   (c) Persisted-habitat governance over each proposed Task — preflight step
 *       (6) via {@link governTaskPublication} (prospective governance).
 *
 * # Dormancy (PRESERVE)
 *
 * The legacy `importHabitat` (`services/habitatService.ts:450-710`) + the
 * silent `z.preprocess` (`models/schemas.ts:265-280`) stay byte-identical +
 * active. This module has NO production caller until T11 flips
 * `ORCY_CREATION_PUBLICATION_ENABLED=true`. The new manifest path is exercised
 * only by tests until then.
 *
 * @see packages/api/src/services/importManifest/types.ts for the v3 manifest.
 * @see packages/api/src/services/importManifest/legacyAdapter.ts for M2.
 * @see packages/api/src/services/importManifest/domainHandlers/ for M3.
 * @see packages/api/src/repositories/importAttempts.ts for M1.
 * @see services/scheduledOccurrencePublication.ts:1362 for the terminal-reject
 *      precedent (`terminalRejectOccurrenceWithCoordination`).
 * @see repositories/scheduledOccurrenceReservation.ts:624 for the BEGIN
 *      IMMEDIATE reservation precedent (`reserveScheduledOccurrence`).
 */
import { createHash, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { AuditActorRef, AuditSource, CausalContext } from "@orcy/shared";

import { getDb } from "../../db/index.js";
import {
  columns,
  habitats,
  missionDependencies,
  missionTemplates,
  missions,
  taskComments,
  taskDependencies,
  taskSubtasks,
  tasks,
} from "../../db/schema/index.js";
import type {
  AttemptTerminalResult,
  TaskPublicationDbClient,
} from "../../repositories/taskPublication.js";
import { completeAttemptWithClient } from "../../repositories/taskPublication.js";
import { reserveAttemptWithClient } from "../../repositories/taskCreationAttempts.js";
import {
  markImportAttemptRejectedWithClient,
  reserveImportAttemptWithClient,
  setImportAttemptCoordinationAttemptIdWithClient,
  type ImportAttemptReservationResult,
  type ImportAttemptRow,
  type ImportAttemptSourceLineageJson,
  type ImportManifestSummaryJson,
} from "../../repositories/importAttempts.js";
import { isCreationPublicationEnabled } from "../../config/creationPublicationCutover.js";
import { governTaskPublication, type GovernanceBatchResult } from "../taskPublicationGovernance.js";
import {
  PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER,
  type CanonicalTaskPublicationProposal,
  type PublicationError,
  type PublicationGuard,
} from "../taskPublicationPreparation.js";
import { importManifestSchema } from "../../models/schemas.js";

import {
  AmbiguousLegacyTitleError,
  UnknownManifestVersion,
  adaptUnknown,
} from "./legacyAdapter.js";
import {
  MANIFEST_DOMAIN_NAMES,
  type ColumnPortable,
  type CommentPortable,
  type DependencyPortable,
  type DomainEnvelope,
  type HabitatImportManifest,
  type ManifestDomainName,
  type ManifestLineage,
  type MissionPortable,
  type SubtaskPortable,
  type TaskPortable,
} from "./types.js";
import {
  createIdentityMap,
  type CrossDomainState,
  type DomainHandler,
  type ExistingEntity,
  type ExistingHabitatSnapshot,
  type IdentityMap,
  type ManifestContext,
} from "./domainHandler.js";
import type { DomainError as ManifestDomainError } from "./domainHandler.js";

import {
  habitatSettingsHandler,
  type PreparedHabitatSettings,
} from "./domainHandlers/habitatSettings.js";
import { columnsHandler, type PreparedColumns } from "./domainHandlers/columns.js";
import { missionsHandler, type PreparedMissions } from "./domainHandlers/missions.js";
import { tasksHandler, type PreparedTasks } from "./domainHandlers/tasks.js";
import { subtasksHandler, type PreparedSubtasks } from "./domainHandlers/subtasks.js";
import { dependenciesHandler, type PreparedDependencies } from "./domainHandlers/dependencies.js";
import { commentsHandler, type PreparedComments } from "./domainHandlers/comments.js";
import { templatesHandler, type PreparedTemplates } from "./domainHandlers/templates.js";

// ===========================================================================
// Public types — PreparedImport + ImportPublicationGuard (T10B's input)
// ===========================================================================

/**
 * The captured snapshot of the publication target's mutable state. T10B's
 * `publishImportAggregateWithClient` re-verifies this IN-TX via the optimistic-
 * guard discipline (parallel to `verifyPublicationGuard`): a mismatch rolls
 * back without publication.
 *
 * M4 captures the snapshot; T10B verifies it. The snapshot is the PREPARED
 * BASIS — every field is read at preflight time + persisted on the
 * `import_attempts` row via `manifestDigest` + `manifestSummary`; T10B
 * re-reads live state inside its tx + compares.
 *
 * # `preserveDomainTargets` (M4 simplification)
 *
 * The map carries the DECLARED preserve-domain SET (the domain names that
 * carry `disposition:"preserve"`). For `mode:"new"` the map is empty (no
 * existing habitat). For `mode:"replacement"` the keys enumerate the preserve
 * domains; T10B materializes the entity IDs IN-TX (where it has the tx client
 * for consistent reads) + verifies they're untouched. The M4 snapshot
 * captures the INTENT; T10B materializes the targets.
 */
export interface ImportPublicationGuard {
  /**
   * The target habitat id. `null` for `mode:"new"` (allocated IN-TX by T10B);
   * the live habitat id for `mode:"replacement"`.
   */
  targetHabitatId: string | null;
  /**
   * The target habitat's optimistic-concurrency proxy — the live
   * `habitats.updatedAt` timestamp. `null` for `mode:"new"` (the habitat
   * doesn't exist yet); the live `updatedAt` for `mode:"replacement"` (read
   * once at preflight; T10B re-reads in-tx + compares).
   *
   * # Why `updatedAt` (not an integer `version`)
   *
   * The `habitats` table has NO integer `version` column (unlike `missions`
   * + `tasks`, which do). The pragmatic OCC proxy is the row's `updatedAt`
   * timestamp — T10B re-reads `updatedAt` in-tx + compares against this
   * snapshot. A mismatch indicates the habitat was mutated between preflight
   * + commit (a replacement race or a concurrent mutation); T10B rolls back.
   * The plan's "version: number" was an assumption about the schema that
   * turned out to be wrong for habitats; the timestamp is the honest proxy.
   */
  targetHabitatUpdatedAt: string | null;
  /**
   * Snapshot of the manifest's identity policy. T10B re-verify the in-tx
   * policy still matches (defense against an in-flight manifest revision).
   */
  identityPolicySnapshot: "remap" | "restore";
  /**
   * DECLARED preserve-domain set (see type doc). Empty for `mode:"new"`;
   * carries the declared preserve-domain keys for `mode:"replacement"`.
   * T10B materializes the entity IDs in-tx.
   */
  preserveDomainTargets: ReadonlyMap<ManifestDomainName, readonly string[]>;
  /**
   * SHA-256 of the canonical-stable-stringified manifest. T10B re-verifies
   * the prepared basis didn't drift between preflight + commit.
   */
  manifestDigest: string;
}

/**
 * The immutable envelope describing a fully prepared, governance-approved
 * habitat import. Consumed by T10B's `publishImportAggregateWithClient`
 * (mirrors `prepareTemplateAggregate`'s prepared-aggregate shape).
 *
 * # Immutability
 *
 * Every field is a snapshot taken at preflight time. The `manifest` is FROZEN
 * (its digest is on the guard); the `identityMap` is complete (every portable
 * entity has its prospective server id); `preparedDomains` carries the
 * resolved prepared graph (every cross-domain reference rewritten to a server
 * id); `guard` captures the publication target's mutable-state snapshot;
 * `governanceDecisions` carries each Task's decisive governance outcome
 * (T3B-2 ledger — reusable if T10B re-prepares under the same attempt).
 *
 * `prefilledAttemptId` is the import-level coordination attempt (parallel to
 * T9A-03's occurrence-level attempt). Per-Task attempts are reserved by T10B
 * (parallel to T9A's N-per-Task pattern at the publisher).
 */
export interface PreparedImport {
  /** The frozen manifest (its digest is on {@link ImportPublicationGuard}). */
  manifest: HabitatImportManifest;
  /** SHA-256 of the canonical-stable-stringified manifest. */
  manifestDigest: string;
  /** The complete source-local → prospective-server-id translation table. */
  identityMap: IdentityMap;
  /** The resolved prepared graph (every cross-domain reference rewritten). */
  preparedDomains: PreparedDomains;
  /** The publication-target snapshot T10B re-verifies in-tx. */
  guard: ImportPublicationGuard;
  /**
   * Per-Task governance outcomes from {@link governTaskPublication}. T10B
   * reuses the ledger decisions if it re-prepares under the same attempt.
   */
  governanceDecisions: GovernanceBatchResult["results"];
  /** Authority-context snapshot (who's driving + which policy governs). */
  authority: {
    caller: AuditActorRef;
    auditSource: AuditSource;
    /** `installation` for `mode:"new"`; `persisted_habitat` for `mode:"replacement"`. */
    governingPolicy: "installation" | "persisted_habitat";
  };
  /** The reserved coordination attempt id (parallel to T9A-03). */
  prefilledAttemptId: string;
  /**
   * The existing-habitat snapshot (drift #13 — T10B M3 populates this for
   * `mode:"replacement"`; null for `mode:"new"`). Carries the existing
   * portable entities keyed by server id, for the M2 orchestrator's
   * `ApplyContext.existingHabitatSnapshot` (downstream consumers — preserve-
   * domain skip logic, restore-id preservation).
   */
  existingHabitatSnapshot: ExistingHabitatSnapshot | null;
}

/**
 * The resolved prepared-domain graph. Every declared domain's prepared shape
 * is present (omitted domains stay undefined — preserve-by-default). Every
 * cross-domain reference has been rewritten to a server id by the
 * corresponding handler's `resolveReferences` phase.
 */
export interface PreparedDomains {
  habitatSettings?: PreparedHabitatSettings;
  columns?: PreparedColumns;
  missions?: PreparedMissions;
  tasks?: PreparedTasks;
  subtasks?: PreparedSubtasks;
  dependencies?: PreparedDependencies;
  comments?: PreparedComments;
  templates?: PreparedTemplates;
}

// ===========================================================================
// Entry-point input + outcome (the route / test surface)
// ===========================================================================

/**
 * Input for the entry point {@link prepareImport}. The route (T10C) constructs
 * this from the HTTP request + auth context; tests construct this directly.
 */
export interface PrepareImportInput {
  /**
   * The raw manifest input — may be v1 (`board`/`features`), v2
   * (`habitat.missions`), or v3 (already manifest-shape). Version detection
   * + adapter dispatch runs first; v1/v2 inputs are routed through M2's
   * adapter, v3 inputs pass through, unknown versions throw.
   */
  rawManifest: unknown;
  /**
   * The target habitat id. For `mode:"new"`: pass `null` to have the
   * orchestrator allocate a prospective id (T10B inserts the habitat with
   * this id in-tx) OR pass a caller-allocated prospective id. For
   * `mode:"replacement"`: the live habitat id (the route resolves access).
   */
  habitatId: string | null;
  /**
   * Optional manifestId override (defaults to the manifest's own manifestId;
   * for legacy v1/v2 inputs the adapter derives one). This is the
   * `import_attempts.id` primary key — the reservation tx uses it verbatim.
   */
  manifestId?: string;
  /**
   * Optional mode override. For v3 inputs, defaults to the manifest's declared
   * mode. For legacy v1/v2 (always adapted to `mode:"new"` by M2), the route
   * may override to `"replacement"`. The override is applied BEFORE the
   * digest computation, so the reserved row's digest reflects the resolved
   * mode.
   */
  mode?: "new" | "replacement";
  /** The actor driving the import (the route's auth context). */
  actor: AuditActorRef;
  /** The audit source for the import (e.g. `"rest_api"`). */
  auditSource: AuditSource;
}

/**
 * Closed outcome of {@link prepareImport}. Never throws for a domain decision;
 * only infrastructure failures (retryable transport) throw.
 *
 *   - `prepared`          — preflight succeeded; the {@link PreparedImport} is
 *                            ready for T10B's atomic transaction. The import
 *                            attempt stays `reserved` (T10B transitions it to
 *                            `publishing`).
 *   - `rejected_preflight` — preflight failed; the import attempt + the
 *                            coordination attempt terminalized as `rejected`
 *                            (import) + `rejected_validation` (coordination
 *                            attempt) atomically. `errors` carries every
 *                            accumulated failure (the plan's "no first-error
 *                            short-circuit" directive).
 *   - `feature_disabled`  — `ORCY_CREATION_PUBLICATION_ENABLED=false`; the
 *                            preflight refused + the legacy path is the active
 *                            production path. T11's route dispatch decides
 *                            whether to surface this sentinel or fall through
 *                            to the legacy route.
 *   - `already_exists`    — a prior reservation with the same manifestId
 *                            already exists. The caller reads the existing
 *                            row to decide next steps (replay, status poll,
 *                            or surface the conflict).
 */
export type PrepareImportOutcome =
  | { outcome: "prepared"; prepared: PreparedImport }
  | { outcome: "rejected_preflight"; errors: PublicationError[]; importAttemptId: string }
  | { outcome: "feature_disabled" }
  | { outcome: "already_exists"; attempt: ImportAttemptRow };

// ===========================================================================
// Internal: the handler registry (MANIFEST_DOMAIN_NAMES iteration order)
// ===========================================================================

/**
 * Static registry of the 8 M3 domain handlers, keyed by their
 * {@link ManifestDomainName}. Iterated in {@link MANIFEST_DOMAIN_NAMES} order
 * by the pipeline (load-bearing — drift #8: the mission handler's
 * `resolveReferences` reads cross-domain column server IDs from the idMap
 * populated by `columns.prepare`; running columns after missions would
 * produce unresolved-reference errors).
 *
 * Each handler is cast to `DomainHandler<unknown, unknown>` to erase the
 * per-domain generic params — the pipeline drives every handler uniformly
 * (validate / prepare / resolveReferences). The per-domain type narrowing
 * happens at the {@link PreparedDomains} construction site.
 */
const DOMAIN_HANDLERS: Readonly<Record<ManifestDomainName, DomainHandler<unknown, unknown>>> = {
  habitatSettings: habitatSettingsHandler as DomainHandler<unknown, unknown>,
  columns: columnsHandler as DomainHandler<unknown, unknown>,
  missions: missionsHandler as DomainHandler<unknown, unknown>,
  tasks: tasksHandler as DomainHandler<unknown, unknown>,
  subtasks: subtasksHandler as DomainHandler<unknown, unknown>,
  dependencies: dependenciesHandler as DomainHandler<unknown, unknown>,
  comments: commentsHandler as DomainHandler<unknown, unknown>,
  templates: templatesHandler as DomainHandler<unknown, unknown>,
};

/**
 * Sets the corresponding `crossDomainState.<domain>Envelope` field after the
 * domain's envelope has been presented to the pipeline. Downstream handlers
 * (the dependencies handler's cycle detection over the mission graph; the
 * missions handler's columnName validation against the columns set) read
 * these via `ctx.crossDomainState?.<field>`.
 *
 * `habitatSettings` + `templates` have no downstream consumers (their
 * envelopes are not exposed) — the switch is a no-op for them.
 *
 * The envelope is cast from `DomainEnvelope<unknown>` (the loose form
 * `manifest.domains[domainName]` yields) to the typed envelope each
 * downstream handler expects. The runtime payload is the manifest's data;
 * the cast is a TypeScript-narrowing convenience. The M3 handlers re-verify
 * the shape via their own `validate` phase.
 */
function exposeEnvelopeToCrossDomain(
  crossDomainState: CrossDomainState,
  domainName: ManifestDomainName,
  envelope: DomainEnvelope<unknown>,
): void {
  switch (domainName) {
    case "columns":
      crossDomainState.columnsEnvelope = envelope as DomainEnvelope<ColumnPortable[]>;
      return;
    case "missions":
      crossDomainState.missionsEnvelope = envelope as DomainEnvelope<MissionPortable[]>;
      return;
    case "tasks":
      crossDomainState.tasksEnvelope = envelope as DomainEnvelope<TaskPortable[]>;
      return;
    case "subtasks":
      crossDomainState.subtasksEnvelope = envelope as DomainEnvelope<SubtaskPortable[]>;
      return;
    case "dependencies":
      crossDomainState.dependenciesEnvelope = envelope as DomainEnvelope<DependencyPortable[]>;
      return;
    case "comments":
      crossDomainState.commentsEnvelope = envelope as DomainEnvelope<CommentPortable[]>;
      return;
    default:
      // habitatSettings + templates: no downstream consumers.
      return;
  }
}

/**
 * Stores a prepared domain under its typed key in {@link PreparedDomains}.
 * Mirrors `exposeEnvelopeToCrossDomain`'s switch — the per-domain type
 * narrowing happens here, at the construction site.
 */
function storePreparedDomain(
  prepared: PreparedDomains,
  domainName: ManifestDomainName,
  preparedPayload: unknown,
): void {
  switch (domainName) {
    case "habitatSettings":
      prepared.habitatSettings = preparedPayload as PreparedHabitatSettings;
      return;
    case "columns":
      prepared.columns = preparedPayload as PreparedColumns;
      return;
    case "missions":
      prepared.missions = preparedPayload as PreparedMissions;
      return;
    case "tasks":
      prepared.tasks = preparedPayload as PreparedTasks;
      return;
    case "subtasks":
      prepared.subtasks = preparedPayload as PreparedSubtasks;
      return;
    case "dependencies":
      prepared.dependencies = preparedPayload as PreparedDependencies;
      return;
    case "comments":
      prepared.comments = preparedPayload as PreparedComments;
      return;
    case "templates":
      prepared.templates = preparedPayload as PreparedTemplates;
      return;
  }
}

// ===========================================================================
// Step 1: Version detection + adapter dispatch (PURE)
// ===========================================================================

/**
 * The (manifest + warnings) shape returned by step 1. Either the adapter
 * produced a v3 manifest + warnings (legacy v1/v2 input) or the input was
 * already v3 (identity passthrough with empty warnings).
 */
export interface AdaptedInput {
  manifest: HabitatImportManifest;
  /** The C4 absorption warnings (per-task / per-mission / per-webhook / etc.). */
  warnings: string[];
  /**
   * `true` when the input was legacy v1/v2 (routed through M2's adapter).
   * `false` when the input was already v3 (identity passthrough). The
   * authority check uses this to enforce "legacy v1/v2 are remap-only".
   */
  wasLegacyInput: boolean;
}

/**
 * Step 1 — PURE. Detects the input version + dispatches:
 *   - `version:1` → M2's `adaptV1` (via {@link adaptUnknown}).
 *   - `version:2` → M2's `adaptV2` (via {@link adaptUnknown}).
 *   - `version:3` → identity passthrough (already v3).
 *   - anything else → throws {@link UnknownManifestVersion}.
 *
 * M2's `adaptUnknown` handles the v1/v2 cases; this wrapper adds the v3
 * passthrough (the adapter throws when called with `version:3` — its
 * contract is "legacy adaptation only", not "identity passthrough").
 *
 * @throws {UnknownManifestVersion} when `version` is not 1, 2, or 3.
 * @throws {AmbiguousLegacyTitleError} when M2's ambiguity detector fires.
 */
export function detectAndAdaptInput(rawManifest: unknown): AdaptedInput {
  if (rawManifest !== null && typeof rawManifest === "object" && !Array.isArray(rawManifest)) {
    const version = (rawManifest as { version?: unknown }).version;
    if (version === 3) {
      // Identity passthrough — already v3. The strict zod schema parse in
      // step 3 verifies the shape.
      const manifest = rawManifest as HabitatImportManifest;
      return { manifest, warnings: [], wasLegacyInput: false };
    }
    if (version === 1 || version === 2) {
      const adapted = adaptUnknown(rawManifest);
      return { manifest: adapted.manifest, warnings: adapted.warnings, wasLegacyInput: true };
    }
    throw new UnknownManifestVersion(version);
  }
  throw new UnknownManifestVersion(undefined);
}

// ===========================================================================
// Step 2: Authority check (manifest completeness + declared destructive intent)
// ===========================================================================

/**
 * Step 2 — PURE. Verifies manifest completeness + declared destructive intent.
 * This is authority check (b) of the three-check contract; route-level caller
 * authorization (a) is T10C; persisted-habitat governance (c) is step 6.
 *
 * Enforced rules (ALL accumulated — never first-error):
 *   - Legacy v1/v2 inputs are `remap`-only: `identityPolicy:"restore"` on a
 *     legacy-adapted manifest fails (legacy exports carry no lineage —
 *     restore requires same-lineage proof they cannot provide).
 *   - `identityPolicy:"restore"` requires `lineage.sourceHabitatId` non-null
 *     (the caller asserts same-lineage proof).
 *   - `identityPolicy:"restore"` identity semantics (drift #13 absorption):
 *     now that the preflight reads the existing-habitat snapshot, restore is
 *     a viable path for same-lineage manifests with collision-safe sourceIds.
 *     See {@link checkRestoreIdentitySemantics} for the cross-lineage +
 *     collision-refusal rules. The prior `restore_not_supported_until_snapshotting`
 *     refusal is RETIRED (T10B M3).
 *   - Every declared domain carries one of `replace | preserve | reset` (the
 *     schema enforces the enum; this is a redundant defense-in-depth check
 *     that surfaces a clear domain error rather than a zod error).
 *
 * Returns the accumulated {@link ManifestDomainError} list (empty when the
 * authority check passes).
 *
 * @param mode The resolved import mode (restored semantic checks are gated
 *        on `mode:"replacement"` — without an existing habitat, lineage
 *        cannot be verified).
 * @param existingHabitatSnapshot The snapshot captured by step 1.5 of the
 *        pipeline (null for `mode:"new"`). Carries the existing entities for
 *        collision detection.
 */
export function checkAuthority(
  input: AdaptedInput,
  mode: "new" | "replacement" = "new",
  existingHabitatSnapshot: ExistingHabitatSnapshot | null = null,
): ManifestDomainError[] {
  const errors: ManifestDomainError[] = [];
  const { manifest, wasLegacyInput } = input;

  // (b1) Legacy v1/v2 → remap-only.
  if (wasLegacyInput && manifest.identityPolicy === "restore") {
    errors.push(
      authorityError(
        "identityPolicy",
        "legacy_restore_forbidden",
        "Legacy v1/v2 inputs are remap-only (B3): they carry no source lineage, so identityPolicy:'restore' is forbidden. Re-submit with identityPolicy:'remap'.",
        { actual: manifest.identityPolicy },
      ),
    );
  }

  // (b2) restore requires non-null sourceHabitatId.
  if (manifest.identityPolicy === "restore" && manifest.lineage.sourceHabitatId === null) {
    errors.push(
      authorityError(
        "lineage.sourceHabitatId",
        "restore_requires_source_habitat",
        "identityPolicy:'restore' requires lineage.sourceHabitatId to be non-null (the caller asserts same-lineage proof).",
        { actual: null },
      ),
    );
  }

  // (b3) restore identity semantics — replaces the prior
  //      `restore_not_supported_until_snapshotting` refusal (drift #13).
  //      Now that the preflight captures the existing-habitat snapshot for
  //      mode:"replacement", restore is a viable path. The semantic checks
  //      verify same-lineage + collision-safe sourceId preservation.
  errors.push(
    ...checkRestoreIdentitySemantics(manifest, wasLegacyInput, mode, existingHabitatSnapshot),
  );

  // (b4) Disposition validity per declared domain (defense-in-depth — the
  //      schema + the M3 handlers also enforce this). An unsupported disposition
  //      surfaces here as a clear authority error before any handler runs.
  for (const domainName of MANIFEST_DOMAIN_NAMES) {
    const envelope = manifest.domains[domainName];
    if (envelope === undefined) continue;
    const d = envelope.disposition;
    if (d !== "replace" && d !== "preserve" && d !== "reset") {
      errors.push(
        authorityError(
          `domains.${domainName}.disposition`,
          "unsupported_disposition",
          `Domain '${domainName}' carries unsupported disposition '${String(d)}' (must be replace | preserve | reset).`,
          { actual: d, fieldPath: ["domains", domainName, "disposition"] },
        ),
      );
    }
  }

  return errors;
}

// ===========================================================================
// Step 1.5: Existing-habitat snapshot (PURE read; mode:"replacement" only)
// ===========================================================================

/**
 * Reads the existing habitat's portable state into a snapshot for
 * `mode:"replacement"` imports. PURE — no writes, no side effects.
 *
 * The snapshot is the basis for:
 *   - `restore` identity semantics (collision detection — every declared
 *     sourceId must match an existing entity's serverId; drift #13).
 *   - `preserveDomainTargets` materialization (drift #12 — the entity IDs
 *     the orchestrator must skip during the apply tx).
 *   - `ManifestContext.existingHabitatSnapshot` for the handlers' validate /
 *     prepare / resolveReferences phases.
 *
 * # Source-key convention
 *
 * Each existing entity is keyed by its server-side id. For restore-mode
 * manifests (the only path that consumes the collision check), the manifest's
 * sourceIds ARE the existing entities' serverIds (restore preserves IDs).
 * For composite-keyed tables (`mission_dependencies`, `task_dependencies` —
 * no `id` column), the source-key is synthesized as `"${parentId}->${dependsOnId}"`
 * so a restore-mode manifest can reference individual edges deterministically.
 *
 * # The `version` field (drift #11)
 *
 * The `habitats` table has NO integer `version` column (unlike `missions` +
 * `tasks`, which do). The snapshot's `version` is therefore vestigial — set
 * to `0`. The OCC token lives on {@link ImportPublicationGuard.targetHabitatUpdatedAt}
 * (a string timestamp), captured separately by {@link capturePublicationGuard}.
 *
 * # Gating
 *
 * Called only when `mode:"replacement"` + the dormancy flag is on + habitatId
 * is non-null. For `mode:"new"` the snapshot stays null (no existing habitat
 * to read).
 *
 * # Mission comments
 *
 * The portable `comments` domain carries task-scoped comments only (per the
 * {@link CommentPortable} shape). Mission comments are NOT in the portable
 * set + are excluded from the snapshot.
 *
 * # Global templates
 *
 * The portable `templates` domain carries habitat-scoped templates only.
 * Global templates (`missionTemplates.habitatId IS NULL`) are NOT habitat-
 * portable + are excluded from the snapshot.
 */
function readExistingHabitatSnapshot(habitatId: string): ExistingHabitatSnapshot {
  const db = getDb();
  const entitiesBySourceKey = new Map<string, ExistingEntity>();

  // Columns.
  const existingColumns = db.select().from(columns).where(eq(columns.habitatId, habitatId)).all();
  for (const col of existingColumns) {
    entitiesBySourceKey.set(col.id, {
      serverId: col.id,
      domain: "columns",
      displayName: col.name,
    });
  }

  // Missions.
  const existingMissions = db
    .select()
    .from(missions)
    .where(eq(missions.habitatId, habitatId))
    .all();
  for (const m of existingMissions) {
    entitiesBySourceKey.set(m.id, {
      serverId: m.id,
      domain: "missions",
      displayName: m.title,
    });
  }
  const missionIds = existingMissions.map((m) => m.id);

  // Tasks (via the habitat's missions).
  const existingTasks =
    missionIds.length > 0
      ? db.select().from(tasks).where(inArray(tasks.missionId, missionIds)).all()
      : [];
  for (const t of existingTasks) {
    entitiesBySourceKey.set(t.id, {
      serverId: t.id,
      domain: "tasks",
      displayName: t.title,
    });
  }
  const taskIds = existingTasks.map((t) => t.id);

  // Subtasks (via the habitat's tasks).
  const existingSubtasks =
    taskIds.length > 0
      ? db.select().from(taskSubtasks).where(inArray(taskSubtasks.taskId, taskIds)).all()
      : [];
  for (const s of existingSubtasks) {
    entitiesBySourceKey.set(s.id, {
      serverId: s.id,
      domain: "subtasks",
    });
  }

  // Comments (task-scoped only — see docstring).
  const existingComments =
    taskIds.length > 0
      ? db.select().from(taskComments).where(inArray(taskComments.taskId, taskIds)).all()
      : [];
  for (const c of existingComments) {
    entitiesBySourceKey.set(c.id, {
      serverId: c.id,
      domain: "comments",
    });
  }

  // Task-level dependency edges (composite-keyed — synthesize
  // `${taskId}->${dependsOnId}` as the source-key).
  const existingTaskDeps =
    taskIds.length > 0
      ? db.select().from(taskDependencies).where(inArray(taskDependencies.taskId, taskIds)).all()
      : [];
  for (const d of existingTaskDeps) {
    const synKey = `${d.taskId}->${d.dependsOnId}`;
    entitiesBySourceKey.set(synKey, {
      serverId: synKey,
      domain: "dependencies",
    });
  }

  // Mission-level dependency edges (composite-keyed — synthesize
  // `${missionId}->${dependsOnId}` as the source-key).
  const existingMissionDeps =
    missionIds.length > 0
      ? db
          .select()
          .from(missionDependencies)
          .where(inArray(missionDependencies.missionId, missionIds))
          .all()
      : [];
  for (const d of existingMissionDeps) {
    const synKey = `${d.missionId}->${d.dependsOnId}`;
    entitiesBySourceKey.set(synKey, {
      serverId: synKey,
      domain: "dependencies",
    });
  }

  // Templates (habitat-scoped only — see docstring).
  const existingTemplates = db
    .select()
    .from(missionTemplates)
    .where(eq(missionTemplates.habitatId, habitatId))
    .all();
  for (const t of existingTemplates) {
    entitiesBySourceKey.set(t.id, {
      serverId: t.id,
      domain: "templates",
      displayName: t.name,
    });
  }

  return {
    habitatId,
    // Vestigial — `habitats` has no integer `version` column (drift #11).
    // The OCC token lives on `ImportPublicationGuard.targetHabitatUpdatedAt`.
    version: 0,
    entitiesBySourceKey,
  };
}

// ===========================================================================
// Step 2b: restore identity semantics (drift #13 absorption)
// ===========================================================================

/**
 * (b3-restored) — replaces the prior `restore_not_supported_until_snapshotting`
 * refusal. Now that the preflight captures the existing-habitat snapshot
 * ({@link readExistingHabitatSnapshot}), restore is a viable (if rare) path
 * with same-lineage verification + collision-safe ID preservation.
 *
 * # Rules (ALL accumulated — never first-error)
 *
 *   - Skipped entirely when `identityPolicy !== "restore"` (no-op for `remap`).
 *   - Skipped when `wasLegacyInput === true` — legacy inputs are already
 *     blocked by (b1); running these checks would produce redundant secondary
 *     errors for the same root cause.
 *   - **(b3a) Same-lineage proof:** if no snapshot was captured (mode:"new"
 *     OR no existing habitat) OR `manifest.lineage.sourceHabitatId !==
 *     snapshot.habitatId` → reject with `restore_cross_lineage`. Restore
 *     mode requires the caller to prove the manifest came from the same
 *     habitat lineage; cross-lineage restore would silently re-stamp
 *     foreign IDs onto local entities.
 *   - **(b3b) Collision-safe ID preservation:** for every declared entity
 *     in each portable domain, the sourceId MUST be present in the snapshot
 *     (filtered by domain). Non-matching sourceIds → reject with
 *     `restore_collision`. Restore mode NEVER silently remaps — that would
 *     be the silent-normalization defect class. The caller must either
 *     remove the unmatched entity OR re-submit with `identityPolicy:"remap"`.
 *
 * Returns the accumulated {@link ManifestDomainError} list (empty when
 * restore semantics pass OR when restore is not in play).
 */
function checkRestoreIdentitySemantics(
  manifest: HabitatImportManifest,
  wasLegacyInput: boolean,
  mode: "new" | "replacement",
  existingHabitatSnapshot: ExistingHabitatSnapshot | null,
): ManifestDomainError[] {
  if (manifest.identityPolicy !== "restore") return [];
  // Legacy inputs are already blocked by (b1) — skip to avoid redundant errors.
  if (wasLegacyInput) return [];

  const errors: ManifestDomainError[] = [];

  // (b3a) Same-lineage proof — requires a snapshot whose habitatId matches
  //       the manifest's lineage.sourceHabitatId.
  if (
    existingHabitatSnapshot === null ||
    manifest.lineage.sourceHabitatId !== existingHabitatSnapshot.habitatId
  ) {
    const reason =
      existingHabitatSnapshot === null
        ? "identityPolicy:'restore' requires an existing target habitat (mode:'replacement' with a live habitatId); no existing-habitat snapshot was captured."
        : `identityPolicy:'restore' requires lineage.sourceHabitatId ('${manifest.lineage.sourceHabitatId ?? "null"}') to match the existing habitat's id ('${existingHabitatSnapshot.habitatId}'). Cross-lineage restore is forbidden; use identityPolicy:'remap' for cross-habitat imports.`;
    errors.push(
      authorityError("lineage.sourceHabitatId", "restore_cross_lineage", reason, {
        actual: manifest.lineage.sourceHabitatId,
      }),
    );
    // Without a matching snapshot, the collision check cannot run.
    return errors;
  }

  // (b3b) Collision-safe ID preservation — every declared sourceId MUST
  //       match an existing entity in the snapshot (filtered by domain).
  //       Index the snapshot by domain for the lookup.
  const snapshotByDomain = new Map<string, Set<string>>();
  for (const entity of existingHabitatSnapshot.entitiesBySourceKey.values()) {
    const set = snapshotByDomain.get(entity.domain) ?? new Set<string>();
    set.add(entity.serverId);
    snapshotByDomain.set(entity.domain, set);
  }

  for (const domainName of MANIFEST_DOMAIN_NAMES) {
    const envelope = manifest.domains[domainName];
    if (envelope === undefined) continue;
    // Skip singleton domains (habitatSettings) — no sourceId collision concept.
    if (!Array.isArray(envelope.data)) continue;
    const snapshotSet = snapshotByDomain.get(domainName) ?? new Set<string>();
    for (const entity of envelope.data as Array<{ sourceId?: unknown }>) {
      if (entity === null || typeof entity !== "object") continue;
      const sourceId = (entity as { sourceId?: unknown }).sourceId;
      if (typeof sourceId !== "string") continue;
      if (!snapshotSet.has(sourceId)) {
        errors.push(
          authorityError(
            `domains.${domainName}.data[].sourceId`,
            "restore_collision",
            `identityPolicy:'restore' requires every declared sourceId to match an existing entity in the target habitat. '${sourceId}' (domain: ${domainName}) has no matching entity; restore mode does not silently remap. Re-submit with identityPolicy:'remap' to allow fresh ID allocation, or remove the unmatched entity from the manifest.`,
            { actual: sourceId, fieldPath: ["domains", domainName, "data", "sourceId"] },
          ),
        );
      }
    }
  }

  return errors;
}

// ===========================================================================
// Step 3-5: Per-domain validate + IdentityMap build + reference resolution
//           (PURE — no DB writes; runs handlers in MANIFEST_DOMAIN_NAMES order)
// ===========================================================================

/**
 * Intermediate result for one domain's pipeline pass. The handler runs
 * validate → prepare → resolveReferences; the outcomes are collected here.
 */
interface DomainPipelinePass {
  readonly domainName: ManifestDomainName;
  /** `null` when validate / prepare / resolveReferences succeeded. */
  readonly errors: readonly ManifestDomainError[];
  /** The resolved prepared payload (set when the whole pass succeeded). */
  readonly prepared: unknown;
}

/**
 * Runs ONE domain's three phases against the shared ctx + idMap. Accumulates
 * EVERY error produced across the three phases (per the plan's "accumulate
 * ALL independently discoverable failures" directive — never first-error).
 *
 * # Phase short-circuit (within a single domain)
 *
 * If `validate` fails, `prepare` + `resolveReferences` are SKIPPED for THIS
 * domain — they cannot run against invalid input. This per-domain short-
 * circuit does NOT violate the accumulate-all directive: OTHER domains
 * continue to run their full three phases + collect their own errors. The
 * directive is "across domains, surface every independently discoverable
 * failure"; within ONE domain, downstream phases are gated on upstream
 * success.
 */
function runDomainPipeline(
  domainName: ManifestDomainName,
  envelope: DomainEnvelope<unknown>,
  ctx: ManifestContext,
  idMap: IdentityMap,
): DomainPipelinePass {
  const handler = DOMAIN_HANDLERS[domainName];
  const errors: ManifestDomainError[] = [];

  // 1. Validate.
  const validationResult = handler.validate(envelope, ctx, idMap);
  if (!validationResult.ok) {
    errors.push(...validationResult.errors);
    return { domainName, errors, prepared: null };
  }

  // 2. Prepare (PURE — allocates prospective server IDs into the shared idMap).
  const prepared = handler.prepare(validationResult.validated, ctx, idMap);

  // 3. Resolve references (PURE — rewrites sourceIds → server IDs against the
  //    now-complete idMap; this domain may read server IDs allocated by
  //    upstream domains' prepare phases).
  const resolutionResult = handler.resolveReferences(prepared, ctx, idMap);
  if (!resolutionResult.ok) {
    errors.push(...resolutionResult.errors);
    return { domainName, errors, prepared: null };
  }

  return { domainName, errors, prepared: resolutionResult.resolved };
}

// ===========================================================================
// Step 6: Prospective governance + guard capture
// ===========================================================================

/** The causal-root type for habitat imports (stamped on every Task proposal). */
const IMPORT_CAUSAL_ROOT_TYPE = "habitat_import";

/**
 * Step 6a — builds the per-Task {@link CanonicalTaskPublicationProposal} +
 * {@link PublicationGuard} pairs from the resolved prepared Task + Mission
 * graphs. Mirrors `prepareTemplateAggregate`'s per-Task construction
 * (`templateAggregatePreparation.ts:599-652`).
 *
 * # Prospective mission snapshot
 *
 * Every mission in an import is PROSPECTIVE — the missions do not exist at
 * preflight time. T10B inserts the missions BEFORE re-verifying these guards
 * inside the aggregate tx, so the snapshot captures the post-insert state:
 *   - `missionVersion: 1` (the first committed version).
 *   - `missionStatus: "not_started"` (MissionPortable has no status slot;
 *     imports always start missions at `not_started`).
 *   - `dependencies: []` (the prospective mission has no inbound dependencies
 *     yet — the dependency edges are applied AFTER the missions exist).
 *
 * The prospective `targetMissionId` is the resolved `missionServerId`
 * allocated by `missions.prepare` + rewritten by `missions.resolveReferences`.
 *
 * Returns `null` when the prepared Tasks graph is missing or empty
 * (governance is skipped — nothing to govern). When the Tasks graph has
 * Tasks whose `missionServerId` is still null (the missions resolveReferences
 * failed), those Tasks are EXCLUDED from governance (they'll surface as
 * unresolved-reference errors from step 5).
 */
function buildGovernanceProposals(
  preparedDomains: PreparedDomains,
  habitatId: string,
  actor: AuditActorRef,
  auditSource: AuditSource,
  causalContext: CausalContext,
): Array<{ proposal: CanonicalTaskPublicationProposal; guard: PublicationGuard }> | null {
  const tasks = preparedDomains.tasks?.tasks;
  const missions = preparedDomains.missions?.missions;
  if (!tasks || tasks.length === 0) return null;
  const missionByServerId = new Map((missions ?? []).map((m) => [m.missionServerId, m]));

  const proposals: Array<{ proposal: CanonicalTaskPublicationProposal; guard: PublicationGuard }> =
    [];
  for (const task of tasks) {
    // Skip Tasks whose mission didn't resolve — they surface as unresolved-
    // reference errors from step 5 (no point governing a Task whose target
    // mission is unknown).
    if (!task.missionServerId) continue;
    const mission = missionByServerId.get(task.missionServerId);
    if (!mission) continue;

    const proposal: CanonicalTaskPublicationProposal = {
      prospectiveTaskId: task.taskServerId,
      habitatId,
      targetMissionId: task.missionServerId,
      title: task.title,
      description: task.description,
      priority: task.priority,
      // TaskPortable has no labels field (labels live on missions). The
      // kernel proposal requires the field; pass empty (the published Task
      // inherits its mission's labels via the mission reference).
      labels: [],
      requiredDomain: task.requiredDomain,
      requiredCapabilities: task.requiredCapabilities,
      estimatedMinutes: null,
      // Subtasks + dependencies are applied by T10B as separate writes after
      // the Task exists (parallel to how the template publisher does it).
      // Governance runs over the Task proposal itself, not its subtask/dep
      // graph.
      subtasks: [],
      selectedDependencies: [],
      requestedAssigneeId: null,
      cloneSourceTaskId: null,
      actor,
      auditSource,
      causalContext,
      initialEventAction: "created",
    };

    const guard: PublicationGuard = {
      missionId: task.missionServerId,
      // Prospective — the mission does not exist at preflight time. T10B
      // inserts it in-tx BEFORE re-verifying the guard, so version 1 matches.
      missionVersion: 1,
      missionStatus: "not_started",
      habitatId,
      dependencies: [],
      interceptorEnrollmentFingerprint: PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER,
    };

    proposals.push({ proposal, guard });
  }

  return proposals.length > 0 ? proposals : null;
}

/**
 * Step 6b — runs the prospective governance pass. For each Task proposal,
 * runs the enrolled `taskCreated` pre-interceptors against the prospective
 * task id (T3B-2 pattern). Collects ALL decisive vetoes (T9A-04 all-decisive-
 * vetoes discipline): every Task that the batch vetoes surfaces in the
 * output; the caller treats any veto as a preflight failure.
 *
 * # `mode:"new"` vs `mode:"replacement"`
 *
 *   - `mode:"new"`: the prospective habitat has no enrollments →
 *     `freezeBatchAdmission` returns an empty snapshot → all Tasks allowed
 *     (installation / system-import governance).
 *   - `mode:"replacement"`: the live habitat's enrollments are read →
     real governance runs against the persisted configuration.
 *
 * The `attemptId` passed to {@link governTaskPublication} is the import-
 * level coordination attempt (the `prefilledAttemptId`). Per-Task attempts
 * are reserved by T10B (parallel to T9A's N-per-Task pattern).
 *
 * Returns the governance batch result (per-Task decisive outcomes + the
 * frozen admission snapshot). When there are no Task proposals, returns
 * `null` (governance is a no-op).
 */
function runGovernance(
  preparedDomains: PreparedDomains,
  habitatId: string,
  attemptId: string,
  actor: AuditActorRef,
  auditSource: AuditSource,
  causalContext: CausalContext,
): GovernanceBatchResult | null {
  const proposals = buildGovernanceProposals(
    preparedDomains,
    habitatId,
    actor,
    auditSource,
    causalContext,
  );
  if (!proposals) return null;

  return governTaskPublication({
    attemptId,
    tasks: proposals,
    // The decision ledger lives on the ROOT db client (not a publication tx).
    // Decisions persist across publication retries under the same pending
    // attempt; each decision insert is its own atomic write (the caller does
    // NOT wrap governance in a tx).
    db: getDb(),
  });
}

/**
 * Extracts the decisive veto outcomes from a governance batch result. Every
 * Task whose `outcome === "vetoed"` becomes a {@link PublicationError} — the
 * caller accumulates these with the other preflight errors.
 */
function collectGovernanceVetoes(governance: GovernanceBatchResult | null): PublicationError[] {
  if (!governance) return [];
  const errors: PublicationError[] = [];
  for (const result of governance.results) {
    if (result.outcome === "vetoed") {
      errors.push({
        field: `tasks.${result.prospectiveTaskId}`,
        code: "governance_vetoed",
        message: `Task publication vetoed by interceptor '${result.veto.interceptorKey}' (${result.veto.decision}): ${result.veto.reason}`,
      });
    }
  }
  return errors;
}

// ===========================================================================
// Guard capture (target habitat version + preserve-domain set + digest)
// ===========================================================================

/**
 * Captures the {@link ImportPublicationGuard} snapshot for the prepared
 * import. Reads the target habitat's optimistic-concurrency version when
 * `mode:"replacement"` (single read; T10B re-reads in-tx for the optimistic-
 * guard re-verify). Enumerates the declared preserve-domain set + materializes
 * the existing entity IDs per preserve domain (drift #12 absorption).
 *
 * # Preserve-domain materialization (drift #12)
 *
 * For each declared `preserve` domain, the guard's `preserveDomainTargets`
 * carries the existing entity serverIds from {@link existingHabitatSnapshot}.
 * T10B's orchestrator reads these to know which entities to skip during the
 * apply tx (preserve domains NEVER deleted). When the snapshot is null
 * (`mode:"new"`), the preserve arrays stay empty (no existing entities to
 * skip — the preserve disposition on a fresh habitat is a no-op).
 */
function capturePublicationGuard(
  manifest: HabitatImportManifest,
  manifestDigest: string,
  habitatId: string | null,
  mode: "new" | "replacement",
  existingHabitatSnapshot: ExistingHabitatSnapshot | null,
): ImportPublicationGuard {
  let targetHabitatUpdatedAt: string | null = null;
  const preserveDomainTargets = new Map<ManifestDomainName, readonly string[]>();

  if (mode === "replacement" && habitatId !== null) {
    const row = getDb().select().from(habitats).where(eq(habitats.id, habitatId)).get();
    targetHabitatUpdatedAt = row?.updatedAt ?? null;
  }

  // Enumerate the DECLARED preserve-domain set + materialize the entity IDs
  // from the snapshot (drift #12). For `mode:"new"` (snapshot null), the
  // arrays stay empty — preserve on a fresh habitat is a no-op.
  for (const domainName of MANIFEST_DOMAIN_NAMES) {
    const envelope = manifest.domains[domainName];
    if (envelope === undefined) continue;
    if (envelope.disposition === "preserve") {
      const ids: string[] = [];
      if (existingHabitatSnapshot !== null) {
        for (const entity of existingHabitatSnapshot.entitiesBySourceKey.values()) {
          if (entity.domain === domainName) {
            ids.push(entity.serverId);
          }
        }
      }
      preserveDomainTargets.set(domainName, ids);
    }
  }

  return {
    targetHabitatId: habitatId,
    targetHabitatUpdatedAt,
    identityPolicySnapshot: manifest.identityPolicy,
    preserveDomainTargets,
    manifestDigest,
  };
}

// ===========================================================================
// Manifest digest + summary (the prepared basis stamped on the reserved row)
// ===========================================================================

/**
 * Canonical stable stringify — recursively sorts object keys so the digest is
 * deterministic regardless of property-enumeration order. The output is NOT
 * valid JSON (the implementation uses minimal separators for determinism);
 * the digest is over the BYTES of this string.
 */
function canonicalStableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalStableStringify(obj[k])).join(",") +
    "}"
  );
}

/**
 * Computes the SHA-256 manifest digest — the prepared basis. Stamped on the
 * `import_attempts.manifest_digest` column at reservation + on the
 * {@link ImportPublicationGuard.manifestDigest}. T10B re-computes in-tx +
 * verifies the prepared basis didn't drift between preflight + commit.
 */
export function computeManifestDigest(manifest: HabitatImportManifest): string {
  return createHash("sha256").update(canonicalStableStringify(manifest)).digest("hex");
}

/**
 * Computes the manifest summary — the per-domain counts + the declared
 * dispositions + the authority-context snapshot. Stamped on the
 * `import_attempts.manifest_summary` column at reservation.
 */
export function computeManifestSummary(
  manifest: HabitatImportManifest,
  actor: AuditActorRef,
  mode: "new" | "replacement",
): ImportManifestSummaryJson {
  const counts: Record<string, number> = {};
  const dispositions: Record<string, "replace" | "preserve" | "reset" | undefined> = {};

  for (const domainName of MANIFEST_DOMAIN_NAMES) {
    const envelope = manifest.domains[domainName];
    if (envelope === undefined) continue;
    dispositions[domainName] = envelope.disposition;
    const data = envelope.data;
    if (Array.isArray(data)) {
      counts[domainName] = data.length;
    } else if (data !== null && typeof data === "object") {
      // Singleton domains (habitatSettings) — count is 1 when present.
      counts[domainName] = 1;
    }
  }

  return {
    counts,
    dispositions,
    governingPolicy: mode === "new" ? "installation" : "persisted_habitat",
    actor: { actorType: actor.type, actorId: actorIdOrDefault(actor) },
  };
}

/** Converts the manifest's lineage to the JSON shape persisted on the row. */
function lineageToJson(lineage: ManifestLineage): ImportAttemptSourceLineageJson {
  return {
    sourceManifestId: lineage.sourceManifestId,
    sourceHabitatId: lineage.sourceHabitatId,
    sourceExportedAt: lineage.sourceExportedAt,
  };
}

/**
 * Maps the kernel's {@link AuditActorRef.type} union to the import-attempt
 * repo's `ImportActorType` union (`"human" | "agent" | "system"`). Remote
 * actor types (remote_human / remote_orcy / remote_pod) collapse to
 * `"human"` / `"agent"` respectively (the import-attempt actor-type is the
 * high-level provenance slot; the audit projection carries the granular
 * type).
 */
function actorTypeToImport(actorType: AuditActorRef["type"]): "human" | "agent" | "system" {
  if (actorType === "agent") return "agent";
  if (actorType === "system") return "system";
  // Collapse remote_human → human, remote_orcy → agent, remote_pod → system.
  if (actorType === "remote_human") return "human";
  if (actorType === "remote_orcy") return "agent";
  if (actorType === "remote_pod") return "system";
  return "human";
}

/**
 * Returns the actor's id, defaulting to `"unknown"` when `actor.id` is null.
 *
 * `AuditActorRef.id` is typed `string | null` (the null allowance covers
 * legacy / unauthenticated edge cases). The import-attempt repo + the
 * coordination-attempt repo both require `actorId: string` (NOT NULL on the
 * row). In practice every import has a non-null actor id (the route resolves
 * it from auth context: `request.user.id` / `request.agent.id` / a fixed
 * system id). The coercion is defensive for the unreachable null case.
 */
function actorIdOrDefault(actor: AuditActorRef): string {
  return actor.id ?? "unknown";
}

// ===========================================================================
// The reservation (BEGIN IMMEDIATE — parallel to reserveScheduledOccurrence)
// ===========================================================================

/**
 * The reservation wrapper's input. Composed by {@link prepareImport} from
 * the adapted manifest + the caller-supplied actor / scope. Used by tests
 * to drive the reservation directly (bypassing the PURE pipeline).
 */
export interface ReserveImportAttemptV2Input {
  /** The import-attempt id (=== the manifest's manifestId). */
  id: string;
  /** The target habitat id (prospective for `mode:"new"`; live for `replacement`). */
  habitatId: string;
  /** Import mode. */
  mode: "new" | "replacement";
  /** Identity policy. */
  identityPolicy: "remap" | "restore";
  /** Source lineage. */
  sourceLineage: ManifestLineage;
  /** SHA-256 manifest digest. */
  manifestDigest: string;
  /** Per-domain summary. */
  manifestSummary: ImportManifestSummaryJson;
  /** Actor provenance. */
  actor: AuditActorRef;
}

/**
 * Reserves an import attempt — the BEGIN IMMEDIATE wrapper that composes M1's
 * `reserveImportAttemptWithClient` + `reserveAttemptWithClient` +
 * `setImportAttemptCoordinationAttemptIdWithClient` in ONE atomic tx.
 *
 * # Manual `BEGIN IMMEDIATE` (NOT drizzle's `db.transaction`)
 *
 * Mirrors `reserveScheduledOccurrence` (the established precedent
 * `repositories/scheduledOccurrenceReservation.ts:624-651`). Drizzle's
 * better-sqlite3 driver issues `BEGIN DEFERRED`, which acquires the SHARED
 * lock on the first read + tries to upgrade to RESERVED on the first write.
 * Under WAL-mode multi-process write contention (two workers reserving the
 * same manifestId concurrently), the loser's SHARED→RESERVED upgrade on its
 * first write can throw `SQLITE_BUSY` IMMEDIATELY, BYPASSING the connection's
 * `busy_timeout = 5000` pragma — a known SQLite WAL limitation (the busy
 * handler is reliably invoked for `BEGIN IMMEDIATE` lock acquisition, NOT
 * for the deferred upgrade path).
 *
 * `BEGIN IMMEDIATE` acquires the RESERVED lock UPFRONT, so under contention
 * the loser's `BEGIN IMMEDIATE` BLOCKS (with `busy_timeout` in effect) until
 * the winner's tx commits, then proceeds. The two reservations serialize
 * behind the RESERVED lock; within each tx the import_attempts PRIMARY KEY
 * UNIQUE index resolves which one wins → the loser gets `already_exists`.
 *
 * # Atomic composition
 *
 *   1. `reserveImportAttemptWithClient(db, …)` — INSERT the import-attempt
 *      row (state `reserved`, attemptId NULL).
 *   2. `reserveAttemptWithClient(db, …)` — reserve the import-level
 *      coordination attempt (`publicationKind:"habitat_import"`,
 *      `attemptKey:"import"`, scope `(source, sourceScopeKind, sourceScopeId,
 *      attemptKey)` keyed on the manifest id).
 *   3. `setImportAttemptCoordinationAttemptIdWithClient(db, import.id,
 *      coordination.id)` — stamp the one-shot link.
 *
 * All three commit together OR roll back together. If step 1 returns
 * `already_exists` (a prior reservation with the same manifestId exists),
 * steps 2-3 are SKIPPED + the wrapper returns `already_exists` with the
 * existing row (the existing coordination attempt — if any — is preserved
 * untouched on the existing row).
 *
 * # Idempotent replay
 *
 * `reserveAttemptWithClient` is itself idempotent on `(source, scope, key,
 * fingerprint)`: a same-key reservation with the SAME fingerprint REPLAYS
 * the stored coordination attempt (returns `{outcome:"replayed", attempt}`).
 * The replay branch also stamps the link (the one-shot CAS on
 * `import_attempts.attemptId IS NULL` is a no-op if already stamped →
 * `already_stamped`, which is a benign replay signal).
 */
export function reserveImportAttempt(
  input: ReserveImportAttemptV2Input,
): ImportAttemptReservationResult {
  const db = getDb();
  // Manual BEGIN IMMEDIATE (see docstring) — NOT drizzle's db.transaction.
  db.run(sql`BEGIN IMMEDIATE`);
  try {
    // 1. Reserve the import_attempts row (state `reserved`).
    const reservation = reserveImportAttemptWithClient(db, {
      id: input.id,
      habitatId: input.habitatId,
      mode: input.mode,
      identityPolicy: input.identityPolicy,
      sourceLineage: lineageToJson(input.sourceLineage),
      manifestDigest: input.manifestDigest,
      manifestSummary: input.manifestSummary,
      actorType: actorTypeToImport(input.actor.type),
      actorId: actorIdOrDefault(input.actor),
    });

    // 1a. Lost-race: a prior reservation with this manifestId exists. Skip
    //     the coordination-attempt reservation + link stamping; the existing
    //     row (with its existing link state) is authoritative. The wrapper
    //     returns `already_exists` so the caller can read the existing row
    //     + decide next steps.
    if (reservation.outcome === "already_exists") {
      db.run(sql`COMMIT`);
      return reservation;
    }

    // 2. Reserve the coordination attempt (publicationKind:"habitat_import").
    //    The scope key is the manifest id (caller-supplied stable id); the
    //    attemptKey is "import" (parallel to the occurrence's "occurrence").
    //    The fingerprint is the manifest digest (same manifest → same digest
    //    → replay; different manifest → rejected_fingerprint — surfaces a
    //    manifest-revision race to the caller).
    const coordinationFingerprint = input.manifestDigest;
    const coordinationReservation = reserveAttemptWithClient(db, {
      source: "rest_api",
      sourceScopeKind: "import",
      sourceScopeId: input.id,
      attemptKey: "import",
      requestFingerprint: coordinationFingerprint,
      publicationKind: "habitat_import",
      habitatId: input.habitatId,
      actorType: actorTypeToImport(input.actor.type),
      actorId: actorIdOrDefault(input.actor),
    });

    // 2a. rejected_fingerprint (a manifest-revision race: the same manifestId
    //     was previously reserved against a DIFFERENT digest). Surface as
    //     `already_exists` with the existing import-attempt row — the caller
    //     reads the existing row's digest + surfaces the mismatch. (The
    //     coordination attempt is preserved untouched on the existing row.)
    if (coordinationReservation.outcome === "rejected_fingerprint") {
      db.run(sql`COMMIT`);
      return {
        outcome: "already_exists",
        attempt: reservation.attempt,
      };
    }

    // 3. Stamp the coordination-attempt link on the import-attempt row.
    //    One-shot CAS: refuses re-stamp once a coordination attempt is
    //    already linked (defensive — `replayed` is the only legitimate
    //    re-stamp path, and the link is already stamped on replay).
    setImportAttemptCoordinationAttemptIdWithClient(
      db,
      reservation.attempt.id,
      coordinationReservation.attempt.id,
    );

    db.run(sql`COMMIT`);

    // Re-read the authoritative row (the stamping may have mutated it) so the
    // returned `attempt.attemptId` reflects the link. The reservation's
    // `attempt` field was read BEFORE the stamping; re-read after COMMIT so
    // the caller sees the stamped link.
    return {
      outcome: "created",
      attempt: {
        ...reservation.attempt,
        attemptId: coordinationReservation.attempt.id,
      },
    };
  } catch (err) {
    try {
      db.run(sql`ROLLBACK`);
    } catch {
      // Not in a transaction or already rolled back (defensive — mirrors
      // `reserveScheduledOccurrence`'s ROLLBACK guard).
    }
    throw err;
  }
}

// ===========================================================================
// Terminal-reject helper (parallel to terminalRejectOccurrenceWithCoordination)
// ===========================================================================

/**
 * The rejection reason code stamped on `import_attempts.rejection_reason` +
 * on `result.reason`. One per failure class; the caller picks the dominant
 * class when multiple classes accumulated (e.g. preflight + governance).
 */
export type ImportRejectionReason =
  | "preflight_failed"
  | "unknown_manifest_version"
  | "ambiguous_legacy_title"
  | "schema_invalid";

/**
 * Terminal-rejects an import attempt + its coordination attempt in ONE drizzle
 * `db.transaction` (atomic). Mirrors `terminalRejectOccurrenceWithCoordination`
 * (`services/scheduledOccurrencePublication.ts:1362-1496`):
 *   1. Terminalize the coordination attempt (`pending → rejected_validation`)
 *      via `completeAttemptWithClient` — when linked.
 *   2. Mark the import-attempt row `rejected` (the `reserved → rejected` edge
 *      — `leaseOwner` is NULL for `reserved` source) via
 *      `markImportAttemptRejectedWithClient`.
 *
 * Both commit together OR roll back together. The coordination-attempt
 * terminalization is skipped when `importAttempt.attemptId` is null (defensive
 * — pre-link rows shouldn't reach this path because the reservation always
 * links before returning).
 *
 * # Fenced terminalization
 *
 * `markImportAttemptRejectedWithClient`'s CAS checks `leaseOwner = expected`.
 * The expected owner is `null` for the `reserved → rejected` edge (a reserved
 * attempt carries no lease — there is nothing to fence). A `not_owner` outcome
 * here is a data anomaly (the row moved to `publishing` under a worker lease
 * between reservation + terminal-reject) → THROW so the caller surfaces the
 * inconsistency (the row stays `publishing` for T10B recovery).
 */
export function terminalRejectImportAttemptWithCoordination(
  db: TaskPublicationDbClient,
  importAttempt: ImportAttemptRow,
  reason: ImportRejectionReason,
  errors: PublicationError[],
): ImportAttemptRow {
  return db.transaction((tx) => {
    // 1. Terminalize the coordination attempt (when linked).
    if (importAttempt.attemptId !== null) {
      const terminalResult: AttemptTerminalResult = {
        outcome: "rejected_validation",
        attemptId: importAttempt.attemptId,
        errors,
      };
      const completion = completeAttemptWithClient(tx, importAttempt.attemptId, {
        finalState: "rejected_validation",
        terminalOutcome: "rejected_validation",
        terminalResult,
      });
      // Expected: `completed` (this call installed the terminal) OR `no_op`
      // (a prior terminalization won — the authoritative terminal row is
      // returned UNCHANGED; continue with the import-attempt rejection for
      // consistency). `rejected_transition` is a data anomaly — surface it.
      if (completion.outcome === "rejected_transition") {
        throw new Error(
          `terminalRejectImportAttemptWithCoordination: coordination attempt "${importAttempt.attemptId}" refused the rejected_validation transition (fromState: ${completion.fromState}) — data anomaly. The import attempt stays "reserved" / "publishing" for T10B recovery.`,
        );
      }
    }

    // 2. Mark the import-attempt row rejected. `leaseOwner: null` — the
    //    expected owner for the `reserved → rejected` edge (a reserved
    //    attempt carries no lease; the CAS's `isNull(leaseOwner)` predicate
    //    matches the row's NULL `leaseOwner`).
    const rejected = markImportAttemptRejectedWithClient(tx, importAttempt.id, {
      leaseOwner: null,
      rejectionReason: reason,
      result: { reason, errors },
    });

    // Expected: `transitioned` (this call installed the terminal) OR `no_op`
    // (a prior terminalization won). `not_owner` is a data anomaly (the row
    // moved to `publishing` under a worker lease mid-reject) → THROW so the
    // caller surfaces the inconsistency.
    if (rejected.outcome === "not_owner") {
      throw new Error(
        `terminalRejectImportAttemptWithCoordination: import attempt "${importAttempt.id}" refused the reserved → rejected transition (outcome: not_owner) — the lease was acquired by a publisher mid-rejection. The import attempt stays in its current state for T10B recovery.`,
      );
    }
    // `illegal_source_state` is reachable if the row already terminalized
    // (e.g. a concurrent T10B publisher reached `published` before this
    // terminal-reject ran). The row is returned UNCHANGED — surface it to
    // the caller as the authoritative state.
    return rejected.outcome === "not_found" ? importAttempt : rejected.attempt;
  });
}

// ===========================================================================
// The 6-step pipeline (PURE except for the accepted governance-ledger
// exception; runs handlers in dependency order)
// ===========================================================================

/**
 * The pipeline outcome — either the prepared body (manifest + idMap +
 * preparedDomains + guard + governanceDecisions + existingHabitatSnapshot,
 * WITHOUT prefilledAttemptId) or the accumulated {@link ManifestDomainError}
 * list.
 */
export type PreflightPipelineOutcome =
  | {
      outcome: "prepared";
      manifest: HabitatImportManifest;
      identityMap: IdentityMap;
      preparedDomains: PreparedDomains;
      guard: ImportPublicationGuard;
      governanceDecisions: GovernanceBatchResult["results"];
      legacyWarnings: string[];
      /**
       * The existing-habitat snapshot (drift #13). Populated for
       * `mode:"replacement"`; null for `mode:"new"`. Consumed by the
       * entry point's PreparedImport envelope + by the handlers' validate
       * / prepare / resolveReferences phases via {@link ManifestContext}.
       */
      existingHabitatSnapshot: ExistingHabitatSnapshot | null;
    }
  | { outcome: "rejected"; errors: ManifestDomainError[]; legacyWarnings: string[] };

/**
 * The 6-step orchestrator. PURE except for the accepted governance-ledger
 * exception: step 6 (prospective governance) writes decision-ledger rows via
 * `recordGovernanceDecisionWithClient` (the T3B-2 reusable-decision pattern,
 * same as T9A). These ledger rows are ATOMIC per-decision + persist across
 * publication retries under the same pending attempt — they are NOT part of
 * the reservation tx; the ledger is the T3B-2 reuse invariant (the durable
 * cache that makes identical re-preparation reuse decisions). They are part
 * of the kernel's governance contract, not a violation of "preflight is
 * read-only." Every other step is read-only; the target-habitat `updatedAt`
 * read in guard-capture is a single SELECT (read-only).
 *
 * Steps:
 *   2. Authority check (completeness + declared destructive intent).
 *   3. Per-domain validate (MANIFEST_DOMAIN_NAMES order; accumulate ALL).
 *   4. IdentityMap build (prepare; MANIFEST_DOMAIN_NAMES order).
 *   5. Cross-domain reference resolution (resolveReferences; same order).
 *   6. Prospective governance + guard capture.
 *
 * (Step 1 — version detection + adapter dispatch — runs BEFORE the pipeline
 * because the manifest must be v3 before this function runs.)
 *
 * # Accumulate ALL errors (load-bearing)
 *
 * Errors from EVERY step accumulate into ONE list. No first-error short-
 * circuit. The plan's "preflight reports every independently discoverable
 * structural, validation, scope, and governance failure" directive.
 *
 * # Dependency-order contract (load-bearing — drift #8)
 *
 * Handlers run in {@link MANIFEST_DOMAIN_NAMES} iteration order:
 * habitatSettings → columns → missions → tasks → subtasks → dependencies →
 * comments → templates. The mission handler's `resolveReferences` reads
 * cross-domain column server IDs from the idMap (populated by `columns.prepare`);
 * running columns after missions would produce unresolved-reference errors.
 *
 * @param manifest The v3 manifest (post-adaptation).
 * @param habitatId The target habitat id (prospective for `mode:"new"`; live for `replacement`).
 * @param mode The resolved import mode.
 * @param actor The caller's audit actor.
 * @param auditSource The caller's audit source.
 * @param attemptId The reserved coordination attempt id (passed to governance).
 * @param legacyWarnings The warnings from M2's adapter (carried through to the outcome).
 * @param wasLegacyInput `true` when the input was legacy v1/v2 (routed through
 *        M2's adapter); `false` when the input was already v3 (identity
 *        passthrough). The entry point computes this authoritatively in
 *        {@link detectAndAdaptInput} + passes it through. Direct callers MUST
 *        supply the correct flag — do NOT reconstruct via heuristic (a v3
 *        native `remap` input is NOT a legacy input even though its
 *        identityPolicy differs from `restore`).
 */
export function runPreflightPipeline(
  manifest: HabitatImportManifest,
  habitatId: string | null,
  mode: "new" | "replacement",
  actor: AuditActorRef,
  auditSource: AuditSource,
  attemptId: string,
  legacyWarnings: string[],
  wasLegacyInput: boolean,
): PreflightPipelineOutcome {
  const errors: ManifestDomainError[] = [];

  // ----- STEP 1.5 (NEW): existing-habitat snapshot (drift #13 absorption) -----
  // PURE read; gated behind mode + habitatId. For mode:"new" the snapshot
  // stays null (no existing habitat to read). The snapshot drives:
  //   - restore identity semantics (collision detection in step 2's
  //     checkRestoreIdentitySemantics);
  //   - preserveDomainTargets materialization (in capturePublicationGuard);
  //   - ManifestContext.existingHabitatSnapshot for the handlers.
  const existingHabitatSnapshot =
    mode === "replacement" && habitatId !== null ? readExistingHabitatSnapshot(habitatId) : null;

  // ----- STEP 2: authority check (completeness + declared intent + restore semantics) -----
  errors.push(
    ...checkAuthority(
      { manifest, warnings: legacyWarnings, wasLegacyInput },
      mode,
      existingHabitatSnapshot,
    ),
  );

  // ----- STEP 3-5: per-domain validate + prepare + resolveReferences -----
  const crossDomainState: CrossDomainState = {};
  const ctx: ManifestContext = {
    habitatId,
    mode,
    identityPolicy: manifest.identityPolicy,
    // M3 (drift #13 absorption): the snapshot is now populated for
    // mode:"replacement". For mode:"new" it stays null (no existing habitat).
    // The handlers' validate / prepare / resolveReferences phases read it
    // for disposition-aware behavior (restore collision detection,
    // preserve targeting).
    existingHabitatSnapshot,
    actor,
    auditSource,
    crossDomainState,
  };
  const idMap: IdentityMap = createIdentityMap();
  const preparedDomains: PreparedDomains = {};

  // F3: pre-populate the habitat's sourceId → targetHabitatId mapping so
  // `prepareHabitatSettings`'s `allocateServerId` reuses it. Without this,
  // the handler allocates a SEPARATE habitatServerId from the manifest's
  // sourceId, diverging from the preflight's `targetHabitatId` (which is
  // stamped on `import_attempts.habitat_id` + the publication guard). The
  // divergence causes the import-attempt row to point at a non-existent
  // habitat (UUID-A on the row, UUID-B in the habitats table). The
  // pre-population makes the two values identical by construction.
  //
  // Only runs when habitatSettings is declared AND habitatId is non-null
  // (mode:"new" with a prospective id; mode:"replacement" with the live id).
  // For mode:"new" without a declared habitatSettings envelope, the
  // orchestrator falls back to allocating a fresh UUID.
  const habitatEnvelope = manifest.domains.habitatSettings;
  if (habitatEnvelope && habitatId !== null) {
    const habitatSourceId = (habitatEnvelope.data as { sourceId?: unknown }).sourceId;
    if (typeof habitatSourceId === "string" && habitatSourceId.length > 0) {
      idMap.sourceToServer.set(habitatSourceId, habitatId);
    }
  }

  for (const domainName of MANIFEST_DOMAIN_NAMES) {
    const envelope = manifest.domains[domainName];
    if (envelope === undefined) continue;

    const pass = runDomainPipeline(domainName, envelope, ctx, idMap);
    if (pass.errors.length > 0) {
      errors.push(...pass.errors);
    }
    if (pass.prepared !== null) {
      storePreparedDomain(preparedDomains, domainName, pass.prepared);
    }

    // Expose the raw envelope to downstream handlers via crossDomainState
    // (load-bearing for the dependencies handler's cycle detection over the
    // mission graph + the missions handler's columnName validation).
    exposeEnvelopeToCrossDomain(crossDomainState, domainName, envelope);
  }

  // Early-return if any structural / reference errors accumulated — there is
  // no point running prospective governance over a graph whose references
  // failed to resolve. (The plan's directive is "accumulate ALL errors";
  // governance vetoes added on top of structural failures would still
  // surface in the same rejection, but governance over an unresolved graph
  // produces misleading vetoes. Run governance ONLY against a structurally
  // sound prepared graph.)
  if (errors.length > 0) {
    return { outcome: "rejected", errors, legacyWarnings };
  }

  // ----- STEP 6a: prospective governance -----
  const causalContext: CausalContext = {
    root: { type: IMPORT_CAUSAL_ROOT_TYPE, id: manifest.manifestId },
  };
  const governance = runGovernance(
    preparedDomains,
    habitatId ?? "",
    attemptId,
    actor,
    auditSource,
    causalContext,
  );
  const governanceErrors = collectGovernanceVetoes(governance);

  // Convert governance errors to ManifestDomainError shape + accumulate.
  const governanceDomainErrors: ManifestDomainError[] = governanceErrors.map((e) => ({
    domain: "tasks",
    kind: e.code,
    message: e.message,
    fieldPath: e.field.split("."),
  }));
  errors.push(...governanceDomainErrors);

  if (errors.length > 0) {
    return { outcome: "rejected", errors, legacyWarnings };
  }

  // ----- STEP 6b: guard capture (with preserve-domain materialization) -----
  const manifestDigest = computeManifestDigest(manifest);
  const guard = capturePublicationGuard(
    manifest,
    manifestDigest,
    habitatId,
    mode,
    existingHabitatSnapshot,
  );

  return {
    outcome: "prepared",
    manifest,
    identityMap: idMap,
    preparedDomains,
    guard,
    governanceDecisions: governance?.results ?? [],
    legacyWarnings,
    existingHabitatSnapshot,
  };
}

// ===========================================================================
// The entry point (composes reservation + PURE pipeline + outcome)
// ===========================================================================

/**
 * The entry point. Composes the dormancy gate + version detection + strict
 * schema + reservation + PURE pipeline + outcome.
 *
 * See {@link PrepareImportOutcome} for the closed result union.
 *
 * @throws {UnknownManifestVersion} when the input version is unknown (caller
 *         catches + maps to a 400).
 * @throws {AmbiguousLegacyTitleError} when M2's ambiguity detector fires
 *         (caller catches + maps to a 400).
 * @throws {Error} for infrastructure failures (retryable transport). Every
 *         expected domain decision is a closed discriminated-union branch.
 */
export function prepareImport(input: PrepareImportInput): PrepareImportOutcome {
  // 1. Dormancy gate.
  if (!isCreationPublicationEnabled()) {
    return { outcome: "feature_disabled" };
  }

  // 2-3. Version detection + adapter dispatch + strict v3 schema parse.
  let adapted: AdaptedInput;
  try {
    adapted = detectAndAdaptInput(input.rawManifest);
  } catch (err) {
    // Pre-reservation failure — no import attempt to terminalize. Re-throw
    // for the caller (route maps UnknownManifestVersion + AmbiguousLegacyTitle
    // to 400; the schema_invalid case is handled below).
    if (err instanceof UnknownManifestVersion || err instanceof AmbiguousLegacyTitleError) {
      throw err;
    }
    throw err;
  }

  // Strict v3 schema parse (defensive — rejects gross malformations the
  // adapter might have produced + anything a hand-crafted v3 input got wrong).
  const schemaParse = importManifestSchema.safeParse(adapted.manifest);
  if (!schemaParse.success) {
    // Schema invalid — surface as a feature_disabled-adjacent error. There's
    // no import attempt yet (we haven't reserved); throw a typed error for
    // the route to map. The error carries the zod issues for diagnostics.
    throw new Error(`prepareImport: strict v3 schema parse failed: ${schemaParse.error.message}`);
  }

  // 4. Resolve mode + habitatId.
  const mode = input.mode ?? adapted.manifest.mode;
  const targetHabitatId = input.habitatId ?? (mode === "new" ? randomUUID() : null);
  if (mode === "replacement" && targetHabitatId === null) {
    throw new Error(
      "prepareImport: mode:'replacement' requires a habitatId (pass a live habitat id for replacement imports).",
    );
  }

  // Override the manifest's manifestId / mode / habitatId with the resolved
  // values BEFORE computing the digest (so the reserved row's digest reflects
  // the resolved state — T10B's in-tx re-verify compares against this digest).
  const resolvedManifest: HabitatImportManifest = {
    ...adapted.manifest,
    ...(input.manifestId !== undefined ? { manifestId: input.manifestId } : {}),
    mode,
  };

  // 5. Compute digest + summary.
  const manifestDigest = computeManifestDigest(resolvedManifest);
  const manifestSummary = computeManifestSummary(resolvedManifest, input.actor, mode);

  // 6. Reserve (BEGIN IMMEDIATE tx).
  const reservation = reserveImportAttempt({
    id: resolvedManifest.manifestId,
    habitatId: targetHabitatId ?? "",
    mode,
    identityPolicy: resolvedManifest.identityPolicy,
    sourceLineage: resolvedManifest.lineage,
    manifestDigest,
    manifestSummary,
    actor: input.actor,
  });
  if (reservation.outcome === "already_exists") {
    return { outcome: "already_exists", attempt: reservation.attempt };
  }
  const importAttempt = reservation.attempt;
  const prefilledAttemptId = importAttempt.attemptId;
  if (!prefilledAttemptId) {
    // Defensive — the reservation always stamps the link before returning
    // `created`. A missing link here is a programmer error in the reservation
    // composition.
    throw new Error(
      `prepareImport: reservation returned 'created' but attemptId is null (manifestId='${resolvedManifest.manifestId}'). This indicates a reservation-composition bug.`,
    );
  }

  // 7. Run the PURE pipeline (steps 2-6).
  const pipelineResult = runPreflightPipeline(
    resolvedManifest,
    targetHabitatId,
    mode,
    input.actor,
    input.auditSource,
    prefilledAttemptId,
    adapted.warnings,
    adapted.wasLegacyInput,
  );

  // 8. Outcome.
  if (pipelineResult.outcome === "rejected") {
    const publicationErrors: PublicationError[] = pipelineResult.errors.map(
      domainErrorToPublicationError,
    );
    // Terminal-reject — both the import attempt + coordination attempt.
    terminalRejectImportAttemptWithCoordination(
      getDb(),
      importAttempt,
      "preflight_failed",
      publicationErrors,
    );
    return {
      outcome: "rejected_preflight",
      errors: publicationErrors,
      importAttemptId: importAttempt.id,
    };
  }

  return {
    outcome: "prepared",
    prepared: {
      manifest: pipelineResult.manifest,
      manifestDigest,
      identityMap: pipelineResult.identityMap,
      preparedDomains: pipelineResult.preparedDomains,
      guard: pipelineResult.guard,
      governanceDecisions: pipelineResult.governanceDecisions,
      authority: {
        caller: input.actor,
        auditSource: input.auditSource,
        governingPolicy: mode === "new" ? "installation" : "persisted_habitat",
      },
      prefilledAttemptId,
      existingHabitatSnapshot: pipelineResult.existingHabitatSnapshot,
    },
  };
}

// ===========================================================================
// Internal: error-shape conversion (DomainError → PublicationError)
// ===========================================================================

/**
 * Builds a {@link ManifestDomainError} shaped for the authority check (the
 * `domain` field is `"authority"` so downstream renderers can distinguish
 * authority failures from per-domain handler failures).
 */
function authorityError(
  field: string,
  kind: string,
  message: string,
  extra: {
    actual?: unknown;
    fieldPath?: readonly (string | number)[];
  } = {},
): ManifestDomainError {
  return {
    domain: "authority",
    kind,
    message,
    ...extra,
    // Override fieldPath with [field] when not provided (authority errors
    // carry their location in `kind` + `message`; fieldPath is a secondary
    // signal for renderers).
    fieldPath: extra.fieldPath ?? [field],
  };
}

/**
 * Converts a {@link ManifestDomainError} (the M3 handler shape) to a
 * {@link PublicationError} (the kernel's terminal-reject shape). The M3
 * shape carries richer diagnostics (cyclePath / expected / actual); the
 * kernel shape carries the canonical {field, code, message} triple that
 * the route + UI render.
 */
function domainErrorToPublicationError(err: ManifestDomainError): PublicationError {
  const field = err.fieldPath && err.fieldPath.length > 0 ? err.fieldPath.join(".") : err.domain;
  return {
    field,
    code: err.kind,
    message: err.message,
  };
}
