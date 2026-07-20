/**
 * Habitat Import Manifest v3 — TypeScript types.
 *
 * The version-3 manifest contract: the import-side counterpart of the v0.31
 * legacy `HabitatExportData` (`boardService.ts` → `habitatService.ts` after
 * rename; v2 export). Distinct from the current `version: 2` export to avoid
 * dispatch collision — the `version` field is the dispatch key the legacy
 * adapter (`legacyAdapter.ts` — M2) routes on. Unknown versions fail preflight.
 *
 * Scope of M1: SHIP THE TYPES. The strict v3 zod schema is M4's concern
 * (the preflight pipeline consumes the strict schema after the legacy
 * adapter emits this shape from v1 / v2 inputs).
 *
 * # Design contract (the B3 / C4 corrections)
 *
 * Every portable entity carries a `sourceId` that's stable within the
 * manifest — native v3 UUIDs for new exports, or
 * {@link synthesizeStructuralSourceId} for legacy v1 / v2 inputs (the B3
 * correction: legacy exports carry no source IDs and no lineage; structural
 * IDs from position / path give every exported entity a stable identity
 * within the manifest even without source UUIDs).
 *
 * Forbidden v2 fields are EXPLICITLY absorbed per the C4 table (see T10A
 * ticket § "Forbidden-field absorption (C4 correction)"):
 *   - Task execution state (`status` / `result` / `artifacts` / etc.) →
 *     reset to pending / default on every imported Task. {@link TaskPortable}
 *     has no slot for execution state.
 *   - Mission `status` → dropped (MissionPortable has no slot).
 *   - Webhook / integration fields → NOT emitted as portable content.
 *   - Comment `authorId` → carried through as `author.importedAttribution`
 *     with `resolvedActorId: null` (T10B resolves at apply time).
 *   - Mission `dependsOn` / `blocks` (title-keyed) → re-keyed through
 *     structural IDs; ambiguous titles fail preflight.
 *
 * # Omitted domains ≠ deletion
 *
 * Domains NOT declared in {@link ManifestDomains} are preserve-by-default
 * (omitted ≠ delete). The webhooks / integrations / plugin enrollments /
 * schedules / automation rules / run / audit history / code evidence /
 * artifacts / worktrees / reviews / effort / retry state / credentials /
 * secrets / local orcys are NEVER deleted by an import — the v0.31 patches'
 * nonempty-payload heuristic is retired once explicit per-domain
 * dispositions make destructive intent unambiguous.
 *
 * # Per-domain dispositions
 *
 * Every declared domain carries its disposition EXPLICITLY (the v0.31 patch
 * conflated declared destructive intent with a content heuristic — T10A
 * separates the two via {@link DomainDisposition}).
 *
 * @see packages/api/src/services/importManifest/sourceIdentity.ts for the
 *      structural-source-ID helpers (`synthesizeStructuralSourceId`,
 *      `detectAmbiguousTitleRefs`, `isNativeSourceId`).
 * @see packages/api/src/db/schema/importManifest.ts for the import-attempt
 *      persistence schema (the `manifest_digest` + `manifest_summary` columns
 *      capture the prepared basis at reservation time).
 */
import type { TaskPriority } from "@orcy/shared";

// ---------------------------------------------------------------------------
// Top-level envelope (the manifest's outermost type)
// ---------------------------------------------------------------------------

/**
 * The Habitat Import Manifest v3 — the versioned, authority-safe,
 * identity-explicit import contract. Produced by:
 *   - the legacy adapter (`legacyAdapter.ts` — M2) for v1 / v2 inputs (after
 *     structural-ID synthesis + C4 field absorption + ambiguous-title
 *     rejection);
 *   - the native v3 exporter (`exportHabitat` — T10C, future) for new v3
 *     inputs;
 *   - identity passthrough (already-v3 inputs).
 *
 * The `version: 3` literal is the dispatch discriminator — the legacy adapter
 * reads `version` to choose `adaptV1` / `adaptV2` / passthrough. Unknown
 * versions fail preflight with `unknown_version`.
 */
export interface HabitatImportManifest {
  /** Version discriminator. ALWAYS `3` for this shape. The literal type
   *  prevents accidental cross-version assignment (the legacy adapter
   *  RETURNS `version: 3` from `adaptV1` / `adaptV2`). */
  version: 3;
  /** Caller-supplied stable id (the import-attempt key — the `import_attempts.id`
   *  primary key). The reservation tx uses this id verbatim. */
  manifestId: string;
  /** ISO timestamp the source generated the manifest. */
  generatedAt: string;
  /** Import mode. `new` creates a fresh habitat (the published target is
   *  in-tx-allocated); `replacement` updates an existing habitat (the
   *  target is `habitatId` — the route resolves access at the route level
   *  via `requireHabitatAccess` — T10C wires the replacement route). */
  mode: "new" | "replacement";
  /** Identity policy.
   *  - `remap` (default for legacy v1 / v2): every portable entity receives
   *    a fresh server-side id; structural source IDs remain the manifest-local
   *    reference.
   *  - `restore`: same-lineage proof required (the source `lineage` carries
   *    a non-null `sourceHabitatId` matching the target). Legacy v1 / v2
   *    inputs are remap-only (the B3 correction); the preflight refuses
   *    `restore` when `sourceHabitatId` is missing. */
  identityPolicy: "remap" | "restore";
  /** Source-lineage snapshot (required for `restore`; nullable for `remap`). */
  lineage: ManifestLineage;
  /** The declared domain envelopes. Omitted domains are preserve-by-default
   *  (omitted ≠ delete — see file header). */
  domains: ManifestDomains;
}

/**
 * Source-lineage snapshot. The preflight enforces:
 *   - for `identityPolicy:"restore"`: `sourceHabitatId` MUST be non-null (the
 *     caller is asserting same-lineage proof);
 *   - for `identityPolicy:"remap"`: all three fields MAY be null (legacy v1
 *     inputs typically carry none).
 *
 * `sourceManifestId` is the chain reference for re-imports (a subsequent
 * import of an already-imported habitat — the preflight can detect cycles
 * if desired; M4 may add the cycle-check rule).
 */
export interface ManifestLineage {
  /** Required for `restore`; null for `remap` of legacy inputs. */
  sourceHabitatId: string | null;
  /** When the source was generated (ISO timestamp). */
  sourceExportedAt: string | null;
  /** Chain reference for re-imports (the upstream manifest's id). */
  sourceManifestId: string | null;
}

// ---------------------------------------------------------------------------
// Per-domain envelope + disposition
// ---------------------------------------------------------------------------

/**
 * Every declared domain carries an EXPLICIT disposition. The v0.31 patch's
 * nonempty-payload heuristic (refuse to wipe on empty / malformed replace)
 * is retired once dispositions make destructive intent unambiguous:
 *   - `replace` — the import's portable content REPLACES the target's
 *     existing domain content (destructive; the preflight enforces the
 *     caller has authority to destroy the existing domain).
 *   - `preserve` — the import's portable content is APPLIED additively; the
 *     target's existing domain content is LEFT UNTOUCHED (the preflight
 *     captures the existing domain's entity ids in the
 *     `ImportPublicationGuard.preserveDomainTargets` snapshot).
 *   - `reset` — the import's portable content is APPLIED; the target's
 *     existing domain content is DELETED but NOT replaced by the import's
 *     content (the manifest explicitly carries no portable content for this
 *     domain). Webhook / integration domain is the canonical example: legacy
 *     v2 webhook configuration is NEVER reconstructed from portable content;
 *     `reset` clears the existing webhooks AND imports no new ones.
 */
export type DomainDisposition = "replace" | "preserve" | "reset";

/**
 * The domain envelope — wraps the per-domain portable data with its
 * declared disposition. The strict v3 zod schema (M4) validates
 * `DomainEnvelope<T>` per domain.
 *
 * Why an envelope (vs. a bare `T`): the disposition is the explicit
 * destructive-intent signal the v0.31 heuristic replaced. Without the
 * envelope, the preflight cannot distinguish "the manifest carries this
 * domain's portable content + declares `replace`" from "the manifest carries
 * this domain's portable content + declares `preserve`" — the two have
 * opposite destructive intent.
 */
export interface DomainEnvelope<T> {
  /** The declared disposition (the destructive-intent signal). */
  disposition: DomainDisposition;
  /** The portable content (validated by the domain handler — M3). */
  data: T;
}

// ---------------------------------------------------------------------------
// The 8 portable per-domain shapes
// ---------------------------------------------------------------------------

/**
 * Habitat-level planning settings (name, description, configuration JSON).
 * Replaces the v0.31 silent normalizations the C4 absorption table retires.
 */
export interface HabitatSettingsPortable {
  /** Source-local id. Stable within the manifest. */
  sourceId: string;
  /** Habitat display name. */
  name: string;
  /** Habitat description (free-form). */
  description: string;
  /** Planning configuration JSON (columns mode, sprint cadence, etc.). */
  settings: Record<string, unknown>;
}

/**
 * A single Mission column. v2 exports carry a flat `columnName` string on
 * each Task; v3 lifts columns to a first-class portable domain. The columns
 * domain's `nextColumnName` chain links to the resolved next-column per
 * status transition.
 */
export interface ColumnPortable {
  sourceId: string;
  /** Display name of the column (unique within the manifest). */
  name: string;
  /** Ordinal position (zero-based; the preflight enforces monotonicity). */
  order: number;
  /** Optional color (UI-only metadata). */
  color: string | null;
  /** Optional WIP limit (a planning-config field). */
  wipLimit: number | null;
  /** The next column in the workflow chain (a column name; resolved against
   *  the columns domain by the preflight). */
  nextColumnName: string | null;
  /** Whether this column represents a terminal state (done / cancelled). */
  isTerminal: boolean;
}

/**
 * A Mission — the planning unit that owns Tasks. Per the C4 absorption table,
 * v2 `status` is RESET to `not_started` (MissionPortable has no status slot).
 * Title-keyed `dependsOn` / `blocks` are re-keyed through structural IDs
 * (the legacy adapter runs {@link detectAmbiguousTitleRefs} before emitting).
 */
export interface MissionPortable {
  /** Source-local id. Stable within the manifest. */
  sourceId: string;
  title: string;
  description: string;
  /** Acceptance criteria (free-form markdown). */
  acceptanceCriteria: string;
  priority: TaskPriority;
  /** Free-form labels (used for filtering + UI grouping). */
  labels: string[];
  /** Resolved against the columns domain by the preflight. */
  columnName: string;
  /** Structural source IDs (NOT titles — the B3 correction). */
  dependsOnSourceIds: string[];
  blocksSourceIds: string[];
  /** ISO due date; null when unset. */
  dueAt: string | null;
}

/**
 * A Task — the unit of work. Per the C4 absorption table, v2 execution state
 * (`status` / `result` / `artifacts` / `assignedAgentId` / `rejectedCount` /
 * `rejectionReason` / retry fields) is RESET to pending / default. TaskPortable
 * has no slot for execution state — the legacy adapter strips these fields
 * and emits a warning per affected Task.
 */
export interface TaskPortable {
  sourceId: string;
  /** The parent mission's structural source ID (NOT a title — the B3
   *  correction). The preflight resolves this against the missions domain. */
  missionSourceId: string;
  title: string;
  description: string;
  priority: TaskPriority;
  /** Required execution domain (e.g. `"code_review"`, `"research"`). */
  requiredDomain: string | null;
  /** Required capabilities (UI surface picks up agent capabilities). */
  requiredCapabilities: string[];
}

/**
 * A Subtask (a checklist item nested under a Task). v2 carries inline
 * subtasks; v3 lifts them to a first-class portable domain so the preflight
 * can validate parent resolution + order uniqueness.
 */
export interface SubtaskPortable {
  sourceId: string;
  /** The parent Task's structural source ID. */
  taskSourceId: string;
  title: string;
  /** Ordinal position within the parent (zero-based). */
  order: number;
  /** Whether the subtask is checked (UI state). */
  completed: boolean;
  /** Optional assignee id (a local actor id; T10B resolves against the
   *  local actor table at apply time). */
  assigneeId: string | null;
}

/**
 * A Task-level dependency edge. The dependency graph (BOTH mission-level +
 * task-level) is validated for acyclicity + resolvability by the
 * `dependencies` domain handler (M3). The preflight ACCUMULATES ALL
 * independently discoverable failures (per the plan's "preflight reports
 * every independently discoverable structural, validation, scope, and
 * governance failure" directive).
 */
export interface DependencyPortable {
  sourceId: string;
  /** The dependent Task's structural source ID. */
  taskSourceId: string;
  /** The dependency target's structural source ID (must resolve against the
   *  tasks domain). */
  dependsOnTaskSourceId: string;
  /** Optional dependency kind (defaults to `blocks`). */
  kind: "blocks" | "relates_to" | "duplicates";
}

/**
 * A Mission comment (free-form text attached to a Task). Per the C4
 * absorption table, the v2 `authorId` is RESOLVED at apply time:
 * `author.resolvedActorId` carries a local actor id when known, OR
 * `author.importedAttribution` carries the original (free-form) attribution
 * string for documentation.
 */
export interface CommentPortable {
  sourceId: string;
  /** The parent Task's structural source ID (NOT a title — the B3
   *  correction). */
  taskSourceId: string;
  /** Optional parent comment's structural source ID (for threaded comments). */
  parentCommentSourceId: string | null;
  /** The comment body (markdown). */
  content: string;
  /** Resolved attribution. The legacy adapter emits `resolvedActorId: null`
   *  and `importedAttribution: <v2-authorId>`; T10B resolves `null` against
   *  the local actor table — unresolved → defaults to a documented imported-
   *  attribution identity per the plan. */
  author: {
    resolvedActorId: string | null;
    importedAttribution: string;
  };
  /** Author type (C4 absorption allows `remote_human` / `remote_orcy` for
   *  legacy v2 attribution that pre-dated the canonical actor taxonomy). */
  authorType: "human" | "agent" | "remote_human" | "remote_orcy";
  /** ISO timestamp the comment was authored. */
  authoredAt: string;
}

/**
 * A Mission template (a reusable Mission layout). Templates carry the same
 * portable Mission structure (minus the per-Mission dynamic state). The
 * default-template uniqueness rule is enforced by the `templates` domain
 * handler (M3).
 */
export interface TemplatePortable {
  sourceId: string;
  /** Template display name (unique within the manifest; the preflight
   *  enforces default-template uniqueness — at most one template may carry
   *  `isDefault: true`). */
  name: string;
  description: string;
  /** The template's portable content — Mission-shaped without dynamic state. */
  content: TemplateContentPortable;
  /** Whether this is the default template (used by the `missionTemplates`
   *  flow when no explicit template is selected). */
  isDefault: boolean;
}

/**
 * The portable Mission-shaped content of a template (no execution state,
 * no dynamic fields — just the layout primitives).
 */
export interface TemplateContentPortable {
  columns: ColumnPortable[];
  labels: string[];
  /** Per-Mission content the template seeds (mirrors {@link MissionPortable}
   *  minus `sourceId` + `columnName` — column resolution is template-scoped). */
  missions: Array<Omit<MissionPortable, "sourceId" | "columnName">>;
}

// ---------------------------------------------------------------------------
// The 8-domain envelope type (the manifest's `domains:` field shape)
// ---------------------------------------------------------------------------

/**
 * The manifest's `domains:` field — every declared domain is OPTIONAL
 * (omitted domains are preserve-by-default; omitted ≠ delete). Each declared
 * domain carries a {@link DomainEnvelope} with its per-domain portable shape.
 *
 * The 8 initial domains are the plan's portable set (Core Flows Flow 4 +
 * Technical Plan § "Portable domain matrix"). M3's domain handlers validate
 * each declared envelope; M4's preflight pipeline iterates them in
 * dependency order (columns before missions, missions before tasks, etc.).
 *
 * Domains NOT declared here (webhooks, integrations, plugin enrollments,
 * schedules, automation rules, run / audit history, code evidence,
 * artifacts, worktrees, reviews, effort, retry state, credentials, secrets,
 * local orcys) are preserve-by-default at the route level — the import
 * leaves them UNTOUCHED.
 */
export interface ManifestDomains {
  habitatSettings?: DomainEnvelope<HabitatSettingsPortable>;
  columns?: DomainEnvelope<ColumnPortable[]>;
  missions?: DomainEnvelope<MissionPortable[]>;
  tasks?: DomainEnvelope<TaskPortable[]>;
  subtasks?: DomainEnvelope<SubtaskPortable[]>;
  dependencies?: DomainEnvelope<DependencyPortable[]>;
  comments?: DomainEnvelope<CommentPortable[]>;
  templates?: DomainEnvelope<TemplatePortable[]>;
}

// ---------------------------------------------------------------------------
// Domain name union (the runtime domain identifier)
// ---------------------------------------------------------------------------

/**
 * The 8 portable domain names. Used by the {@link ManifestDomains} type's
 * keys, the M4 preflight iteration, and the M3 domain-handler registry.
 * Adding a 9th domain is additive: add the `DomainEnvelope<T>` field to
 * {@link ManifestDomains} + extend this union + register the M3 handler.
 */
export type ManifestDomainName =
  | "habitatSettings"
  | "columns"
  | "missions"
  | "tasks"
  | "subtasks"
  | "dependencies"
  | "comments"
  | "templates";

/**
 * Static list of all 8 portable domain names — the canonical iteration order
 * for the preflight pipeline (parents before dependents). Kept in sync with
 * {@link ManifestDomainName}.
 */
export const MANIFEST_DOMAIN_NAMES: readonly ManifestDomainName[] = [
  "habitatSettings",
  "columns",
  "missions",
  "tasks",
  "subtasks",
  "dependencies",
  "comments",
  "templates",
] as const;
