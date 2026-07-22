/**
 * Triage-Mission Aggregate Publication Adapter (T8A — DORMANT).
 *
 * Composes the T9A decomposed template-aggregate interface — prepare →
 * reserve N attempts → publish — for the triage origin (the daemon-triggered
 * "Triage: …" Mission spawned by the cluster + orphan scans). This is the
 * dormant replacement for the legacy
 * `triageService.ts:24 createTriageMission` + `:67 createOrphanTriageMission`
 * paths. It ships ALONGSIDE the legacy paths and is exercised ONLY by tests
 * until the global cutover (T11) swaps the scan callers onto it.
 *
 * # Why a new adapter (not an extension of the single-Task adapters)
 *
 * The 6 single-Task origin adapters (`publishTaskCreation`,
 * `publishRecoveryTask`, `publishAutomationTask`, `publishPluginTask`,
 * `publishBlockerClearanceTask`, + clone) each compose ONE Task through the
 * kernel chain. Triage is structurally an AGGREGATE origin: a single triage
 * spawn produces a Mission + N Tasks (one per `tasksTemplate` entry —
 * typically one "investigate" Task today, but the template scales) + the
 * `triageClusterMissions` junction row. Composing it as N single-Task
 * publications would lose the aggregate atomicity (a crash between the Mission
 * insert + the junction write is the EXACT crash window the legacy path
 * suffers today — `applyTemplate` commits, THEN a separate non-atomic
 * `triageClusterMissionsRepo.create` runs).
 *
 * The T9A decomposed interface (`prepareTemplateAggregate` +
 * `publishTemplateAggregateWithClient`) is the aggregate-scale analog of the
 * single-Task kernel chain. This adapter composes it with the
 * `triageClusterMissions` junction as a caller-supplied transaction
 * participant — the junction commits atomically WITH the aggregate (Mission +
 * Tasks + Workflow + usage), eliminating the crash window.
 *
 * # The atomic-junction fix (the defining feature)
 *
 * The legacy path performs TWO non-atomic writes:
 *   1. `applyTemplate(...)` — inserts Mission + Tasks + Workflow + usage
 *      inside its OWN `db.transaction` (commits).
 *   2. `triageClusterMissionsRepo.create(habitatId, clusterKey, missionId)`
 *      — inserts the junction row on `getDb()` (commits).
 *
 * A crash between (1) and (2) leaves an orphan triage Mission: the scan's
 * `findActiveByClusterKey` pre-check sees no open junction → re-fires on the
 * next cycle → creates a DUPLICATE triage Mission for the same cluster. This
 * adapter moves write (2) INTO the T9A publication transaction via the
 * {@link TemplateAggregateParticipantWriter} seam. Either the Mission + Tasks
 * + Workflow + usage + junction ALL commit, or NONE do. The crash window is
 * eliminated.
 *
 * # First-time governance (gap-audit R1 + cold-critique B1 correction)
 *
 * The legacy `applyTemplate` path inserts Tasks directly via `tx.insert(tasks)`
 * — NO `created` Lifecycle Event, NO prospective governance, NO envelope. The
 * triage Tasks produced by THIS adapter get all three FOR THE FIRST TIME,
 * inherited from the T9A publisher (which composes `publishTaskWithClient` per
 * Task):
 *
 *   - **`created` Lifecycle Event** — `publishTaskWithClient` always creates
 *     exactly one initial event (`proposal.initialEventAction = "created"`).
 *   - **`creationIntegrity: POST_CUTOVER`** — stamped automatically by the
 *     coordinator (engages the claim gates).
 *   - **Prospective governance** — `governTaskPublication` runs the enrolled
 *     `taskCreated` interceptors BEFORE the publication tx opens; a veto on
 *     ANY Task returns `{outcome:"vetoed"}` WITHOUT opening the tx — zero
 *     orphan Mission, zero partial aggregate, zero junction row. This is the
 *     visible blocked outcome the scan daemon (T11) surfaces as a blocked
 *     triage log entry. Today triage bypasses governance entirely; this
 *     adapter removes the exemption.
 *
 * # Composition (T9A consumer contract)
 *
 *   1. PREPARE via {@link prepareTemplateAggregate} (PURE). On
 *      `rejected_validation` → return (terminal).
 *   2. RESERVE N attempts (one per `aggregate.tasks[i]`), BEFORE publishing.
 *      Server-derived identity keyed by `(source, sourceScopeKind,
 *      sourceScopeId, attemptKey)` — same-cluster/orphan retry replays;
 *      corrected-input retry differs by `requestFingerprint` →
 *      `rejected_fingerprint` (forces a new key).
 *   3. PUBLISH via {@link publishTemplateAggregateWithClient} with the
 *      {@link buildTriageClusterJunctionParticipant junction participant}.
 *      Outcome ∈ `{published, vetoed, guard_mismatch, governance_denied}`.
 *   4. MAP the outcome to {@link TriageMissionPublicationResult}.
 *
 * # Junction idempotency decision (let the race surface as a clean rollback)
 *
 * The legacy `triageClusterMissionsRepo.create()` catches the partial-unique-
 * index UNIQUE violation + re-reads the existing row (idempotent on race).
 * The cluster + orphan scans pre-check `findActiveByClusterKey` BEFORE
 * spawning (`triageScanService.ts:69`, `orphanScanService.ts:75`), so a
 * UNIQUE hit inside the participant is a genuine concurrent-scan race: two
 * scans won the pre-check in the same window. This participant does NOT
 * replicate the catch-and-re-read: a raw `tx.insert` that hits UNIQUE THROWS
 * → rolls back the loser's WHOLE aggregate (Mission + Tasks + Workflow +
 * usage + junction). The loser's scan-loop try/catch logs the rollback + the
 * next scan cycle's pre-check sees the winner's open junction → skips. Exactly
 * one triage Mission survives per cluster per race.
 *
 * The catch-and-re-read would be WORSE than the legacy behavior here: the
 * loser's participant would silently "succeed" (re-read returns the winner's
 * junction row), the loser's tx would commit its Mission + Tasks + Workflow +
 * usage, AND the junction would point at the WINNER's mission → orphaned
 * loser aggregate + duplicate suppression failure on the next scan.
 *
 * # Dormancy
 *
 * No production scan call routes through this adapter yet. Legacy
 * `createTriageMission` + `createOrphanTriageMission` + their scan callers
 * (`triageScanService.ts:87`, `orphanScanService.ts:80`) stay the active
 * production path until T11. The gate-wiring at the legacy entry points +
 * adaptation of the scan callers to the vetoed surface is T11.
 *
 * See: T8A ticket (triage milestone — active scope); T9A ticket (consumer
 * contract for T8A-triage); the Recovery adapter (`taskRecoveryPublication`)
 * for the closest single-Task participant-seam precedent; the T9A publisher
 * (`templateAggregatePublication`) for the aggregate-scale kernel.
 */
import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import type { AuditActorRef, AuditSource, CausalContext, ClusterPayload } from "@orcy/shared";
import { getDb } from "../db/index.js";
import { triageClusterMissions } from "../db/schema/index.js";
import { TRIAGE_MISSION_TEMPLATE_ID } from "../repositories/template.js";
import * as triageResolutionsRepo from "../repositories/triageResolutions.js";
import { reserveAttemptWithClient } from "../repositories/taskCreationAttempts.js";
import {
  TERMINAL_ATTEMPT_STATES,
  type AttemptTerminalResult,
} from "../repositories/taskPublication.js";
import {
  prepareTemplateAggregate,
  type PrepareTemplateAggregateContext,
} from "./templateAggregatePreparation.js";
import {
  publishTemplateAggregateWithClient,
  type TemplateAggregateParticipantWriter,
} from "./templateAggregatePublication.js";
import type { CommittedPublication } from "./taskPublicationCoordinator.js";
import type { CommittedMission, CommittedWorkflow } from "./templateAggregatePublication.js";
import type {
  GuardMismatchReason,
  CommitAuthorizationDenialKind,
} from "./taskPublicationGuardVerify.js";
import type { PublicationError } from "./taskPublicationPreparation.js";
import type { Mission } from "../models/index.js";

// ---------------------------------------------------------------------------
// Re-exports (origin-neutral types the envelope carries)
// ---------------------------------------------------------------------------

export type { CommittedMission, CommittedWorkflow, CommittedPublication };

// ---------------------------------------------------------------------------
// Provenance constants
// ---------------------------------------------------------------------------

/**
 * The system actor identity for a triage publication.
 *
 * Preserves the legacy `applyTemplate(... "system")` attribution (triage
 * Mission + Tasks carry `createdBy: "system"`) as structured provenance — the
 * {@link AuditActorRef} carries it with `type: "system"`. The id is the more
 * descriptive `"triage"` (vs the legacy generic `"system"`) for observability
 * — the structure (`{type: "system", id: …}`) is what makes it structured
 * provenance, replacing the legacy bare string. The adapter stamps it;
 * untrusted callers cannot assert this.
 */
const TRIAGE_ACTOR_ID = "triage";

/**
 * The origin channel for a triage publication.
 *
 * `"system"` is the valid `AuditSource` enum value that matches the legacy
 * origin (the triage Mission is auto-created by the system in response to a
 * scan; there is no `"triage"` source in `AUDIT_SOURCES`). It matches the
 * legacy `applyTemplate(... "system")` audit source. The adapter stamps it;
 * the input does not expose `auditSource`.
 */
const TRIAGE_AUDIT_SOURCE: AuditSource = "system";

/**
 * The causal-root type for a CLUSTER triage publication. The root id is the
 * clusterKey (`payload.clusterKey`). A fresh root per cluster — no inherited
 * hops (the cluster scan is itself the originating action).
 */
const TRIAGE_CLUSTER_CAUSAL_ROOT_TYPE = "triage_cluster";

/**
 * The causal-root type for an ORPHAN-MISSION triage publication. The root id
 * is the orphan Mission id. A fresh root per orphan — no inherited hops.
 */
const ORPHAN_MISSION_CAUSAL_ROOT_TYPE = "orphan_mission";

/**
 * The attempt-reservation scope kind for a cluster triage publication. Paired
 * with `sourceScopeId = payload.clusterKey`, this forms the per-cluster
 * reservation scope — same-cluster re-scan replays; different cluster creates
 * a distinct attempt set.
 */
const TRIAGE_CLUSTER_SCOPE_KIND = "triage_cluster";

/**
 * The attempt-reservation scope kind for an orphan-mission triage publication.
 * Paired with `sourceScopeId = orphan.id`, this forms the per-orphan
 * reservation scope.
 */
const ORPHAN_MISSION_SCOPE_KIND = "orphan_mission";

// ---------------------------------------------------------------------------
// Adapter input — discriminated by triage kind (cluster vs orphan)
// ---------------------------------------------------------------------------

/**
 * The triage publication command — one adapter, two origins (mirrors how
 * `publishBlockerClearanceTask` carries a discriminated `scope` field).
 *
 * Both origins share the SAME mission template (`TRIAGE_MISSION_TEMPLATE_ID`)
 * + the SAME junction table + the SAME publish core. They differ ONLY in the
 * title/description/variables/clusterKey/causal-root/scope-kind derivation,
 * which the adapter dispatches on `kind`. The cluster + orphan scan callers
 * (T11) each wire their respective `kind`; the rest of the chain is shared.
 *
 * # Server-constructed provenance
 *
 * The caller (the future T11 scan-caller wiring) supplies ONLY the cluster
 * payload (cluster) or the orphan Mission (orphan) + the authoritative
 * Habitat. The adapter constructs `actor` (`triage`), `auditSource`
 * (`"system"`), `causalContext`, and the per-Task attempt identities from
 * these — the input does NOT expose `actor`, `auditSource`, `causalContext`,
 * or `attemptKey` fields. Untrusted callers cannot assert privileged scan or
 * actor identities.
 */
export type TriageMissionPublicationInput =
  | {
      /**
       * Cluster triage: the scan detected a recurring signal-pattern cluster
       * (ADR-0026) and spawns an investigation Mission. The legacy entry
       * point is `triageService.createTriageMission(habitatId, payload)`.
       */
      kind: "cluster";
      /** The authoritative Habitat the cluster was detected in. */
      habitatId: string;
      /** The cluster payload (clusterKey, signal counts, agent ids, etc.). */
      payload: ClusterPayload;
      /**
       * Optional occurrence discriminator appended to the attempt scope (NOT
       * the payload clusterKey). When a same-clusterKey recurrence produces
       * `rejected_fingerprint` (different rendered content), the caller retries
       * with a unique suffix so the new occurrence gets a fresh attempt
       * identity. The clusterKey in the payload is unchanged so the historical
       * resolution lookup still finds prior resolutions.
       */
      scopeSuffix?: string;
    }
  | {
      /**
       * Orphan-mission triage: the scan detected a Mission disconnected from
       * the roadmap DAG (RM-7) and spawns a positioning Mission. The legacy
       * entry point is `triageService.createOrphanTriageMission(habitatId,
       * orphan)`.
       */
      kind: "orphan";
      /** The authoritative Habitat the orphan Mission belongs to. */
      habitatId: string;
      /** The orphan Mission (disconnected from the roadmap DAG). */
      orphan: Mission;
    };

// ---------------------------------------------------------------------------
// Adapter result — closed discriminated union (NEVER thrown for a decision)
// ---------------------------------------------------------------------------

/**
 * The triage publication result envelope.
 *
 * Every branch is an origin-neutral publication outcome translated from the
 * T9A {@link PublishTemplateAggregateOutcome} (plus the reservation-replay
 * branches the adapter owns). The triage-domain mapping:
 *
 *   - `published` — the full triage aggregate (Mission + N Tasks + optional
 *     Workflow + usage mutation + junction row) committed atomically.
 *     `missionId` mirrors the legacy `{missionId}` return shape so a future
 *     gate-wired caller (T11) can drop in without reshaping its return. The
 *     extra fields (`mission`, `tasks`, `workflow`) give T11 the full
 *     committed aggregate for surfacing without re-reading.
 *   - `vetoed` — **the visible blocked outcome (NET-NEW).** A governance
 *     interceptor refused one or more triage Tasks BEFORE the publication tx
 *     opened. NOTHING committed (no Mission, no Tasks, no Workflow, no usage, no
 *     junction). Today triage Tasks bypass governance entirely via
 *     `applyTemplate`; this adapter removes the exemption — the veto is the
 *     first governance decision a triage Task ever carries. The `vetoes` list
 *     carries EVERY decisive Task-level veto (T9A-04 — all-failures). The scan
 *     daemon (T11) surfaces this as a blocked triage log entry (NOT a swallowed
 *     error).
 *   - `rejected_validation` — the rendered triage template produced an
 *     invalid Task (e.g. empty title after substitution, missing required
 *     workflow variable). Terminal; the scan surfaces a configuration error.
 *   - `guard_mismatch` — a per-Task guard drift at publish time. The tx
 *     rolled back (zero partial aggregate); the per-Task attempts stay
 *     `pending` / resumable. The scan retries under the SAME keys.
 *   - `governance_denied` — a stale governance decision at commit time. The
 *     tx rolled back; the scan re-governs under the SAME keys.
 *   - `replayed` — a same-`(scope, attemptKey)` retry hit a terminal
 *     per-Task attempt; the stored terminal result is returned verbatim (no
 *     re-run). The idempotent-retry guardrail for the scan: a re-scan after a
 *     terminal outcome replays without re-running the publication side
 *     effects.
 *   - `rejected_fingerprint` — the rendered triage template changed under the
 *     same attempt keys (e.g. the cluster payload mutated between scans). The
 *     scan uses a new key set.
 *
 * Infrastructure failures (a repository throw, including the participant's
 * own UNIQUE-violation throw on a concurrent-scan race) propagate as
 * retryable runtime errors; the whole aggregate rolls back. The scan's outer
 * try/catch logs the error + continues; the next cycle's
 * `findActiveByClusterKey` pre-check suppresses re-firing if the winner's
 * junction committed.
 */
export type TriageMissionPublicationResult =
  | {
      outcome: "published";
      /** The committed triage Mission id (mirrors the legacy `{missionId}` shape). */
      missionId: string;
      /** The committed triage Mission row. */
      mission: CommittedMission;
      /** One committed publication per Task (each POST_CUTOVER + `created` event + envelope). */
      tasks: CommittedPublication[];
      /** The committed Workflow row, or `null` when the template had no workflow. */
      workflow: CommittedWorkflow | null;
    }
  | {
      outcome: "vetoed";
      /**
       * Every decisive Task-level veto collected by the milestone-1 publisher
       * (T9A-04 — all-failures governance). One entry per vetoed Task;
       * allowed Tasks are NOT in the list. Mirrors the milestone-1
       * `PublishTemplateAggregateOutcome.vetoed.vetoes` shape 1:1.
       *
       * Decision: carry the FULL list (not first-veto + count). Justification:
       * (1) faithfulness to the plan's "report all failures" contract — the
       * scan daemon's blocked-triage log surfaces every blocker, not just
       * the first; (2) forward-compat — if the triage template grows beyond
       * its standard 1 Task, the surface already carries everything; (3) the
       * milestone-1 outcome already carries the full list, so this is the
       * cleanest pass-through (no information loss at the adapter). The
       * standard triage template has N=1 today, so the typical case is a
       * single-element list.
       */
      vetoes: ReadonlyArray<{
        taskIndex: number;
        veto: {
          interceptorKey: string;
          reason: string;
          pluginRunId: string | null;
        };
      }>;
    }
  | {
      outcome: "rejected_validation";
      errors: PublicationError[];
    }
  | {
      outcome: "guard_mismatch";
      taskIndex: number;
      reasons: GuardMismatchReason[];
    }
  | {
      outcome: "governance_denied";
      taskIndex: number;
      kind: CommitAuthorizationDenialKind;
      reason: string;
      interceptorKey?: string;
    }
  | {
      outcome: "replayed";
      attemptId: string;
      terminal: AttemptTerminalResult;
    }
  | {
      outcome: "rejected_fingerprint";
      attemptId: string;
      /** Fingerprint already reserved against this key. */
      reservedFingerprint: string;
    };

// Re-export the T9A outcome type so consumers (T11 wiring, tests) can narrow
// without reaching into the T9A module directly.
export type { PublishTemplateAggregateOutcome } from "./templateAggregatePublication.js";

// ---------------------------------------------------------------------------
// Origin-specific derivation (cluster vs orphan)
// ---------------------------------------------------------------------------

/**
 * The derived triage-Mission inputs for one origin — the title/description/
 * variables passed to {@link prepareTemplateAggregate} as `overrides`, plus
 * the clusterKey (the junction row's `clusterKey` + the causal-root id) +
 * the source-scope kind/id (the attempt-reservation scope).
 *
 * The cluster + orphan derivations produce this same shape; the adapter
 * dispatches on `input.kind` then runs the shared prepare → reserve → publish
 * → map core.
 */
interface DerivedTriageScope {
  /** The junction row's `clusterKey` + the causal-root id. */
  clusterKey: string;
  /** The attempt-reservation scope kind (`triage_cluster` / `orphan_mission`). */
  sourceScopeKind: string;
  /** The attempt-reservation scope id (the clusterKey / orphan id). */
  sourceScopeId: string;
  /** The causal-root type (`triage_cluster` / `orphan_mission`). */
  causalRootType: string;
  /** The `overrides.title` passed to `prepareTemplateAggregate`. */
  title: string;
  /** The `overrides.description` passed to `prepareTemplateAggregate`. */
  description: string;
  /** The `overrides.variables` passed to `prepareTemplateAggregate`. */
  variables: Record<string, string>;
}

/**
 * Derives the cluster-triage scope from the payload — preserves the legacy
 * `createTriageMission` title/description/variables construction exactly.
 *
 * The description embeds the proactive-resolution suggestion block (when a
 * historical `triage_resolutions` row exists for this clusterKey) via the
 * same `triageResolutionsRepo.findByClusterKey` lookup the legacy
 * `buildMissionDescription` performs. The lookup is a read; it runs BEFORE
 * the publication tx opens (no atomicity coupling).
 */
function deriveClusterScope(habitatId: string, payload: ClusterPayload): DerivedTriageScope {
  const variables: Record<string, string> = {
    clusterSubject: payload.clusterKey,
    signalCount: String(payload.signalCount),
    provenanceBreakdown: JSON.stringify(payload.provenanceBreakdown),
    crossMissionCount: String(payload.crossMissionCount),
    agentIds: payload.agentIds.join(","),
  };
  return {
    clusterKey: payload.clusterKey,
    sourceScopeKind: TRIAGE_CLUSTER_SCOPE_KIND,
    sourceScopeId: payload.clusterKey,
    causalRootType: TRIAGE_CLUSTER_CAUSAL_ROOT_TYPE,
    title: `Triage: ${payload.clusterKey}`,
    description: buildClusterMissionDescription(habitatId, payload),
    variables,
  };
}

/**
 * Derives the orphan-mission triage scope — preserves the legacy
 * `createOrphanTriageMission` title/description/clusterKey construction
 * exactly. The orphan clusterKey is `orphan-mission:${orphan.id}` (the
 * `orcy_triage investigate` agent branches on this prefix to load the
 * orphan-positioning flow).
 */
function deriveOrphanScope(orphan: Mission): DerivedTriageScope {
  const clusterKey = `orphan-mission:${orphan.id}`;
  const description = [
    "## Orphan mission (unmapped in the roadmap DAG)",
    `- Mission: ${orphan.title} (${orphan.id})`,
    `- Status: ${orphan.status}`,
    `- Priority: ${orphan.priority}`,
    "",
    "This mission has no dependency edges, so it is disconnected from the habitat's",
    "roadmap DAG. Investigate the roadmap (`roadmap` in the investigate response),",
    "decide where this mission fits, and position it via `orcy_triage",
    "map_orphan_mission` with the appropriate `dependsOn` (and a release-gate if",
    "release-coupling fits).",
    orphan.description ? `\n## Mission description\n${orphan.description}` : "",
  ].join("\n");
  return {
    clusterKey,
    sourceScopeKind: ORPHAN_MISSION_SCOPE_KIND,
    sourceScopeId: orphan.id,
    causalRootType: ORPHAN_MISSION_CAUSAL_ROOT_TYPE,
    title: `Triage: position orphan mission — ${orphan.title}`,
    description,
    variables: { clusterSubject: clusterKey },
  };
}

/**
 * Builds the cluster-triage Mission description — preserves the legacy
 * `buildMissionDescription` (triageService.ts:185-226) construction exactly,
 * including the proactive-resolution suggestion block. The only difference
 * from the legacy function is that this is called from the adapter's
 * derivation step (not the service entry point).
 */
function buildClusterMissionDescription(habitatId: string, payload: ClusterPayload): string {
  const lines: string[] = [
    "## Cluster",
    payload.clusterKey,
    "## Provenance Breakdown",
    JSON.stringify(payload.provenanceBreakdown, null, 2),
    "## Signal Count",
    String(payload.signalCount),
    "## Cross-Mission Count",
    String(payload.crossMissionCount),
    "## Distinct Agents",
    String(payload.distinctAgentCount),
    "## Affected Agents",
    payload.agentIds.join(", ") || "—",
    "## Affected Missions",
    payload.affectedMissionIds.join(", ") || "—",
    "## Time Window (days)",
    String(payload.timeWindowDays),
    "## First Seen",
    payload.firstSeenAt,
    "## Last Seen",
    payload.lastSeenAt,
  ];

  const proactive = triageResolutionsRepo.findByClusterKey(habitatId, payload.clusterKey);
  if (proactive.length > 0) {
    const top = proactive[0];
    lines.push(
      "## Proactive Suggestion (historical resolution)",
      `A prior resolution exists for this cluster (${top.resolvedAt}):`,
      `- Root cause: ${top.rootCause ?? "—"}`,
      `- Resolution: ${top.resolution ?? "—"}`,
      `- Kind: ${top.resolutionKind ?? "—"}`,
    );
  }

  lines.push(
    "## Task",
    "Investigate root cause, recommend a routing bucket, and post an analysis pulse with findings.",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Request fingerprint (deterministic content hash for same-key dedup)
// ---------------------------------------------------------------------------

/**
 * Computes the canonical request fingerprint for a triage publication.
 *
 * The fingerprint covers the RENDERED triage payload (title + description +
 * variables) + the clusterKey + the template id (so a same-key retry with the
 * same rendered content replays; a cluster-payload edit or template change
 * produces a different fingerprint → `rejected_fingerprint` on the same key,
 * forcing the scan to use a new key). It EXCLUDES provenance (actor/source/
 * clusterKey-as-scope) — the clusterKey IS the reservation scope, not the
 * payload, but it is ALSO a content discriminator (different cluster = both
 * different scope AND different content), so it is included here for
 * faithfulness to the rendered-content identity.
 *
 * Deterministic: object keys sorted recursively; unordered arrays (agentIds,
 * affectedMissionIds) sorted before hashing. Mirrors the Recovery + blocker
 * adapters' `computeRequestFingerprint` shape.
 */
function computeTriageFingerprint(scope: DerivedTriageScope): string {
  const payload = {
    templateId: TRIAGE_MISSION_TEMPLATE_ID,
    clusterKey: scope.clusterKey,
    title: scope.title,
    description: scope.description,
    variables: sortRecordKeys(scope.variables),
  };
  return "triage:" + stableHash(stableStringify(payload));
}

/** Deterministic JSON serializer — sorted object keys, stable array order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/** SHA-256 hex of the canonical stable-string serialization. */
function stableHash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Recursively sorts an object's keys for deterministic fingerprinting. */
function sortRecordKeys(record: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = record[key];
  return sorted;
}

// ---------------------------------------------------------------------------
// C2 atomic junction participant (the ONLY domain-extension point usage)
// ---------------------------------------------------------------------------

/**
 * Builds the triage-cluster-junction participant — the atomic-junction fix.
 *
 * The legacy path performs the junction write as a SEPARATE non-atomic step
 * AFTER `applyTemplate` commits:
 *   `triageClusterMissionsRepo.create(habitatId, clusterKey, missionId)`
 * using `getDb()` (which escapes the publication tx). A crash between the
 * `applyTemplate` commit + the junction commit leaves an orphan triage
 * Mission + scan re-fire.
 *
 * This participant moves the junction write INTO the T9A publication
 * transaction (on the passed tx client). The junction commits atomically WITH
 * the Mission + Tasks + Workflow + usage mutation: either ALL commit, or NONE
 * do. The crash window is eliminated.
 *
 * # Raw `tx.insert` (not a `*WithClient` repo primitive)
 *
 * Mirrors `buildRecoveryLinkageParticipant`'s raw `db.insert(...)` writes on
 * the tx client. The junction repo's `create()` is a thin insert wrapper; its
 * only semantic addition is the partial-unique-index UNIQUE-catch-and-re-read
 * idempotency, which this participant does NOT replicate (see the module
 * header's "Junction idempotency decision"). A raw insert is the faithful
 * translation; adding a `createWithClient` primitive to the junction repo
 * would be unnecessary surface area on a module whose modification scope is
 * sensitive.
 *
 * # The idempotency decision (let UNIQUE surface as a clean rollback)
 *
 * A raw `tx.insert` that hits the partial unique index `(habitatId,
 * clusterKey) WHERE status='open'` (migration 0046) THROWS → the whole
 * aggregate rolls back. The cluster + orphan scans pre-check
 * `findActiveByClusterKey` before spawning, so a UNIQUE hit is a genuine
 * concurrent-scan race (two scans won the pre-check in the same window).
 * Catching + re-reading inside the participant would mask the loser's
 * half-committed aggregate (Mission + Tasks + Workflow + usage committed, but
 * the junction points at the WINNER's mission → orphaned loser + duplicate
 * suppression failure). Letting the throw surface is correct: the loser's
 * scan-loop try/catch logs the rollback, the winner's aggregate survives, and
 * the next scan cycle's pre-check sees the winner's open junction → skips.
 *
 * @param habitatId  The Habitat the triage is scoped to.
 * @param clusterKey The cluster key (the junction row's discriminator + the
 *                    scan's active-triage suppression key).
 * @returns the {@link TemplateAggregateParticipantWriter} the adapter passes
 *   to `publishTemplateAggregateWithClient`.
 */
export function buildTriageClusterJunctionParticipant(
  habitatId: string,
  clusterKey: string,
): TemplateAggregateParticipantWriter {
  return (db, ctx) => {
    // The committed Mission id (id === prepared.mission.missionId). Written
    // to the junction's `mission_id` FK — `ON DELETE: cascade` (the junction
    // row is cleaned up if the Mission is ever deleted).
    const missionId = ctx.mission.id;

    // Raw insert on the tx client. A UNIQUE violation here is a concurrent-
    // scan race — the throw rolls back the whole aggregate (Mission + Tasks +
    // Workflow + usage + this junction insert). See the module header's
    // "Junction idempotency decision" for the rationale (catching + re-reading
    // would mask the loser's half-committed aggregate).
    db.insert(triageClusterMissions)
      .values({
        id: uuid(),
        habitatId,
        clusterKey,
        missionId,
        status: "open",
      })
      .run();
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Composes the T9A aggregate kernel chain for a triage-Mission publication
 * (Mission + N Tasks + optional Workflow + usage mutation + cluster junction),
 * all committed atomically inside ONE caller-owned transaction. DORMANT.
 *
 * The caller (the future T11 scan-caller wiring, DORMANT until then) supplies
 * the triage origin (cluster payload or orphan Mission) + the authoritative
 * Habitat. The adapter:
 *   1. derives the triage scope (title/description/variables/clusterKey/
 *      causal-root/scope-kind) from the origin;
 *   2. resolves server-constructed provenance (system actor `"triage"`,
 *      `"system"` source, `triage_cluster:<clusterKey>` /
 *      `orphan_mission:<orphanId>` causal root);
 *   3. PREPARES the complete aggregate via {@link prepareTemplateAggregate}
 *      (PURE validation);
 *   4. RESERVES N attempts (one per prepared Task), server-derived;
 *   5. PUBLISHES atomically via {@link publishTemplateAggregateWithClient}
 *      WITH the {@link buildTriageClusterJunctionParticipant junction
 *      participant} so the junction commits with the aggregate;
 *   6. MAPS the outcome to {@link TriageMissionPublicationResult}.
 *
 * # Visible blocked outcome
 *
 * NEVER returns `null` (the legacy path's swallowed error). Every expected
 * publication decision is a typed result branch. The `vetoed` branch is the
 * visible blocked outcome — NET-NEW for triage (today `applyTemplate` bypasses
 * governance entirely; this adapter removes the exemption). The scan daemon
 * (T11) translates `vetoed` into a blocked triage log entry; `published` maps
 * to the legacy `{missionId}` return shape (carried as `result.missionId`).
 *
 * # Infrastructure failures
 *
 * A repository throw (including the participant's own UNIQUE-violation throw
 * on a concurrent-scan race) propagates as a retryable runtime error. The
 * whole aggregate rolls back. The scan's outer try/catch logs the error + the
 * next cycle's `findActiveByClusterKey` pre-check suppresses re-firing if the
 * winner's junction committed.
 *
 * DORMANT: no production scan caller routes through this adapter yet. Legacy
 * `createTriageMission` + `createOrphanTriageMission` + their scan callers
 * (`triageScanService.ts:87`, `orphanScanService.ts:80`) stay byte-identical +
 * active until T11.
 */
export function publishTriageMission(
  input: TriageMissionPublicationInput,
): TriageMissionPublicationResult {
  const db = getDb();

  // ----- 0. Derive the triage scope (cluster vs orphan) ---------------------
  // Dispatches the title/description/variables/clusterKey/causal-root/scope-
  // kind derivation. Both origins share the SAME template + the SAME junction
  // table + the SAME publish core; they differ ONLY in this derivation.
  const scope: DerivedTriageScope =
    input.kind === "cluster"
      ? deriveClusterScope(input.habitatId, input.payload)
      : deriveOrphanScope(input.orphan);

  // Apply occurrence suffix to scope identity when provided (new occurrence of
  // a recurring cluster). The clusterKey in the scope is UNCHANGED so the
  // historical resolution lookup still finds prior resolutions; only the
  // attempt scope identity gets the suffix.
  if (input.kind === "cluster" && input.scopeSuffix) {
    scope.sourceScopeId = `${scope.sourceScopeId}:${input.scopeSuffix}`;
  }

  // ----- 0a. Server-constructed provenance ----------------------------------
  // Untrusted callers cannot assert these. The actor id preserves the legacy
  // system-origin identity (more descriptive than the bare "system" string for
  // observability); the source is the faithful enum value (matches the legacy
  // `applyTemplate(... "system")` audit source); the causal root is a fresh
  // root per triage origin (no inherited hops).
  const actor: AuditActorRef = { type: "system", id: TRIAGE_ACTOR_ID };
  const auditSource: AuditSource = TRIAGE_AUDIT_SOURCE;
  const causalContext: CausalContext = {
    root: { type: scope.causalRootType, id: scope.sourceScopeId },
  };

  // ----- 1. PREPARE (PURE validation + canonicalization) --------------------
  // Reuses the T9A decomposed preparation. The title/description/variables
  // mirror the legacy `applyTemplate` overrides EXACTLY (verified by the
  // derivation helpers), so a gate-wired caller produces a byte-identical
  // Mission + Tasks payload. The causal root is richer than the T9A default
  // (`mission_template:<id>`) — it carries the triage origin (clusterKey /
  // orphanId).
  const prepareCtx: PrepareTemplateAggregateContext = {
    actor,
    auditSource,
    causalContext,
  };
  const prepared = prepareTemplateAggregate(
    TRIAGE_MISSION_TEMPLATE_ID,
    input.habitatId,
    {
      title: scope.title,
      description: scope.description,
      variables: scope.variables,
    },
    prepareCtx,
  );

  if (prepared.outcome === "rejected_validation") {
    // Terminal rejection — NO governance, NO publish, NO junction. The legacy
    // path throws `repositoryNotFoundError` when `applyTemplate` returns null
    // (template missing); this adapter surfaces the richer `rejected_validation`
    // shape (template missing, column missing, workflow-variable missing, etc.)
    // collected by the PURE preparation step.
    return { outcome: "rejected_validation", errors: prepared.errors };
  }

  const aggregate = prepared.aggregate;
  const taskCount = aggregate.tasks.length;

  // ----- 2. RESERVE N attempts (one per prepared Task) ----------------------
  // The attempt identity is server-derived from the triage origin (clusterKey
  // / orphanId) + the per-Task slot (template + task index). Same-origin +
  // same-template + same-slot replay hits the same reservation key → replays
  // the stored terminal outcome (no duplicate Task). A different cluster or
  // template produces a distinct key. The fingerprint covers the RENDERED
  // payload (title/description/variables/clusterKey/templateId); a payload
  // edit under the same key → `rejected_fingerprint` (forces a new key).
  const requestFingerprint = computeTriageFingerprint(scope);

  const attemptIds: string[] = [];
  for (let i = 0; i < taskCount; i++) {
    // The per-Task attempt key is stable across (template, task index). For
    // the standard triage template (1 "investigate" Task) this is always
    // `${TRIAGE_MISSION_TEMPLATE_ID}-0`; a multi-Task triage template would
    // produce `${templateId}-0`, `${templateId}-1`, … Each per-Task attempt
    // lifecycle is independent (the kernel's checkpoint protocol forbids
    // sharing one attempt across N Tasks).
    const attemptKey = `${TRIAGE_MISSION_TEMPLATE_ID}-${i}`;
    const reservation = reserveAttemptWithClient(db, {
      source: auditSource,
      sourceScopeKind: scope.sourceScopeKind,
      sourceScopeId: scope.sourceScopeId,
      attemptKey,
      requestFingerprint,
      publicationKind: "create",
      habitatId: input.habitatId,
      actorType: "system",
      actorId: TRIAGE_ACTOR_ID,
      causalContext,
    });

    // 2a. Fingerprint mismatch → deterministic rejection (the rendered triage
    //     payload changed under the same key set — e.g. the cluster mutated
    //     between scans). The scan must use a new key set.
    if (reservation.outcome === "rejected_fingerprint") {
      return {
        outcome: "rejected_fingerprint",
        attemptId: reservation.attempt.id,
        reservedFingerprint: reservation.reservedFingerprint,
      };
    }

    const attempt = reservation.attempt;

    // 2b. REPLAY of a TERMINAL per-Task attempt → return the stored terminal
    //     result verbatim. NO governance, NO publish, NO side effect runs.
    //     The reservation scope is shared across all N per-Task attempts
    //     (same `sourceScopeId`), so a terminal attempt implies the prior
    //     aggregate under this key set already terminally resolved; the first
    //     decisive reservation's terminal state drives the adapter result
    //     (mirrors how Recovery/blocker handle their single attempt).
    if (TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
      const terminal: AttemptTerminalResult = attempt.terminalResult ?? {
        outcome: attempt.terminalOutcome ?? attempt.state,
      };
      return { outcome: "replayed", attemptId: attempt.id, terminal };
    }

    // 2c. REPLAY of a RECOVERING per-Task attempt (post-publish, pre-
    //     terminalization). The aggregate already committed under this key
    //     set; the adapter does NOT re-publish. For V1 dormancy, surface as
    //     a `replayed` result carrying the recovering state — T11 refines the
    //     reconstruction (the committed Mission + Tasks are read back from
    //     the durable envelope rows when the scan needs them). The dispatcher
    //     (T4A) + assignment coordinator (T5) advance the checkpoint; the
    //     terminal `created` surfaces via same-key replay once they settle.
    if (
      attempt.state === "published_pending_observation" ||
      attempt.state === "published_pending_assignment"
    ) {
      const terminal: AttemptTerminalResult = {
        outcome: attempt.state,
      };
      return { outcome: "replayed", attemptId: attempt.id, terminal };
    }

    // 2d. FRESH or PENDING-RESUME per-Task attempt → collect for publication.
    //     The T9A publisher's pre-tx governance + in-tx publication are
    //     idempotent because the governance ledger reuses matching decisions
    //     and the publication tx refuses to advance a non-pending attempt.
    attemptIds.push(attempt.id);
  }

  // ----- 3. PUBLISH (atomic, inside one caller-owned tx) -------------------
  // The junction participant composes the `triageClusterMissions` row into
  // the SAME tx as the aggregate (Mission + Tasks + Workflow + usage). A
  // participant throw (incl. the UNIQUE-violation race throw) rolls back the
  // whole aggregate — zero orphan Mission / partial Workflow / orphan
  // junction.
  const participants = buildTriageClusterJunctionParticipant(input.habitatId, scope.clusterKey);

  const publishOutcome = publishTemplateAggregateWithClient(db, {
    attemptIds,
    prepared: aggregate,
    participants,
  });

  // ----- 4. MAP the outcome -------------------------------------------------
  switch (publishOutcome.outcome) {
    case "published":
      return {
        outcome: "published",
        missionId: publishOutcome.mission.id,
        mission: publishOutcome.mission,
        tasks: publishOutcome.tasks,
        workflow: publishOutcome.workflow,
      };

    case "vetoed":
      // The visible blocked outcome (NET-NEW for triage — first governance
      // decision a triage Task ever carries). The tx never opened; zero
      // partial aggregate. T9A-04: pass through the milestone-1 publisher's
      // full `vetoes` list (every decisive Task-level veto, not first-veto).
      return {
        outcome: "vetoed",
        vetoes: publishOutcome.vetoes,
      };

    case "guard_mismatch":
      // Per-Task guard drift at publish time. The tx rolled back; the
      // per-Task attempts stay `pending` / resumable. The scan retries under
      // the SAME keys.
      return {
        outcome: "guard_mismatch",
        taskIndex: publishOutcome.taskIndex,
        reasons: publishOutcome.reasons,
      };

    case "governance_denied":
      // Stale governance decision at commit. The tx rolled back; the scan
      // re-governs under the SAME keys.
      return {
        outcome: "governance_denied",
        taskIndex: publishOutcome.taskIndex,
        kind: publishOutcome.kind,
        reason: publishOutcome.reason,
        ...(publishOutcome.interceptorKey !== undefined
          ? { interceptorKey: publishOutcome.interceptorKey }
          : {}),
      };
  }
}
