/**
 * Habitat Import Manifest v3 — DORMANT additive persistence.
 *
 * Mirrors the hand-written SQL in `drizzle/0057_import_attempts.sql` exactly
 * (MEMORY.md § Migration Plumbing — both the `.sql` AND the drizzle export
 * are required so `drizzle-kit generate` stays consistent). No production
 * caller routes through this table yet; T10A M4 ships the `reserveImportAttempt`
 * wrapper + the preflight pipeline that fills it, and the T11 cutover wires
 * the new manifest path behind `ORCY_CREATION_PUBLICATION_ENABLED`.
 *
 * The `import_attempts` table is the import analog of `scheduled_occurrences`
 * (T9A Phase 1 — `db/schema/taskPublication.ts:436-466`): the import-level
 * state machine (`reserved → publishing → published | rejected`) across the
 * post-commit observation window, the worker lease, the coordination attempt
 * link, and the terminal result. The state-machine primitives live in
 * `repositories/importAttempts.ts` (mirrors `repositories/scheduledOccurrences.ts`).
 *
 * Non-cascade design (load-bearing — mirrors `scheduled_occurrences`):
 *   `habitat_id` and `created_habitat_id` are plain TEXT (NO FK) — the import
 *   attempt is operational / audit history that outlives habitat replacement
 *   (a replacement Habitat import deletes + recreates the Habitat row,
 *   cascading to its Missions / Tasks / Comments, but the import attempt MUST
 *   survive). `attempt_id` (the coordination attempt of
 *   publicationKind:"habitat_import") is also plain TEXT (NO FK) — non-cascading
 *   by design, mirroring `scheduled_occurrences.attempt_id`. The import attempt
 *   is the durable operational/audit record; the coordination attempt may be
 *   aged out while the import attempt remains authoritative state.
 */
import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// Compact JSON column types (forward-compatible; refined in later milestones)
// ---------------------------------------------------------------------------

/**
 * Source-lineage payload captured at reservation time. Nullable because legacy
 * v1 inputs carry no lineage; for `identityPolicy:"restore"` this MUST be
 * present with `sourceHabitatId` non-null (the preflight enforces the rule).
 */
type ImportSourceLineageJson = {
  /** Source manifest id (chain reference for re-imports). */
  sourceManifestId?: string | null;
  /** Source habitat id (required for `restore`; null for `remap`). */
  sourceHabitatId?: string | null;
  /** When the source was generated (ISO timestamp). */
  sourceExportedAt?: string | null;
};

/**
 * Compact terminal result (success or failure detail) stamped by the
 * import-attempt publisher (T10B) or by `markImportAttemptRejectedWithClient`
 * on rejection. Loose envelope — readers narrow on `kind` / `reason`.
 */
type ImportAttemptResultJson = {
  /** Discriminator on success: `"import_published"` (T10B will set this). */
  kind?: "import_published";
  /** The committed habitat id (=== `import_attempts.created_habitat_id`). */
  habitatId?: string;
  /** Discriminator on failure: the rejection reason code. */
  reason?: string;
  /** Failure detail (errors, veto explanations, etc.). */
  errors?: unknown[];
  /** Optional retry-audit trail stamped by Repair-and-Retry (parallel to the
   *  scheduled-occurrence retryHistory; T10B-adjacent, future work). */
  retryHistory?: unknown[];
  /** Other free-form structured detail (T10B-extension territory). */
  [k: string]: unknown;
};

/**
 * Per-domain counts (portable / preserve / reset declared) + authority
 * context. Captured at reservation as the prepared-basis audit snapshot.
 */
type ImportManifestSummaryJson = {
  /** Per-domain count: how many portable entities the adapter emitted. */
  counts?: Record<string, number>;
  /** The declared dispositions (`replace` / `preserve` / `reset`) per domain. */
  dispositions?: Record<string, "replace" | "preserve" | "reset" | undefined>;
  /** Governing policy: `installation` for `mode:'new'`, `persisted_habitat`
   *  for `mode:'replacement'`. */
  governingPolicy?: "installation" | "persisted_habitat";
  /** Caller identity snapshot (audit). */
  actor?: { actorType: string; actorId: string };
};

// ---------------------------------------------------------------------------
// Import Attempts
// ---------------------------------------------------------------------------

/**
 * The import-attempt row. Tracks the import-level state machine and worker
 * lease across the post-commit observation window — the durable substrate the
 * T10B `publishImportAggregateWithClient` atomically terminalizes once the
 * per-Task aggregate publisher reaches its observation checkpoint.
 *
 * Non-cascade: `habitat_id` and `created_habitat_id` are plain TEXT (NO FK) —
 * the import attempt is operational / audit history that outlives habitat
 * replacement. Within-family: `attempt_id` cascades with the coordination
 * attempt it links to.
 */
export const importAttempts = sqliteTable(
  "import_attempts",
  {
    id: text("id").primaryKey(),

    // --- target habitat (plain text, non-cascading — outlives replacement) ---
    habitatId: text("habitat_id").notNull(),

    // --- mode + identity policy ---
    mode: text("mode", { enum: ["new", "replacement"] }).notNull(),
    identityPolicy: text("identity_policy", { enum: ["remap", "restore"] }).notNull(),

    // --- source lineage + manifest digest (the prepared basis) ---
    sourceLineage: text("source_lineage", { mode: "json" }).$type<ImportSourceLineageJson>(),
    manifestDigest: text("manifest_digest").notNull(),

    // --- state machine ---
    state: text("state", {
      enum: ["reserved", "publishing", "published", "rejected"],
    })
      .notNull()
      .default("reserved"),

    // --- coordination attempt (plain text — outlives the attempt it links) ---
    // Mirrors `scheduledOccurrences.attemptId` (T9A Phase 1 precedent): the
    // import attempt is operational / audit history that outlives the
    // coordination attempt (a `task_creation_attempts` row may be aged out /
    // cleaned up while the import attempt remains as the durable record).
    // Stamped by `setImportAttemptCoordinationAttemptIdWithClient` in M4's
    // reservation tx.
    attemptId: text("attempt_id"),

    // --- worker lease ---
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),

    // --- committed habitat id (plain text, non-cascading — outlives replacement) ---
    createdHabitatId: text("created_habitat_id"),

    // --- terminal result ---
    result: text("result", { mode: "json" }).$type<ImportAttemptResultJson>(),

    // --- prepared-basis audit snapshot (stamped at reservation) ---
    manifestSummary: text("manifest_summary", { mode: "json" })
      .$type<ImportManifestSummaryJson>()
      .notNull(),

    // --- rejection detail (when state = 'rejected') ---
    rejectionReason: text("rejection_reason"),

    // --- actor provenance ---
    actorType: text("actor_type", {
      enum: ["human", "agent", "system"],
    }).notNull(),
    actorId: text("actor_id").notNull(),

    // --- timestamps ---
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    index("idx_import_attempts_habitat").on(table.habitatId),
    index("idx_import_attempts_state").on(table.state),
    index("idx_import_attempts_lease").on(table.leaseOwner, table.leaseExpiresAt),
  ],
);
