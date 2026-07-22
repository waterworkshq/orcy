/**
 * Structural Source Identity — B3 helpers for the Habitat Import Manifest v3.
 *
 * v2 exports (`HabitatExportData`, `services/habitatService.ts:255-319`)
 * carry NO source IDs and NO lineage — Mission dependencies
 * (`dependsOn` / `blocks`) and comment references (`taskTitle` /
 * `parentTaskTitle`) are TITLE-keyed. The current v0.31 importer maps
 * titles to one id and SILENTLY OVERWRITES duplicates
 * (`habitatService.ts:547, :624`) — the B3 defect.
 *
 * T10A's correction:
 *   - Legacy v1 / v2 inputs are remap-only (the legacy adapter synthesizes
 *     deterministic structural source IDs from position / path so every
 *     exported entity has a stable identity within the manifest, even
 *     without source UUIDs).
 *   - AMBIGUOUS title references fail preflight with accumulated errors —
 *     never silently picked.
 *
 * This module ships the THREE helpers the legacy adapter (M2) + the
 * preflight pipeline (M4) consume:
 *
 *   - {@link synthesizeStructuralSourceId} — produces `legacy:mission[0]`,
 *     `legacy:mission[0].task[2]` style IDs from a position / path array.
 *     Deterministic; re-imports of the same legacy payload produce the same
 *     sourceIds.
 *   - {@link detectAmbiguousTitleRefs} — the B3 ambiguity detector.
 *     Walks the title-keyed ref graph + counts duplicates; returns an
 *     accumulated list of ambiguity errors (NEVER picks one — the contract).
 *   - {@link isNativeSourceId} — distinguishes native v3 source IDs (UUIDs
 *     emitted by the native v3 exporter — T10C) from legacy-synthesized IDs
 *     (the `legacy:` prefix). The preflight uses this to validate that the
 *     right ID space is being remapped.
 *
 * @see packages/api/src/services/importManifest/types.ts for the manifest v3
 *      portable shapes that carry `sourceId` fields.
 * @see T10A ticket § "Legacy identity contract (B3 correction)" for the full
 *      rationale.
 */

// ---------------------------------------------------------------------------
// Structural-source-ID synthesis (B3 helper)
// ---------------------------------------------------------------------------

/** Prefix that distinguishes legacy-synthesized source IDs from native v3
 *  source IDs. Native v3 IDs are UUIDs (or any non-`legacy:` prefix); legacy
 *  IDs always start with this prefix. */
export const LEGACY_SOURCE_ID_PREFIX = "legacy:";

/**
 * Synthesizes a deterministic structural source ID from a position / path
 * array. The legacy adapter (M2) walks the v2 input arrays, accumulating
 * `(entityKind, index)` pairs as it descends; this helper renders the path
 * as the canonical `legacy:<kind>[<index>].<kind>[<index>]...` string.
 *
 * # Determinism (load-bearing — B3)
 *
 * Re-imports of the same legacy payload MUST produce the same sourceIds
 * (the preflight uses `manifestDigest` for whole-manifest identity, but the
 * per-entity sourceIds are the per-entity reference keys the M4 preflight
 * uses to validate cross-domain references; mismatched IDs between imports
 * would silently drop cross-references). The path-to-string rendering is
 * therefore a PURE, side-effect-free function with no randomness.
 *
 * # Path shape
 *
 * The path is a flat array alternating `(entityKind, index)` pairs:
 *
 *   synthesizeStructuralSourceId([])                              → "legacy:"
 *   synthesizeStructuralSourceId(["mission", 0])                  → "legacy:mission[0]"
 *   synthesizeStructuralSourceId(["mission", 0, "task", 2])       → "legacy:mission[0].task[2]"
 *   synthesizeStructuralSourceId(["mission", 1, "subtask", 0])   → "legacy:mission[1].subtask[0]"
 *
 * `entityKind` is a free-form string (the legacy adapter uses canonical
 * segment names: `mission`, `task`, `subtask`, `comment`, `column`,
 * `template`); `index` is a non-negative integer (the position within the
 * parent's array). The helper validates the alternation — an ODD-length path
 * (the last element is a `entityKind` with no following index) throws an
 * `Error` (the caller has a bug).
 *
 * # Empty path
 *
 * `synthesizeStructuralSourceId([])` returns `"legacy:"` — the root of the
 * synthetic ID space (no entity kind, no index). This is reserved for the
 * legacy adapter's hypothetical root-level entities; in practice, every
 * emitted portable entity carries at least one path segment. The empty-path
 * shape is documented (not undefined behavior) so the helper's output is
 * total — the legacy adapter doesn't need to defend against the empty case
 * at every call site.
 *
 * # Why "legacy:" specifically (vs. UUIDs or random strings)
 *
 * The `legacy:` prefix lets {@link isNativeSourceId} distinguish the two
 * ID spaces at a glance. The preflight uses this to enforce:
 *   - a `legacy:` ID MAY be remapped to a fresh server-side UUID;
 *   - a native v3 ID MAY be preserved (when `identityPolicy:"restore"` is
 *     allowed AND the same-lineage proof holds).
 *
 * Mixing the two spaces (a `legacy:` ID accidentally landing on a v3
 * native shape, or vice versa) would silently corrupt the ID semantics.
 * The prefix is the guardrail.
 */
export function synthesizeStructuralSourceId(path: readonly (number | string)[]): string {
  // Empty path → "legacy:" (root of the synthetic ID space; reserved).
  if (path.length === 0) return LEGACY_SOURCE_ID_PREFIX;

  // Validate alternation: path elements alternate (entityKind, index),
  // (entityKind, index), ... starting with `entityKind` (a string) and
  // followed by `index` (a non-negative integer). An odd-length path is a
  // caller bug — surface it as a thrown Error so the call site is
  // diagnosable (vs. silently emitting a malformed sourceId).
  if (path.length % 2 !== 0) {
    throw new Error(
      `synthesizeStructuralSourceId: path length must be even (alternating (kind, index) pairs); got length ${path.length}: ${JSON.stringify(path)}`,
    );
  }

  const segments: string[] = [];
  for (let i = 0; i < path.length; i += 2) {
    const kind = path[i];
    const index = path[i + 1];
    if (typeof kind !== "string" || kind.length === 0) {
      throw new Error(
        `synthesizeStructuralSourceId: path[${i}] must be a non-empty entity-kind string; got ${JSON.stringify(kind)} in ${JSON.stringify(path)}`,
      );
    }
    if (!Number.isInteger(index) || (index as number) < 0) {
      throw new Error(
        `synthesizeStructuralSourceId: path[${i + 1}] must be a non-negative integer index; got ${JSON.stringify(index)} in ${JSON.stringify(path)}`,
      );
    }
    segments.push(`${kind}[${index}]`);
  }

  return `${LEGACY_SOURCE_ID_PREFIX}${segments.join(".")}`;
}

// ---------------------------------------------------------------------------
// Ambiguous-title detection (B3 contract)
// ---------------------------------------------------------------------------

/**
 * The title-keyed refs the legacy adapter extracts from a v2 source for the
 * ambiguity detector. The adapter walks the v2 input arrays, building the
 * title lists (the canonical count of each title's occurrences) + the
 * title-keyed reference graph (where each ref is `(fromTitle,
 * referencedTitle)`); the detector then ACCUMULATES the ambiguity errors.
 *
 * # Why a single object (vs. separate functions)
 *
 * M2's adapter hands the preflight a complete picture in one pass; the
 * detector consolidates the rules. Splitting into separate per-domain
 * functions would force the adapter to re-walk the input arrays multiple
 * times. A single object lets the detector iterate the graph efficiently.
 */
export interface TitleKeyedRefs {
  /** All mission titles from the source (the legacy adapter passes them
   *  in source order — the detector counts duplicates itself, no
   *  pre-aggregation needed). */
  missionTitles: readonly string[];
  /** Mission `dependsOn` refs (title-keyed) — the legacy v2 shape. */
  missionDependsOn: ReadonlyArray<{ fromTitle: string; referencedTitle: string }>;
  /** Mission `blocks` refs (title-keyed) — the legacy v2 shape. */
  missionBlocks: ReadonlyArray<{ fromTitle: string; referencedTitle: string }>;
  /** All task titles from the source. */
  taskTitles: readonly string[];
  /** Comment refs (title-keyed — the comment references the parent task by
   *  title; v2's `taskTitle` field on each CommentPortable). */
  taskCommentReferences: ReadonlyArray<{ referencedTaskTitle: string }>;
}

/**
 * An ambiguity error emitted by {@link detectAmbiguousTitleRefs}. The
 * preflight ACCUMULATES all ambiguity errors (per the plan's "preflight
 * reports every independently discoverable structural, validation, scope,
 * and governance failure" directive); the adapter surfaces them to the
 * caller as a typed `preflight_failed` outcome.
 *
 * # Why discriminated by `kind` (vs. a flat `message` field)
 *
 * Downstream readers (the preflight report UI, retry surfaces) dispatch on
 * `kind` to render the error with the right remediation hint. A flat
 * `message` would force string-matching, which is fragile across the i18n
 * boundary.
 */
export type AmbiguityError =
  | {
      kind: "duplicate_mission_title_in_dependsOn";
      /** The mission title that appears multiple times AND is referenced
       *  via `dependsOn`. */
      missionTitle: string;
      /** The titles of missions that reference the duplicate title via
       *  `dependsOn` — at least one element (the ref comes from
       *  somewhere). */
      fromMissionTitles: readonly string[];
    }
  | {
      kind: "duplicate_mission_title_in_blocks";
      missionTitle: string;
      fromMissionTitles: readonly string[];
    }
  | {
      kind: "duplicate_task_title_in_comment";
      /** The task title that appears multiple times AND is referenced by
       *  a comment via `taskTitle`. */
      taskTitle: string;
      /** The number of comments that reference the duplicate task title
       *  (for diagnostic display; the preflight refuses to proceed
       *  regardless of count). */
      commentRefCount: number;
    };

/**
 * Detects ambiguous title references in a legacy v2 input — the B3 contract.
 * The detector ACCUMULATES all independently discoverable ambiguity errors
 * (per the preflight discipline) and NEVER silently picks one — the legacy
 * importer's silent-overwrite behavior (`habitatService.ts:547, :624`) is
 * the defect T10A retires.
 *
 * # Algorithm (the contract)
 *
 *   For each mission title with ≥ 2 occurrences:
 *     If any `missionDependsOn.referencedTitle === missionTitle` → emit
 *       `duplicate_mission_title_in_dependsOn` (carrying the from-titles).
 *     If any `missionBlocks.referencedTitle === missionTitle` → emit
 *       `duplicate_mission_title_in_blocks` (carrying the from-titles).
 *
 *   For each task title with ≥ 2 occurrences:
 *     If any `taskCommentReferences.referencedTaskTitle === taskTitle` → emit
 *       `duplicate_task_title_in_comment` (carrying the ref count).
 *
 * # Determinism (load-bearing)
 *
 * The function MUST be PURE and DETERMINISTIC (same input → same output) so
 * the preflight's accumulated errors are reproducible across re-runs (a
 * caller retrying preflight after fixing some-but-not-all issues expects
 * the SAME remaining errors). The implementation iterates in source order;
 * the from-titles arrays preserve source order too.
 *
 * # Empty input
 *
 * An empty `TitleKeyedRefs` (no missions, no tasks, no refs) returns `[]` —
 * no ambiguities to detect. The preflight treats an empty result as "no
 * errors"; the adapter proceeds to emit the v3 shape.
 */
export function detectAmbiguousTitleRefs(refs: TitleKeyedRefs): AmbiguityError[] {
  const errors: AmbiguityError[] = [];

  // --- Mission-level ambiguity ---
  // Build a `title → count` map from the source's mission titles.
  const missionTitleCounts = countTitles(refs.missionTitles);
  const duplicateMissionTitles = new Set(
    [...missionTitleCounts.entries()].filter(([, n]) => n >= 2).map(([t]) => t),
  );

  // For each duplicate mission title, collect the from-titles of any
  // dependsOn / blocks refs that reference it.
  for (const title of duplicateMissionTitles) {
    const dependsOnFromTitles = refs.missionDependsOn
      .filter((r) => r.referencedTitle === title)
      .map((r) => r.fromTitle);
    if (dependsOnFromTitles.length > 0) {
      errors.push({
        kind: "duplicate_mission_title_in_dependsOn",
        missionTitle: title,
        fromMissionTitles: dependsOnFromTitles,
      });
    }

    const blocksFromTitles = refs.missionBlocks
      .filter((r) => r.referencedTitle === title)
      .map((r) => r.fromTitle);
    if (blocksFromTitles.length > 0) {
      errors.push({
        kind: "duplicate_mission_title_in_blocks",
        missionTitle: title,
        fromMissionTitles: blocksFromTitles,
      });
    }
  }

  // --- Task-level ambiguity ---
  // Same shape: build a `title → count` map, then check comment refs.
  const taskTitleCounts = countTitles(refs.taskTitles);
  const duplicateTaskTitles = new Set(
    [...taskTitleCounts.entries()].filter(([, n]) => n >= 2).map(([t]) => t),
  );

  for (const title of duplicateTaskTitles) {
    const refCount = refs.taskCommentReferences.filter(
      (r) => r.referencedTaskTitle === title,
    ).length;
    if (refCount > 0) {
      errors.push({
        kind: "duplicate_task_title_in_comment",
        taskTitle: title,
        commentRefCount: refCount,
      });
    }
  }

  return errors;
}

/**
 * Counts title occurrences. Internal helper — uses Map (insertion order
 * preserved) so the detector's iteration is deterministic.
 */
function countTitles(titles: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const title of titles) {
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Native vs. legacy source-ID classifier
// ---------------------------------------------------------------------------

/**
 * Returns `true` when `id` is a NATIVE v3 source ID (a UUID emitted by the
 * native v3 exporter — T10C), `false` when it's a LEGACY-synthesized ID
 * (the `legacy:` prefix from {@link synthesizeStructuralSourceId}).
 *
 * # Why prefix-match (vs. UUID regex)
 *
 * A strict UUID regex would be more specific — but the native v3 exporter
 * is not REQUIRED to emit UUIDs (it may emit opaque opaque tokens, namespaced
 * IDs, etc.). The prefix test is the CONVERSE: `legacy:` is the reserved
 * namespace; everything else is native. The preflight's downstream logic
 * only cares about the distinction, not the format of native IDs.
 *
 * # Why this matters (the preflight guard)
 *
 * The preflight uses this classifier to enforce ID-space consistency:
 *   - `identityPolicy:"restore"` is REFUSED when any portable entity's
 *     `sourceId` is a `legacy:` prefix (legacy exports carry no source IDs
 *     — restore requires same-lineage proof that title-keyed exports cannot
 *     provide; the B3 contract);
 *   - cross-domain reference resolution (a Task's `missionSourceId`
 *     resolving against the missions domain) only mixes IDs of the SAME
 *     space (native → native, legacy → legacy). Mixed-space references
 *     are a programming error — the legacy adapter emits a coherent legacy
 *     graph, the native exporter emits a coherent native graph.
 */
export function isNativeSourceId(id: string): boolean {
  return !id.startsWith(LEGACY_SOURCE_ID_PREFIX);
}
