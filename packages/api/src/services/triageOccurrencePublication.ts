/**
 * Structured-cluster Finding occurrence publication (restored Finding Triage
 * lifecycle — cluster intake).
 *
 * Restores production Finding admission at the Pattern Cluster / Triage
 * Mission boundary: classify new, corroborating, and genuinely recurring
 * evidence BEFORE publication, then atomically publish ONE first-writer-frozen
 * aggregate (Triage Mission + investigation Task + workflow + junction +
 * Finding admission/evidence/Pulse pointer) with exact evidence and
 * investigation provenance.
 *
 * # Pipeline (per scan cycle, per structured cluster)
 *
 *   1. REPAIR crash-stranded attempts (scan-time repair): every intake first
 *      looks up `pending` task-creation attempts scoped to THIS cluster's
 *      frozen occurrences, rechecks that no publishable candidate remains,
 *      and idempotently finalizes them as the legal
 *      `batch_rejected` + `suppressed_active_lifecycle` pair.
 *   2. CLASSIFY each structured identity `(habitatId, clusterKey, findingKind)`
 *      from the current window's finding Pulses:
 *        - no lineage           → NEW candidate (all current Pulses are
 *                                 admission evidence);
 *        - non-terminal latest  → ACTIVE (append only UNSEEN corroborating
 *                                 evidence; NEVER another investigation);
 *        - terminal latest      → lineage-wide + reset-baseline novelty
 *                                 subtraction → RECURRENCE candidate (post-
 *                                 cutoff novel Pulse ids only) or
 *                                 `evidence_already_accounted`;
 *        - `legacy_lineage_repair_required` → human-only, never auto-recur.
 *   3. NO publishable candidate → classified no-op (`suppressed` /
 *      `evidence_already_accounted`) with same-transaction corroboration for
 *      active identities. No Triage Mission, no investigation.
 *   4. DERIVE the canonical occurrence identity: versioned JCS + SHA-256 over
 *      sorted lifecycle identities, predecessors, and sorted novel Pulse ids.
 *      Mutable template/display state is EXCLUDED from identity.
 *   5. FREEZE via the short immediate insert-or-read winner protocol (see
 *      {@link freezeOccurrence}): one coherent template read → render →
 *      prepare the complete aggregate → validate exactly ONE `investigate`
 *      template key → `INSERT ... ON CONFLICT (snapshot_digest) DO NOTHING`.
 *      The winner freezes rendered payload + prepared aggregate + provenance
 *      + digest; a conflict loser REREADS the winning row inside the same
 *      reservation, DISCARDS every local value, and publishes only the
 *      winner's snapshot.
 *   6. RESERVE per-Task attempts scoped by the STABLE occurrence id
 *      (`sourceScopeKind='triage_occurrence'`, `sourceScopeId=occurrenceId`,
 *      fingerprint = occurrence id + winner's prepared digest) — a template
 *      edit can never manufacture a second occurrence for unchanged evidence.
 *   7. PUBLISH atomically through `publishTemplateAggregateWithClient` with
 *      the composed participant (cluster junction + Finding admission). The
 *      participant RECHECKS classification after the aggregate acquired its
 *      write lock; if every publishable candidate disappeared it throws
 *      {@link SuppressedActiveLifecycleError} (the whole aggregate rolls
 *      back) and the caller terminalizes the whole attempt set as the legal
 *      `batch_rejected` / `suppressed_active_lifecycle` pair in one immediate
 *      transaction. Governance decisions are immutable and untouched.
 *
 * # Serialization choice (the carried-forward closure-review risk)
 *
 * The frozen prepared aggregate is serialized as CANONICAL JSON (minimal
 * deterministic JCS — `occurrenceCanonicalization.ts`) of the COMPLETE
 * `PreparedTemplateAggregate` (prospective Mission data, every Task proposal
 * + guard + templateEntryMetadata + the now-carried immutable `templateKey`,
 * the resolved Workflow definition, usage descriptor, aggregate guard). The
 * digest is SHA-256 over that canonical string. Rehydration is a structural
 * `JSON.parse` — every field is JSON-native (strings/numbers/arrays/plain
 * objects; no Dates), so the round-trip is exact, and replay is INCAPABLE of
 * rereading template-derived content: the frozen string is the only input.
 *
 * See ADR-0048 and the restored lifecycle technical plan § "Cluster
 * admission, corroboration, and recurrence".
 */
import { getDb } from "../db/index.js";
import {
  pulses,
  findingTriageLineageRepairs,
  findingTriageLineageBaselineEvidence,
  taskCreationEnvelopes,
  triagePublicationOccurrences,
} from "../db/schema/index.js";
import { and, eq, inArray } from "drizzle-orm";
import type { ClusterPayload } from "@orcy/shared";
import {
  getByIdWithClient,
  findByIdentityWithClient,
  listEvidenceWithClient,
  admitWithClient,
  appendEvidenceWithClient,
  writeFindingTriageIdPointerWithClient,
  type FindingTriage,
} from "../repositories/findingTriage.js";
import { getTemplateById, TRIAGE_MISSION_TEMPLATE_ID } from "../repositories/template.js";
import {
  insertOrReadWithClient,
  listByCluster,
} from "../repositories/triagePublicationOccurrences.js";
import { reserveAttemptWithClient } from "../repositories/taskCreationAttempts.js";
import {
  TERMINAL_ATTEMPT_STATES,
  completeAttemptWithClient,
  type AttemptTerminalResult,
  type TaskPublicationDbClient,
} from "../repositories/taskPublication.js";
import { listPendingTaskCreationAttemptsForScopeWithClient } from "../repositories/taskCreationAttempts.js";
import {
  withImmediateLifecycleTransaction,
  type LifecycleOutcome,
} from "./findingTriageLifecycle.js";
import {
  prepareTemplateAggregate,
  type PreparedTemplateAggregate,
} from "./templateAggregatePreparation.js";
import {
  publishTemplateAggregateWithClient,
  type TemplateAggregateParticipantWriter,
  type TemplateAggregateParticipantContext,
} from "./templateAggregatePublication.js";
import {
  deriveClusterScope,
  buildTriageClusterJunctionParticipant,
} from "./triageMissionPublication.js";
import {
  canonicalJson,
  sha256Hex,
  deriveOccurrenceIdentity,
  templateProvenanceDigest,
} from "./occurrenceCanonicalization.js";
import type { PublicationError } from "./taskPublicationPreparation.js";
import type {
  GuardMismatchReason,
  CommitAuthorizationDenialKind,
} from "./taskPublicationGuardVerify.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The one template key whose committed Task is the bounded investigation. */
const INVESTIGATE_TEMPLATE_KEY = "investigate";

/** Attempt-reservation scope kind for structured occurrence publications. */
const OCCURRENCE_SCOPE_KIND = "triage_occurrence";

/** System actor identity for structured occurrence publications. */
const OCCURRENCE_ACTOR_ID = "triage";

/** Hard bound on recurrence-lineage traversal (defensive against cycles). */
const LINEAGE_TRAVERSAL_BOUND = 100;

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** One structured finding Pulse in the current scan window. */
export interface StructuredEvidencePulse {
  id: string;
  createdAt: string;
  findingKind: string;
}

/** Input accepted by {@link intakeStructuredCluster}. */
export interface StructuredClusterIntakeInput {
  habitatId: string;
  /** The normalized cluster key (`normalize(pulse.subject)`). */
  clusterKey: string;
  /** The current window's structured finding Pulses (findingKind-bearing). */
  pulses: StructuredEvidencePulse[];
  /** The summary-only cluster payload driving the rendered Mission content. */
  payload: ClusterPayload;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Per-identity pre-publication classification. */
export type IdentityClassification =
  | { kind: "new"; findingKind: string; pulseIds: string[] }
  | { kind: "active"; findingKind: string; findingId: string; unseenPulseIds: string[] }
  | { kind: "recurrence"; findingKind: string; predecessorId: string; pulseIds: string[] }
  | { kind: "accounted"; findingKind: string }
  | { kind: "legacy_repair_required"; findingKind: string; findingId: string };

/** Whole-cluster classification (identities sorted by findingKind). */
export interface ClusterClassification {
  habitatId: string;
  clusterKey: string;
  identities: IdentityClassification[];
}

/**
 * Every Pulse id already accounted for by one lifecycle row: evidence-table
 * membership (all roles — `legacy_observed` is still accounted) UNION the
 * legacy `pulseId` column UNION the legacy `corroboratingPulseIds` JSON
 * projection. The evidence table is authoritative; the columns cover
 * pre-cutover rows whose membership was never backfilled.
 */
function accountedPulseIds(client: TaskPublicationDbClient, finding: FindingTriage): Set<string> {
  const accounted = new Set<string>([finding.pulseId, ...finding.corroboratingPulseIds]);
  for (const row of listEvidenceWithClient(client, finding.id)) {
    accounted.add(row.pulseId);
  }
  return accounted;
}

/**
 * Walks the complete `recurrenceOfId` lineage (visited set + hard bound) and
 * returns every lifecycle row in it, oldest-chain-end first.
 */
function lineageRows(client: TaskPublicationDbClient, latest: FindingTriage): FindingTriage[] {
  const chain: FindingTriage[] = [latest];
  const visited = new Set<string>([latest.id]);
  let cursor: FindingTriage | null = latest;
  while (cursor && cursor.recurrenceOfId && chain.length < LINEAGE_TRAVERSAL_BOUND) {
    if (visited.has(cursor.recurrenceOfId)) break; // cycle guard
    visited.add(cursor.recurrenceOfId);
    const predecessor = getByIdWithClient(client, cursor.recurrenceOfId);
    if (!predecessor) break;
    chain.push(predecessor);
    cursor = predecessor;
  }
  return chain;
}

/**
 * Loads the latest evidence-baselined-root reset (mode + cutoff + baseline
 * Pulse ids) for one identity, if any repair exists.
 */
function resetBaseline(
  client: TaskPublicationDbClient,
  habitatId: string,
  clusterKey: string,
  findingKind: string,
): { cutoff: string | null; baseline: Set<string> } | null {
  const repairs = client
    .select()
    .from(findingTriageLineageRepairs)
    .where(
      and(
        eq(findingTriageLineageRepairs.habitatId, habitatId),
        eq(findingTriageLineageRepairs.clusterKey, clusterKey),
        eq(findingTriageLineageRepairs.findingKind, findingKind),
        eq(findingTriageLineageRepairs.mode, "evidence_baselined_root"),
      ),
    )
    .all();
  if (repairs.length === 0) return null;
  // Latest repair wins (append-only ledger; a later reset re-baselines).
  const latest = repairs[repairs.length - 1];
  const baseline = new Set(
    client
      .select({ pulseId: findingTriageLineageBaselineEvidence.pulseId })
      .from(findingTriageLineageBaselineEvidence)
      .where(eq(findingTriageLineageBaselineEvidence.repairId, latest.id))
      .all()
      .map((row) => row.pulseId),
  );
  return { cutoff: latest.cutoffTimestamp ?? null, baseline };
}

/**
 * Classifies every structured identity under one writer-coherent read on the
 * supplied client. PURE reads — no writes, no decisions committed.
 */
export function classifyClusterIdentities(
  client: TaskPublicationDbClient,
  input: { habitatId: string; clusterKey: string; pulses: StructuredEvidencePulse[] },
): ClusterClassification {
  // Group window pulses by findingKind; order each group deterministically
  // (createdAt, id) so source-Pulse selection is stable.
  const byKind = new Map<string, StructuredEvidencePulse[]>();
  for (const pulse of input.pulses) {
    const bucket = byKind.get(pulse.findingKind);
    if (bucket) bucket.push(pulse);
    else byKind.set(pulse.findingKind, [pulse]);
  }

  const identities: IdentityClassification[] = [];
  for (const findingKind of [...byKind.keys()].sort()) {
    const windowPulses = byKind
      .get(findingKind)!
      .toSorted((a, b) =>
        a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
      );

    const rows = findByIdentityWithClient(client, input.habitatId, input.clusterKey, findingKind);

    // --- no lineage: NEW candidate ---------------------------------------
    if (rows.length === 0) {
      identities.push({
        kind: "new",
        findingKind,
        pulseIds: windowPulses.map((p) => p.id),
      });
      continue;
    }

    // --- non-terminal latest: ACTIVE (corroborate only) -------------------
    const activeRows = rows.filter((row) => row.status !== "resolved" && row.status !== "wontfix");
    if (activeRows.length > 0) {
      const latestActive = activeRows[activeRows.length - 1];
      const accounted = accountedPulseIds(client, latestActive);
      identities.push({
        kind: "active",
        findingKind,
        findingId: latestActive.id,
        unseenPulseIds: windowPulses.map((p) => p.id).filter((id) => !accounted.has(id)),
      });
      continue;
    }

    // --- terminal latest: recurrence / accounted / repair-blocked ----------
    const latest = rows[rows.length - 1];
    if (latest.legacyLineageRepairRequired) {
      identities.push({ kind: "legacy_repair_required", findingKind, findingId: latest.id });
      continue;
    }

    // Lineage-wide novelty subtraction: every Pulse id accounted anywhere in
    // the complete recurrence lineage.
    const accounted = new Set<string>();
    for (const row of lineageRows(client, latest)) {
      for (const id of accountedPulseIds(client, row)) accounted.add(id);
    }
    // Reset baseline: explicit baseline ids + the cutoff rule (pre-cutoff
    // evidence is accounted even if legacy metadata never enumerated it).
    const reset = resetBaseline(client, input.habitatId, input.clusterKey, findingKind);
    const novel = windowPulses.filter((pulse) => {
      if (accounted.has(pulse.id)) return false;
      if (reset) {
        if (reset.baseline.has(pulse.id)) return false;
        if (reset.cutoff && pulse.createdAt <= reset.cutoff) return false;
      }
      return true;
    });

    if (novel.length > 0) {
      identities.push({
        kind: "recurrence",
        findingKind,
        predecessorId: latest.id,
        pulseIds: novel.map((p) => p.id),
      });
    } else {
      identities.push({ kind: "accounted", findingKind });
    }
  }

  return { habitatId: input.habitatId, clusterKey: input.clusterKey, identities };
}

/** Publishable candidates only (new + recurrence), in classification order. */
function publishableCandidates(
  classification: ClusterClassification,
): Array<Extract<IdentityClassification, { kind: "new" | "recurrence" }>> {
  return classification.identities.filter(
    (identity): identity is Extract<IdentityClassification, { kind: "new" | "recurrence" }> =>
      identity.kind === "new" || identity.kind === "recurrence",
  );
}

// ---------------------------------------------------------------------------
// Occurrence identity
// ---------------------------------------------------------------------------

/** One publishable candidate in the canonical occurrence snapshot. */
export interface OccurrenceCandidateEntry {
  kind: "new" | "recurrence";
  findingKind: string;
  /** Sorted novel Pulse ids (admission evidence). */
  pulseIds: string[];
  /** Terminal predecessor id (recurrence only; null for new). */
  predecessorId: string | null;
}

/** The canonical candidate snapshot — identity input, nothing mutable. */
export interface OccurrenceCandidateSnapshot {
  v: number;
  habitatId: string;
  clusterKey: string;
  /** Sorted by findingKind. */
  candidates: OccurrenceCandidateEntry[];
}

/**
 * Builds the canonical candidate snapshot from the publishable candidates.
 * Sorted lifecycle identities, predecessors, and sorted novel Pulse ids —
 * template/display/rendered state is deliberately EXCLUDED.
 */
export function buildOccurrenceCandidateSnapshot(
  habitatId: string,
  clusterKey: string,
  classification: ClusterClassification,
): OccurrenceCandidateSnapshot {
  return {
    v: 1,
    habitatId,
    clusterKey,
    candidates: publishableCandidates(classification)
      .toSorted((a, b) => (a.findingKind < b.findingKind ? -1 : 1))
      .map((candidate) => ({
        kind: candidate.kind,
        findingKind: candidate.findingKind,
        pulseIds: [...candidate.pulseIds].sort(),
        predecessorId: candidate.kind === "recurrence" ? candidate.predecessorId : null,
      })),
  };
}

// ---------------------------------------------------------------------------
// Freeze: the short immediate insert-or-read winner protocol
// ---------------------------------------------------------------------------

/** The frozen rendered payload (winner-authoritative). */
export interface FrozenRenderedPayload {
  title: string;
  description: string;
  variables: Record<string, string>;
}

/** The winner-authoritative frozen publication inputs. */
export interface FrozenOccurrence {
  occurrenceId: string;
  snapshotDigest: string;
  /** True when THIS call won the insert (its local render was frozen). */
  fresh: boolean;
  rendered: FrozenRenderedPayload;
  prepared: PreparedTemplateAggregate;
  preparedDigest: string;
  /** The LOSER's locally prepared Mission id (diagnostic: proof it was discarded). */
  discardedLocalMissionId?: string;
}

type FreezeResult =
  | { kind: "frozen"; value: FrozenOccurrence }
  | { kind: "rejected_validation"; errors: PublicationError[] }
  | { kind: "rejected_investigate_key"; found: number };

/** Wraps a FreezeResult branch in the lifecycle command-result shape. */
function applied<T>(value: T): { outcome: "applied"; value: T } {
  return { outcome: "applied" as const, value };
}

/**
 * The insert-or-read winner protocol inside ONE immediate transaction: one
 * coherent template read → render → prepare the complete aggregate → validate
 * exactly one `investigate` key → canonicalize → insert-or-read the occurrence
 * row. The winner's locally rendered payload + prepared aggregate are frozen;
 * a conflict loser REREADS the winning row inside the same reservation and
 * discards EVERY local value.
 */
function freezeOccurrence(
  input: StructuredClusterIntakeInput,
  snapshot: OccurrenceCandidateSnapshot,
): LifecycleOutcome<FreezeResult> {
  return withImmediateLifecycleTransaction<FreezeResult>((client) => {
    // REPLAY FAST PATH: an existing occurrence with this digest is adopted
    // VERBATIM before any template read — a template edit or deletion can
    // never reject, duplicate, or reshape replay (the persisted aggregate is
    // the only input).
    const identity0 = deriveOccurrenceIdentity(snapshot);
    const existing = client
      .select()
      .from(triagePublicationOccurrences)
      .where(eq(triagePublicationOccurrences.snapshotDigest, identity0.snapshotDigest))
      .get();
    if (existing) {
      return applied({
        kind: "frozen",
        value: adoptWinnerRow(existing),
      });
    }

    // One coherent render from the live template + payload. deriveClusterScope
    // (title/description/variables, proactive-resolution block) and
    // prepareTemplateAggregate (template + column reads) run on the SAME
    // connection as this reservation, so the render is coherent.
    const scope = deriveClusterScope(input.habitatId, input.payload);

    const prepared = prepareTemplateAggregate(
      TRIAGE_MISSION_TEMPLATE_ID,
      input.habitatId,
      { title: scope.title, description: scope.description, variables: scope.variables },
      { actor: { type: "system", id: OCCURRENCE_ACTOR_ID }, auditSource: "system" },
    );
    if (prepared.outcome === "rejected_validation") {
      return applied({ kind: "rejected_validation", errors: prepared.errors });
    }

    // Exactly one `investigate` key is MANDATORY before anything freezes.
    const investigateCount = prepared.aggregate.tasks.filter(
      (task) => task.templateKey === INVESTIGATE_TEMPLATE_KEY,
    ).length;
    if (investigateCount !== 1) {
      return applied({ kind: "rejected_investigate_key", found: investigateCount });
    }

    const identity = deriveOccurrenceIdentity(snapshot);
    const canonicalPrepared = canonicalJson(prepared.aggregate);
    const preparedDigest = sha256Hex(canonicalPrepared);
    const template = getTemplateById(TRIAGE_MISSION_TEMPLATE_ID);

    const result = insertOrReadWithClient(client, {
      id: identity.occurrenceId,
      habitatId: input.habitatId,
      clusterKey: input.clusterKey,
      occurrenceVersion: snapshot.v,
      candidateSnapshot: identity.canonicalSnapshot,
      snapshotDigest: identity.snapshotDigest,
      renderedPayload: canonicalJson({
        title: scope.title,
        description: scope.description,
        variables: scope.variables,
      }),
      preparedAggregate: canonicalPrepared,
      preparedDigest,
      templateId: TRIAGE_MISSION_TEMPLATE_ID,
      templateDigest: template
        ? templateProvenanceDigest({
            id: template.id,
            titlePattern: template.titlePattern,
            descriptionPattern: template.descriptionPattern,
            priority: template.priority,
            labels: template.labels,
            tasksTemplate: template.tasksTemplate ?? [],
            workflowTemplate: template.workflowTemplate ?? null,
          })
        : "unknown",
    });

    if (result.winner) {
      return applied({
        kind: "frozen",
        value: {
          occurrenceId: identity.occurrenceId,
          snapshotDigest: identity.snapshotDigest,
          fresh: true,
          rendered: {
            title: scope.title,
            description: scope.description,
            variables: scope.variables,
          },
          prepared: prepared.aggregate,
          preparedDigest,
        },
      });
    }

    // CONFLICT LOSER: discard every locally rendered/prepared value and adopt
    // the winner's frozen snapshot. This is the only reread-free replay source
    // — the mutable template is never consulted again for this occurrence.
    return applied({
      kind: "frozen",
      value: {
        ...adoptWinnerRow(result.row),
        discardedLocalMissionId: prepared.aggregate.mission.missionId,
      },
    });
  });
}

/** Adopts a persisted winning row wholesale — the loser/replay source of truth. */
function adoptWinnerRow(row: typeof triagePublicationOccurrences.$inferSelect): FrozenOccurrence {
  return {
    occurrenceId: row.id,
    snapshotDigest: row.snapshotDigest,
    fresh: false,
    rendered: JSON.parse(row.renderedPayload) as FrozenRenderedPayload,
    prepared: JSON.parse(row.preparedAggregate) as PreparedTemplateAggregate,
    preparedDigest: row.preparedDigest,
  };
}

// ---------------------------------------------------------------------------
// Freeze-only entry (staged contention protocol / diagnostics)
// ---------------------------------------------------------------------------

/** Serializable freeze summary (IPC-friendly). */
export interface OccurrenceFreezeSummary {
  occurrenceId: string;
  snapshotDigest: string;
  /** True when THIS call's local render became the frozen authority. */
  fresh: boolean;
  /** The frozen (winner) prospective Mission id. */
  frozenMissionId: string;
  /** The caller's LOCALLY prepared Mission id (differs from frozen iff loser). */
  localMissionId: string | null;
  /** The frozen first investigate Task title (template-derived content). */
  frozenInvestigateTitle: string;
}

/**
 * Classification + occurrence identity + the insert-or-read winner protocol,
 * WITHOUT attempt reservation or publication. Used by the cross-process
 * contention discriminator (the staged OCCUR/PUBLISH worker protocol) and any
 * caller that needs the frozen occurrence without publishing.
 */
export function freezeOccurrenceForIntake(
  input: StructuredClusterIntakeInput,
):
  | { outcome: "frozen"; summary: OccurrenceFreezeSummary }
  | { outcome: "busy"; retryAfterMs: number }
  | { outcome: "rejected_validation"; errors: PublicationError[] }
  | { outcome: "rejected_investigate_key"; found: number } {
  const db = getDb();
  const classification = classifyClusterIdentities(db, input);
  if (publishableCandidates(classification).length === 0) {
    throw new Error(
      `freezeOccurrenceForIntake: no publishable candidate for cluster ${input.clusterKey} (classification is a no-op).`,
    );
  }
  const snapshot = buildOccurrenceCandidateSnapshot(
    input.habitatId,
    input.clusterKey,
    classification,
  );
  const frozen = freezeOccurrence(input, snapshot);
  if (frozen.outcome === "busy") return { outcome: "busy", retryAfterMs: frozen.retryAfterMs };
  if (frozen.outcome !== "applied") {
    throw new Error(`freezeOccurrence returned unexpected outcome "${frozen.outcome}".`);
  }
  if (frozen.value.kind !== "frozen") {
    return frozen.value.kind === "rejected_validation"
      ? { outcome: "rejected_validation", errors: frozen.value.errors }
      : { outcome: "rejected_investigate_key", found: frozen.value.found };
  }
  const value = frozen.value.value;
  const investigate = value.prepared.tasks.find(
    (task) => task.templateKey === INVESTIGATE_TEMPLATE_KEY,
  )!;
  return {
    outcome: "frozen",
    summary: {
      occurrenceId: value.occurrenceId,
      snapshotDigest: value.snapshotDigest,
      fresh: value.fresh,
      frozenMissionId: value.prepared.mission.missionId,
      localMissionId: value.fresh
        ? value.prepared.mission.missionId
        : (value.discardedLocalMissionId ?? null),
      frozenInvestigateTitle: investigate.proposal.title,
    },
  };
}

// ---------------------------------------------------------------------------
// Suppression finalization + scan-time repair
// ---------------------------------------------------------------------------

/** Terminal outcome stamped on suppressed publication attempts. */
export const SUPPRESSED_TERMINAL_OUTCOME = "suppressed_active_lifecycle";

/** In-tx signal: every publishable candidate disappeared after the aggregate acquired its write lock. */
export class SuppressedActiveLifecycleError extends Error {
  constructor(public readonly occurrenceId: string) {
    super(
      `Structured occurrence "${occurrenceId}" suppressed: every publishable candidate disappeared (active lifecycle) before admission.`,
    );
    this.name = "SuppressedActiveLifecycleError";
  }
}

/**
 * Terminalizes the whole pending attempt set for one occurrence scope in ONE
 * immediate transaction as the LEGAL `batch_rejected` final state +
 * `suppressed_active_lifecycle` terminal outcome. Idempotent: already-terminal
 * attempts are `no_op` and never overwritten. Governance decisions live in a
 * separate immutable ledger and are untouched.
 */
function finalizeSuppressedAttempts(occurrenceId: string): string[] {
  const outcome = withImmediateLifecycleTransaction<string[]>((client) => {
    const pending = listPendingTaskCreationAttemptsForScopeWithClient(client, occurrenceId);
    const finalized: string[] = [];
    for (const attempt of pending) {
      const result = completeAttemptWithClient(client, attempt.id, {
        finalState: "batch_rejected",
        terminalOutcome: SUPPRESSED_TERMINAL_OUTCOME,
        terminalResult: { outcome: SUPPRESSED_TERMINAL_OUTCOME, attemptId: attempt.id },
      });
      if (result.outcome === "completed" || result.outcome === "no_op") {
        finalized.push(attempt.id);
      }
    }
    return { outcome: "applied" as const, value: finalized };
  });
  return outcome.outcome === "applied" ? outcome.value : [];
}

/**
 * Whether any of the occurrence's frozen candidates is STILL publishable
 * against live state. Uses the frozen snapshot's Pulse ids + identities so a
 * repair decision never depends on the current scan window.
 */
function frozenCandidateStillPublishable(
  client: TaskPublicationDbClient,
  habitatId: string,
  clusterKey: string,
  snapshot: OccurrenceCandidateSnapshot,
): boolean {
  // Rehydrate window pulses for the snapshot's ids from the pulses table
  // (createdAt drives the reset-cutoff rule).
  const snapshotPulseIds = snapshot.candidates.flatMap((candidate) => candidate.pulseIds);
  if (snapshotPulseIds.length === 0) return false;
  const rows = client
    .select({ id: pulses.id, createdAt: pulses.createdAt })
    .from(pulses)
    .where(inArray(pulses.id, snapshotPulseIds))
    .all();
  const createdAtById = new Map(rows.map((row) => [row.id, row.createdAt]));

  const classification = classifyClusterIdentities(client, {
    habitatId,
    clusterKey,
    pulses: snapshot.candidates.flatMap((candidate) =>
      candidate.pulseIds
        .filter((id) => createdAtById.has(id))
        .map((id) => ({
          id,
          createdAt: createdAtById.get(id)!,
          findingKind: candidate.findingKind,
        })),
    ),
  });

  for (const candidate of snapshot.candidates) {
    const live = classification.identities.find(
      (identity) => identity.findingKind === candidate.findingKind,
    );
    if (!live) continue;
    if (live.kind === "new") return true;
    if (live.kind === "recurrence" && live.pulseIds.some((id) => candidate.pulseIds.includes(id))) {
      return true;
    }
  }
  return false;
}

/**
 * Scan-time repair of crash-stranded attempts: for every frozen occurrence of
 * this cluster with pending attempts, recheck that no publishable candidate
 * remains; if none does, idempotently finalize the attempt set. A durable
 * occurrence row distinguishes this repair from unrelated pending work.
 */
export function repairStrandedOccurrenceAttempts(habitatId: string, clusterKey: string): string[] {
  const db = getDb();
  const finalized: string[] = [];
  for (const occurrence of listByCluster(habitatId, clusterKey)) {
    const pending = listPendingTaskCreationAttemptsForScopeWithClient(db, occurrence.id);
    if (pending.length === 0) continue;

    const snapshot = JSON.parse(occurrence.candidateSnapshot) as OccurrenceCandidateSnapshot;
    if (frozenCandidateStillPublishable(db, habitatId, clusterKey, snapshot)) continue;

    finalized.push(...finalizeSuppressedAttempts(occurrence.id));
  }
  return finalized;
}

// ---------------------------------------------------------------------------
// Admission participant (inside the aggregate publication transaction)
// ---------------------------------------------------------------------------

/** Mutable collector so the participant's writes surface in the intake result. */
export interface AdmissionCollector {
  admittedFindingIds: string[];
  recurredFindingIds: string[];
  corroboratedPulseIds: string[];
  investigationTaskId: string | null;
}

/**
 * Builds the Finding-admission participant: cluster junction + admission of
 * new candidates + recurrence of terminal identities + corroboration of active
 * identities + exact evidence membership + write-once Pulse pointers — all on
 * the publication transaction client, so a failure rolls back Mission, Tasks,
 * workflow, junction, Findings, evidence, and Pulse pointers TOGETHER.
 *
 * The participant RECHECKS classification first (the aggregate has acquired
 * its write lock by now); if every publishable candidate disappeared it throws
 * {@link SuppressedActiveLifecycleError} for a classified suppression.
 */
export function buildFindingAdmissionParticipant(input: {
  habitatId: string;
  clusterKey: string;
  occurrenceId: string;
  pulses: StructuredEvidencePulse[];
  collector: AdmissionCollector;
}): TemplateAggregateParticipantWriter {
  return (db, ctx) => {
    // The exactly-one-investigate map: the committed Task for the
    // `investigate` template key. Derived ONLY from the prepared aggregate
    // (never an index, title, or template reread).
    const investigateIndex = ctx.prepared.tasks.findIndex(
      (task) => task.templateKey === INVESTIGATE_TEMPLATE_KEY,
    );
    if (investigateIndex < 0 || !ctx.tasks[investigateIndex]) {
      throw new Error(
        `Finding admission participant: prepared aggregate carries no committed "${INVESTIGATE_TEMPLATE_KEY}" task (occurrence ${input.occurrenceId}).`,
      );
    }
    const investigationTaskId = ctx.tasks[investigateIndex].task.id;
    input.collector.investigationTaskId = investigationTaskId;
    const missionId = ctx.mission.id;

    // RECHECK after the aggregate acquired its write lock.
    const recheck = classifyClusterIdentities(db, {
      habitatId: input.habitatId,
      clusterKey: input.clusterKey,
      pulses: input.pulses,
    });
    const publishable = publishableCandidates(recheck);
    if (publishable.length === 0) {
      throw new SuppressedActiveLifecycleError(input.occurrenceId);
    }

    // Cluster junction FIRST (raw insert; a UNIQUE violation is a concurrent
    // race → throw → whole-aggregate rollback, per the T8A decision).
    buildTriageClusterJunctionParticipant(input.habitatId, input.clusterKey)(db, ctx);

    // Deterministic source-Pulse ordering (createdAt, id).
    const order = new Map<string, { createdAt: string; findingKind: string }>();
    for (const pulse of input.pulses) order.set(pulse.id, pulse);

    const now = new Date().toISOString();
    for (const identity of recheck.identities) {
      if (identity.kind === "new" || identity.kind === "recurrence") {
        const ordered = [...identity.pulseIds]
          .filter((id) => order.has(id))
          .toSorted((a, b) => {
            const ca = order.get(a)!.createdAt;
            const cb = order.get(b)!.createdAt;
            return ca === cb ? (a < b ? -1 : 1) : ca < cb ? -1 : 1;
          });
        if (ordered.length === 0) continue; // vanished evidence — not admissible

        const sourcePulseId = ordered[0];
        const finding = admitWithClient(db, {
          habitatId: input.habitatId,
          clusterKey: input.clusterKey,
          findingKind: identity.findingKind,
          pulseId: sourcePulseId,
          // Compatibility projection: admission evidence EXCLUDING the source
          // Pulse (fresh rows never include their source as corroboration).
          corroboratingPulseIds: ordered.slice(1),
          admittedByTriageMissionId: missionId,
          admittedByInvestigationTaskId: investigationTaskId,
          recurrenceOfId: identity.kind === "recurrence" ? identity.predecessorId : null,
          metadata: identity.kind === "recurrence" ? { admittedAsRecurrence: true } : {},
          createdAt: now,
        });

        appendEvidenceWithClient(db, {
          findingTriageId: finding.id,
          pulseIds: ordered,
          role: "source",
          admittedByTriageMissionId: missionId,
          admittedByInvestigationTaskId: investigationTaskId,
          admittedAt: now,
        });
        writeFindingTriageIdPointerWithClient(db, sourcePulseId, finding.id);

        if (identity.kind === "recurrence") {
          input.collector.recurredFindingIds.push(finding.id);
        } else {
          input.collector.admittedFindingIds.push(finding.id);
        }
      } else if (identity.kind === "active") {
        // Active identities receive ONLY unseen corroborating evidence and
        // NEVER publish another investigation.
        if (identity.unseenPulseIds.length === 0) continue;
        const appended = appendEvidenceWithClient(db, {
          findingTriageId: identity.findingId,
          pulseIds: identity.unseenPulseIds,
          role: "corroborating",
        });
        input.collector.corroboratedPulseIds.push(...appended.appendedPulseIds);
      }
      // accounted / legacy_repair_required: no writes. Legacy rows stay
      // human-repair-only; current-window membership for pre-cutover rows is
      // recorded as legacy_observed by the preflight/doctor surface, not here.
    }
  };
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Closed structured-cluster intake result. */
export type StructuredClusterIntakeResult =
  | {
      outcome: "published";
      occurrenceId: string;
      missionId: string;
      admittedFindingIds: string[];
      recurredFindingIds: string[];
      corroboratedPulseIds: string[];
      investigationTaskId: string;
    }
  | {
      outcome: "replayed";
      occurrenceId: string;
      missionId: string | null;
      attemptId: string;
      terminal: AttemptTerminalResult;
    }
  | {
      /** Classified no-op: no Triage Mission, no investigation, no junction. */
      outcome: "suppressed";
      reason: "all_active_lifecycles" | "evidence_already_accounted";
      corroboratedPulseIds: string[];
      finalizedAttempts: string[];
    }
  | { outcome: "rejected_validation"; errors: PublicationError[] }
  | { outcome: "rejected_investigate_key"; found: number }
  | { outcome: "busy"; retryAfterMs: number }
  | {
      outcome: "vetoed";
      vetoes: ReadonlyArray<{
        taskIndex: number;
        veto: { interceptorKey: string; reason: string; pluginRunId: string | null };
      }>;
    }
  | { outcome: "guard_mismatch"; taskIndex: number; reasons: GuardMismatchReason[] }
  | {
      outcome: "governance_denied";
      taskIndex: number;
      kind: CommitAuthorizationDenialKind;
      reason: string;
      interceptorKey?: string;
    }
  | { outcome: "rejected_fingerprint"; attemptId: string; reservedFingerprint: string };

// ---------------------------------------------------------------------------
// Intake entry point
// ---------------------------------------------------------------------------

/**
 * One structured-cluster intake: repair → classify → freeze (insert-or-read
 * winner) → reserve attempts under the stable occurrence scope → publish the
 * frozen aggregate atomically with the admission participant.
 *
 * The result is a closed decision union; infrastructure failures propagate as
 * retryable runtime errors (the whole aggregate rolls back — zero orphan
 * Mission/Task/junction/Finding/evidence/pointer).
 */
export function intakeStructuredCluster(
  input: StructuredClusterIntakeInput,
): StructuredClusterIntakeResult {
  const db = getDb();

  // 1. Scan-time repair of crash-stranded attempts (every intake path).
  const repairedAttempts = repairStrandedOccurrenceAttempts(input.habitatId, input.clusterKey);

  // 2. Classify.
  const classification = classifyClusterIdentities(db, input);
  const publishable = publishableCandidates(classification);

  // 3. No publishable candidate → classified no-op (+ corroboration).
  if (publishable.length === 0) {
    const hasActive = classification.identities.some((identity) => identity.kind === "active");
    let corroborated: string[] = [];
    if (hasActive) {
      const outcome = withImmediateLifecycleTransaction<string[]>((client) => {
        const appended: string[] = [];
        for (const identity of classification.identities) {
          if (identity.kind !== "active" || identity.unseenPulseIds.length === 0) continue;
          const result = appendEvidenceWithClient(client, {
            findingTriageId: identity.findingId,
            pulseIds: identity.unseenPulseIds,
            role: "corroborating",
          });
          appended.push(...result.appendedPulseIds);
        }
        return { outcome: "applied" as const, value: appended };
      });
      corroborated = outcome.outcome === "applied" ? outcome.value : [];
    }
    return {
      outcome: "suppressed",
      reason: hasActive ? "all_active_lifecycles" : "evidence_already_accounted",
      corroboratedPulseIds: corroborated,
      finalizedAttempts: repairedAttempts,
    };
  }

  // 4. Canonical occurrence identity (template/display state EXCLUDED).
  const snapshot = buildOccurrenceCandidateSnapshot(
    input.habitatId,
    input.clusterKey,
    classification,
  );

  // 5. Freeze (insert-or-read winner protocol).
  const frozen = freezeOccurrence(input, snapshot);
  if (frozen.outcome === "busy") {
    return { outcome: "busy", retryAfterMs: frozen.retryAfterMs };
  }
  if (frozen.outcome !== "applied") {
    // Defensive: freeze decisions are applied (validation rejections commit an
    // empty transaction) or busy — never conflict/replayed.
    throw new Error(
      `freezeOccurrence returned unexpected outcome "${frozen.outcome}" for cluster ${input.clusterKey}.`,
    );
  }
  if (frozen.value.kind === "rejected_validation") {
    return { outcome: "rejected_validation", errors: frozen.value.errors };
  }
  if (frozen.value.kind === "rejected_investigate_key") {
    return { outcome: "rejected_investigate_key", found: frozen.value.found };
  }
  const occurrence = frozen.value.value;

  // 6. Reserve per-Task attempts under the STABLE occurrence scope. The
  //    fingerprint covers the occurrence id + the WINNER's prepared digest —
  //    a template edit cannot manufacture a second occurrence for unchanged
  //    evidence, and the winner row is authoritative for replay.
  const requestFingerprint =
    "triage-occurrence:" + sha256Hex(`${occurrence.occurrenceId}:${occurrence.preparedDigest}`);
  const causalContext = { root: { type: OCCURRENCE_SCOPE_KIND, id: occurrence.occurrenceId } };

  const attemptIds: string[] = [];
  for (let i = 0; i < occurrence.prepared.tasks.length; i++) {
    const templateKey = occurrence.prepared.tasks[i].templateKey;
    const reservation = reserveAttemptWithClient(db, {
      source: "system",
      sourceScopeKind: OCCURRENCE_SCOPE_KIND,
      sourceScopeId: occurrence.occurrenceId,
      attemptKey: `occ:${templateKey}`,
      requestFingerprint,
      publicationKind: "create",
      habitatId: input.habitatId,
      actorType: "system",
      actorId: OCCURRENCE_ACTOR_ID,
      causalContext,
    });

    if (reservation.outcome === "rejected_fingerprint") {
      return {
        outcome: "rejected_fingerprint",
        attemptId: reservation.attempt.id,
        reservedFingerprint: reservation.reservedFingerprint,
      };
    }

    const attempt = reservation.attempt;
    if (TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
      const terminal: AttemptTerminalResult = attempt.terminalResult ?? {
        outcome: attempt.terminalOutcome ?? attempt.state,
      };
      return {
        outcome: "replayed",
        occurrenceId: occurrence.occurrenceId,
        missionId: attempt.committedMissionId ?? null,
        attemptId: attempt.id,
        terminal,
      };
    }
    if (
      attempt.state === "published_pending_observation" ||
      attempt.state === "published_pending_assignment"
    ) {
      const envelope = db
        .select()
        .from(taskCreationEnvelopes)
        .where(eq(taskCreationEnvelopes.attemptId, attempt.id))
        .all()[0];
      const terminal: AttemptTerminalResult = {
        outcome: attempt.state,
        ...(envelope?.taskId ? { taskId: envelope.taskId } : {}),
      };
      return {
        outcome: "replayed",
        occurrenceId: occurrence.occurrenceId,
        missionId: attempt.committedMissionId ?? null,
        attemptId: attempt.id,
        terminal,
      };
    }
    attemptIds.push(attempt.id);
  }

  // 7. Publish the frozen aggregate with the composed participant.
  const collector: AdmissionCollector = {
    admittedFindingIds: [],
    recurredFindingIds: [],
    corroboratedPulseIds: [],
    investigationTaskId: null,
  };
  const participants: TemplateAggregateParticipantWriter = (tx, ctx) => {
    buildFindingAdmissionParticipant({
      habitatId: input.habitatId,
      clusterKey: input.clusterKey,
      occurrenceId: occurrence.occurrenceId,
      pulses: input.pulses,
      collector,
    })(tx, ctx);
  };

  let publishOutcome;
  try {
    publishOutcome = publishTemplateAggregateWithClient(db, {
      attemptIds,
      prepared: occurrence.prepared,
      participants,
    });
  } catch (err) {
    if (err instanceof SuppressedActiveLifecycleError) {
      // The participant's recheck found no publishable candidate: the whole
      // aggregate rolled back; terminalize the attempt set as the LEGAL
      // suppressed pair (governance decisions remain immutable).
      const finalized = finalizeSuppressedAttempts(occurrence.occurrenceId);
      return {
        outcome: "suppressed",
        reason: "all_active_lifecycles",
        corroboratedPulseIds: [],
        finalizedAttempts: finalized,
      };
    }
    throw err;
  }

  switch (publishOutcome.outcome) {
    case "published":
      return {
        outcome: "published",
        occurrenceId: occurrence.occurrenceId,
        missionId: publishOutcome.mission.id,
        admittedFindingIds: collector.admittedFindingIds,
        recurredFindingIds: collector.recurredFindingIds,
        corroboratedPulseIds: collector.corroboratedPulseIds,
        investigationTaskId: collector.investigationTaskId ?? "",
      };
    case "vetoed":
      return { outcome: "vetoed", vetoes: publishOutcome.vetoes };
    case "guard_mismatch":
      return {
        outcome: "guard_mismatch",
        taskIndex: publishOutcome.taskIndex,
        reasons: publishOutcome.reasons,
      };
    case "governance_denied":
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
