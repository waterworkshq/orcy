/**
 * Habitat Import Manifest v3 — Declared Legacy Adapter (v1/v2 → v3).
 *
 * The declared, versioned legacy-format adapter that translates v1
 * (`board`/`features`) and v2 (`habitat.missions`) imports into the manifest
 * v3 shape. Closes the silent-normalization concern (gap-audit R3 / D1) by
 * making the translation explicit + auditable — every transformation is
 * recorded in {@link AdaptedManifest.warnings}.
 *
 * # Purity (load-bearing)
 *
 * PURE transformation. No writes, no side effects, no `getDb()` calls. Input
 * is `unknown`; output is {@link AdaptedManifest} or a thrown error
 * ({@link UnknownManifestVersion} / {@link AmbiguousLegacyTitleError}).
 *
 * # Identity policy (B3)
 *
 * Legacy v1/v2 always `remap`. `restore` is refused at preflight (M4
 * enforces); the adapter always emits `identityPolicy: "remap"`. Legacy
 * exports carry no source IDs and no lineage — restore requires same-lineage
 * proof that title-keyed exports cannot provide.
 *
 * # C4 forbidden-field absorption
 *
 * See `types.ts` § "Design contract (the B3 / C4 corrections)". Every
 * absorption is recorded in `warnings` — never silent. The rules:
 *   - Task execution state (`status`/`result`/`artifacts`/`assignedAgentId`/
 *     retry fields) → dropped; warn per affected Task.
 *   - Mission execution state (`status`) → dropped; warn per affected Mission.
 *   - Webhook/integration fields → NOT emitted as portable content; warn per
 *     source entry found (the whole domain is preserve/reset only — never
 *     reconstructed from portable content).
 *   - Comment `authorId` → carried as `author.importedAttribution` with
 *     `resolvedActorId: null` (T10B resolves at apply time).
 *   - Mission `dependsOn`/`blocks` (title-keyed) → re-keyed through
 *     structural IDs (the ambiguous-title detection runs FIRST).
 *   - Planning config (columns, templates, labels, priority, requiredDomain,
 *     requiredCapabilities) → preserved as-is (within the v3 type's slots).
 *
 * # Ambiguity detection (B3 — accumulate, never silently resolve)
 *
 * Before re-keying title-based refs through structural IDs, the adapter runs
 * {@link detectAmbiguousTitleRefs}. If any ambiguities are found, the adapter
 * throws {@link AmbiguousLegacyTitleError} carrying ALL accumulated ambiguity
 * errors — never silently picks one (the B3 contract).
 *
 * # Dormancy (PRESERVE the legacy path)
 *
 * The adapter has NO caller until M4's preflight imports it. The legacy
 * `importHabitat` (`services/habitatService.ts:450-710`) + the `z.preprocess`
 * (`models/schemas.ts:265-280`) stay byte-identical + active until T11's
 * cutover. This module ships ALONGSIDE the legacy preprocess — it does NOT
 * modify or replace it.
 *
 * @see packages/api/src/services/importManifest/sourceIdentity.ts for the
 *      structural-source-ID + ambiguity-detection helpers (re-exported here
 *      for convenience; the canonical location is `sourceIdentity.ts`).
 * @see packages/api/src/services/importManifest/types.ts for the manifest v3
 *      portable shapes this adapter emits.
 * @see services/habitatService.ts:255-319 for `HabitatExportData` (the v2
 *      input shape this adapter consumes).
 */
import type { TaskPriority } from "@orcy/shared";
import {
  synthesizeStructuralSourceId,
  detectAmbiguousTitleRefs,
  type AmbiguityError,
} from "./sourceIdentity.js";
import type {
  HabitatImportManifest,
  HabitatSettingsPortable,
  ColumnPortable,
  MissionPortable,
  TaskPortable,
  CommentPortable,
  TemplatePortable,
  TemplateContentPortable,
  ManifestDomains,
} from "./types.js";

// Re-export the M1 helpers so consumers of the adapter have a single import
// surface. The canonical implementation stays in `sourceIdentity.ts`.
export {
  synthesizeStructuralSourceId,
  detectAmbiguousTitleRefs,
  type TitleKeyedRefs,
  type AmbiguityError,
} from "./sourceIdentity.js";

// ===========================================================================
// Errors
// ===========================================================================

/**
 * Thrown by {@link adaptUnknown} when the input's `version` field is anything
 * other than `1` or `2`. Carries the offending `version` value for diagnostic
 * display.
 *
 * Note: `version: 3` inputs are NOT routed through this adapter — they're
 * already v3 (the preflight passes them through). If `adaptUnknown` is called
 * with `version: 3`, it throws — the caller should pass v3 inputs through,
 * not adapt them. This is a deliberate guard against double-adaptation.
 */
export class UnknownManifestVersion extends Error {
  readonly version: unknown;

  constructor(version: unknown) {
    super(
      `UnknownManifestVersion: ${JSON.stringify(version)} (expected 1 or 2 for legacy adaptation)`,
    );
    this.name = "UnknownManifestVersion";
    this.version = version;
  }
}

/**
 * Thrown by {@link adaptV1} / {@link adaptV2} when the B3 ambiguity detector
 * ({@link detectAmbiguousTitleRefs}) finds any title-keyed references that
 * are ambiguous (duplicate mission titles referenced via `dependsOn`/
 * `blocks`, OR duplicate task titles referenced via comments). The error
 * carries ALL accumulated ambiguity errors — the contract is "never silently
 * pick one" (the B3 correction).
 *
 * The preflight (M4) surfaces these as a `preflight_failed` outcome.
 */
export class AmbiguousLegacyTitleError extends Error {
  readonly ambiguities: readonly AmbiguityError[];

  constructor(ambiguities: readonly AmbiguityError[]) {
    super(
      `AmbiguousLegacyTitleError: ${ambiguities.length} ambiguous title reference(s) — refusing to silently resolve (B3 contract)`,
    );
    this.name = "AmbiguousLegacyTitleError";
    this.ambiguities = ambiguities;
  }
}

// ===========================================================================
// Output shape + options
// ===========================================================================

/**
 * The legacy adapter's output. The `manifest` is v3-shape (always
 * `version: 3`); the `warnings` array carries every C4 absorption event
 * (per-Task, per-Mission, per-Webhook, per-Column, per-Template) + every
 * v1→v2 normalization event for audit.
 *
 * `warnings` is in SOURCE ORDER (deterministic — re-adapting the same input
 * produces the same warnings in the same order). This is load-bearing for
 * the preflight's reproducibility (a caller retrying after fixing some-but-
 * not-all issues expects the SAME remaining warnings).
 */
export interface AdaptedManifest {
  manifest: HabitatImportManifest;
  warnings: string[];
}

/**
 * Optional parameters for the adapter. The adapter is PURE — these are
 * caller-supplied identifiers the input alone cannot provide.
 *
 * - `manifestId`: the import-attempt key (caller-supplied stable id). If
 *   omitted, the adapter derives a stable id from the input
 *   (`legacy-adapted:<version>:<exportedAt>`). M4's preflight typically
 *   supplies a request-scoped id.
 * - `mode`: the import mode. Defaults to `"new"` (the route decides — the
 *   adapter does not infer mode from the input shape).
 */
export interface AdaptOptions {
  manifestId?: string;
  mode?: "new" | "replacement";
}

// ===========================================================================
// Public entry: adaptUnknown (version dispatch)
// ===========================================================================

/**
 * Version-dispatch wrapper. Reads `input.version` and routes:
 *   - `1` → {@link adaptV1}
 *   - `2` → {@link adaptV2}
 *   - anything else (including `3` — v3 inputs don't need adaptation) →
 *     throws {@link UnknownManifestVersion}.
 *
 * M4's preflight calls this when it needs to normalize an input of unknown
 * version. Callers that already know the version call `adaptV1` / `adaptV2`
 * directly.
 *
 * @throws {UnknownManifestVersion} when `version` is not `1` or `2`.
 */
export function adaptUnknown(input: unknown, options?: AdaptOptions): AdaptedManifest {
  const version = readField(input, "version");
  if (version === 1) return adaptV1(input, options);
  if (version === 2) return adaptV2(input, options);
  throw new UnknownManifestVersion(version);
}

// ===========================================================================
// V1 entry: board/features → habitat/missions → v3
// ===========================================================================

/**
 * Adapts a v1 input (`board` / `features` legacy shape) to manifest v3.
 *
 * The v1 → v2 shape normalization (top-level `board` → `habitat`;
 * habitat-level `features` → `missions`) is performed EXPLICITLY — the
 * silent `z.preprocess` in `models/schemas.ts:265-280` did this silently;
 * the adapter records each normalization as a warning (explicit over silent,
 * per the gap-audit R3 directive).
 *
 * After normalization, the input has the v2 shape and is handled by the
 * shared {@link adaptFromHabitatShape} workhorse.
 */
export function adaptV1(input: unknown, options?: AdaptOptions): AdaptedManifest {
  const warnings: string[] = [];
  const root = asRecord(input);
  if (!root) {
    throw new Error("adaptV1: input must be a non-null object");
  }

  // v1 → v2: top-level `board` → `habitat`.
  let habitatRaw: unknown = root.habitat;
  if (habitatRaw === undefined && root.board !== undefined) {
    warnings.push("v1 input: normalized top-level 'board' → 'habitat'");
    habitatRaw = root.board;
  }
  const habitat = asRecord(habitatRaw);
  if (!habitat) {
    throw new Error("adaptV1: input is missing 'habitat' (or 'board') object");
  }

  // v1 → v2: habitat-level `features` → `missions`.
  let missionsRaw: unknown = habitat.missions;
  if (missionsRaw === undefined && habitat.features !== undefined) {
    warnings.push("v1 input: normalized habitat 'features' → 'missions'");
    missionsRaw = habitat.features;
  }

  return adaptFromHabitatShape({
    rootRecord: root,
    habitat,
    missionsRaw,
    standaloneTasksRaw: habitat.tasks,
    commentsRaw: habitat.comments,
    templatesRaw: habitat.templates,
    columnsRaw: habitat.columns,
    webhooksRaw: habitat.webhooks,
    warnings,
    options,
  });
}

// ===========================================================================
// V2 entry: habitat.missions → v3
// ===========================================================================

/**
 * Adapts a v2 input (`habitat.missions` canonical shape) to manifest v3.
 *
 * v2 is the current export shape (`HabitatExportData`,
 * `services/habitatService.ts:255-319`). The adapter walks the v2 habitat
 * arrays, synthesizes structural source IDs, applies the C4 absorption rules,
 * runs the B3 ambiguity detector, and emits the v3 manifest.
 */
export function adaptV2(input: unknown, options?: AdaptOptions): AdaptedManifest {
  const warnings: string[] = [];
  const root = asRecord(input);
  if (!root) {
    throw new Error("adaptV2: input must be a non-null object");
  }

  const habitat = asRecord(root.habitat);
  if (!habitat) {
    throw new Error("adaptV2: input is missing 'habitat' object");
  }

  return adaptFromHabitatShape({
    rootRecord: root,
    habitat,
    missionsRaw: habitat.missions,
    standaloneTasksRaw: habitat.tasks,
    commentsRaw: habitat.comments,
    templatesRaw: habitat.templates,
    columnsRaw: habitat.columns,
    webhooksRaw: habitat.webhooks,
    warnings,
    options,
  });
}

// ===========================================================================
// Shared v2-shape adapter (the workhorse)
// ===========================================================================

interface HabitatShapeInput {
  rootRecord: Record<string, unknown>;
  habitat: Record<string, unknown>;
  missionsRaw: unknown;
  standaloneTasksRaw: unknown;
  commentsRaw: unknown;
  templatesRaw: unknown;
  columnsRaw: unknown;
  webhooksRaw: unknown;
  warnings: string[];
  options?: AdaptOptions;
}

/**
 * The shared workhorse. Walks the v2 habitat arrays + emits the v3 manifest.
 *
 * The walk is in SOURCE ORDER so warnings are deterministic. Structural
 * source IDs are synthesized via {@link synthesizeStructuralSourceId} (M1's
 * helper); the path segments encode the entity's position in the source tree.
 */
function adaptFromHabitatShape(args: HabitatShapeInput): AdaptedManifest {
  const {
    rootRecord,
    habitat,
    missionsRaw,
    standaloneTasksRaw,
    commentsRaw,
    templatesRaw,
    columnsRaw,
    webhooksRaw,
    warnings,
    options,
  } = args;

  // ----- 1. Habitat settings -----
  const habitatSettings = adaptHabitatSettings(habitat, warnings);

  // ----- 2. Columns -----
  const columns = adaptColumns(columnsRaw, warnings);

  // ----- 3. Missions + Tasks (interleaved walk for nested sourceIds) -----
  const missions = asArray(missionsRaw) ?? [];
  const standaloneTasks = asArray(standaloneTasksRaw) ?? [];

  const missionEntries: MissionEntry[] = [];

  for (let mIdx = 0; mIdx < missions.length; mIdx++) {
    const mission = asRecord(missions[mIdx]);
    if (!mission) {
      warnings.push(`mission[${mIdx}]: not an object — skipped`);
      continue;
    }
    const missionSourceId = synthesizeStructuralSourceId(["mission", mIdx]);

    const taskList = asArray(mission.tasks) ?? [];
    const taskEntries: TaskEntry[] = [];
    for (let tIdx = 0; tIdx < taskList.length; tIdx++) {
      const task = asRecord(taskList[tIdx]);
      if (!task) {
        warnings.push(`mission[${mIdx}].task[${tIdx}]: not an object — skipped`);
        continue;
      }
      const taskSourceId = synthesizeStructuralSourceId(["mission", mIdx, "task", tIdx]);
      taskEntries.push({ sourceId: taskSourceId, task });
    }
    missionEntries.push({
      sourceId: missionSourceId,
      mission,
      tasks: taskEntries,
      isSynthetic: false,
    });
  }

  // Standalone tasks (habitat.tasks) — v0.31 creates a synthetic Mission per
  // standalone Task (`habitatService.ts:583-609`). The adapter mirrors that
  // behavior so v3 manifests of standalone-task payloads reconstruct the same
  // Mission-per-Task structure.
  if (missions.length === 0 && standaloneTasks.length > 0) {
    const fallbackColumnName = firstColumnName(columns);
    for (let tIdx = 0; tIdx < standaloneTasks.length; tIdx++) {
      const task = asRecord(standaloneTasks[tIdx]);
      if (!task) {
        warnings.push(`standalone task[${tIdx}]: not an object — skipped`);
        continue;
      }
      const syntheticMissionIdx = missions.length + tIdx;
      const missionSourceId = synthesizeStructuralSourceId(["mission", syntheticMissionIdx]);
      const taskSourceId = synthesizeStructuralSourceId([
        "mission",
        syntheticMissionIdx,
        "task",
        0,
      ]);
      const taskTitle = asString(task.title) ?? `standalone-task-${tIdx}`;
      warnings.push(
        `standalone task '${taskTitle}' lifted to synthetic mission '${missionSourceId}' (v0.31 compatibility — habitat.tasks has no enclosing mission)`,
      );
      const syntheticMission: Record<string, unknown> = {
        title: taskTitle,
        description: asString(task.description) ?? "",
        acceptanceCriteria: "",
        priority: asString(task.priority) ?? "medium",
        labels: stringArrayField(task.labels),
        columnName: fallbackColumnName,
        status: "not_started",
        dependsOn: [],
        blocks: [],
        dueAt: null,
      };
      missionEntries.push({
        sourceId: missionSourceId,
        mission: syntheticMission,
        tasks: [{ sourceId: taskSourceId, task }],
        isSynthetic: true,
      });
    }
  }

  // ----- 4. Ambiguity detection (BEFORE re-keying — B3) -----
  // Build the title lists + title-keyed refs for the detector. The detector
  // ACCUMULATES all ambiguity errors; if any are found, throw carrying ALL.
  const missionTitles: string[] = missionEntries.map((e) => asString(e.mission.title) ?? "");
  const missionDependsOn: Array<{ fromTitle: string; referencedTitle: string }> = [];
  const missionBlocks: Array<{ fromTitle: string; referencedTitle: string }> = [];
  for (const entry of missionEntries) {
    const fromTitle = asString(entry.mission.title) ?? "";
    const depsArr = stringArrayField(entry.mission.dependsOn);
    for (const dep of depsArr) {
      missionDependsOn.push({ fromTitle, referencedTitle: dep });
    }
    const blocksArr = stringArrayField(entry.mission.blocks);
    for (const blk of blocksArr) {
      missionBlocks.push({ fromTitle, referencedTitle: blk });
    }
  }

  const taskTitles: string[] = [];
  for (const entry of missionEntries) {
    for (const t of entry.tasks) {
      taskTitles.push(asString(t.task.title) ?? "");
    }
  }

  const commentsArray = asArray(commentsRaw) ?? [];
  const taskCommentReferences: Array<{ referencedTaskTitle: string }> = [];
  for (const c of commentsArray) {
    const comment = asRecord(c);
    if (!comment) continue;
    const ref = asString(comment.taskTitle);
    if (ref !== undefined) {
      taskCommentReferences.push({ referencedTaskTitle: ref });
    }
  }

  const ambiguities = detectAmbiguousTitleRefs({
    missionTitles,
    missionDependsOn,
    missionBlocks,
    taskTitles,
    taskCommentReferences,
  });
  if (ambiguities.length > 0) {
    throw new AmbiguousLegacyTitleError(ambiguities);
  }

  // ----- 5. Title → sourceId maps (for re-keying) -----
  // First-occurrence wins; duplicates are caught by the ambiguity detector
  // above (when they're referenced) or silently de-duped here (when they're
  // NOT referenced — the ambiguity detector only flags referenced dupes).
  const missionTitleToSourceId = new Map<string, string>();
  for (const entry of missionEntries) {
    const title = asString(entry.mission.title);
    if (title !== undefined && !missionTitleToSourceId.has(title)) {
      missionTitleToSourceId.set(title, entry.sourceId);
    }
  }
  const taskTitleToSourceId = new Map<string, string>();
  for (const entry of missionEntries) {
    for (const t of entry.tasks) {
      const title = asString(t.task.title);
      if (title !== undefined && !taskTitleToSourceId.has(title)) {
        taskTitleToSourceId.set(title, t.sourceId);
      }
    }
  }

  // ----- 6. Emit MissionPortable + TaskPortable (re-keyed) -----
  const missionsPortable: MissionPortable[] = [];
  const tasksPortable: TaskPortable[] = [];

  for (const entry of missionEntries) {
    missionsPortable.push(
      adaptMission(entry.mission, entry.sourceId, missionTitleToSourceId, warnings),
    );
    for (const t of entry.tasks) {
      tasksPortable.push(adaptTask(t.task, t.sourceId, entry.sourceId, warnings));
    }
  }

  // ----- 7. Comments -----
  const exportedAt = asString(rootRecord.exportedAt) ?? "1970-01-01T00:00:00.000Z";
  const commentsPortable: CommentPortable[] = [];
  for (let cIdx = 0; cIdx < commentsArray.length; cIdx++) {
    const comment = asRecord(commentsArray[cIdx]);
    if (!comment) {
      warnings.push(`comment[${cIdx}]: not an object — skipped`);
      continue;
    }
    const taskTitle = asString(comment.taskTitle);
    if (taskTitle === undefined) {
      warnings.push(`comment[${cIdx}]: missing 'taskTitle' — dropped`);
      continue;
    }
    const taskSourceId = taskTitleToSourceId.get(taskTitle);
    if (!taskSourceId) {
      warnings.push(
        `comment[${cIdx}]: taskTitle '${taskTitle}' does not resolve to any task — dropped`,
      );
      continue;
    }
    const commentSourceId = synthesizeStructuralSourceId(["comment", cIdx]);
    commentsPortable.push(
      adaptComment(comment, commentSourceId, taskSourceId, exportedAt, warnings, cIdx),
    );
  }

  // ----- 8. Templates -----
  const templatesArray = asArray(templatesRaw) ?? [];
  const templatesPortable: TemplatePortable[] = [];
  for (let tplIdx = 0; tplIdx < templatesArray.length; tplIdx++) {
    const template = asRecord(templatesArray[tplIdx]);
    if (!template) {
      warnings.push(`template[${tplIdx}]: not an object — skipped`);
      continue;
    }
    const templateSourceId = synthesizeStructuralSourceId(["template", tplIdx]);
    templatesPortable.push(adaptTemplate(template, templateSourceId, warnings, tplIdx));
  }

  // ----- 9. Webhooks (C4: NOT emitted as portable; warn per source entry) -----
  const webhooksArray = asArray(webhooksRaw) ?? [];
  for (let wIdx = 0; wIdx < webhooksArray.length; wIdx++) {
    const webhook = asRecord(webhooksArray[wIdx]);
    const webhookName = (webhook && asString(webhook.name)) ?? `<index ${wIdx}>`;
    warnings.push(
      `webhook '${webhookName}': not portable to v3 (whole-domain preserve/reset only — never reconstructed from portable content)`,
    );
  }

  // ----- 10. Emit the v3 manifest -----
  const domains: ManifestDomains = {};
  if (habitatSettings) {
    domains.habitatSettings = { disposition: "replace", data: habitatSettings };
  }
  if (columns.length > 0) {
    domains.columns = { disposition: "replace", data: columns };
  }
  if (missionsPortable.length > 0) {
    domains.missions = { disposition: "replace", data: missionsPortable };
  }
  if (tasksPortable.length > 0) {
    domains.tasks = { disposition: "replace", data: tasksPortable };
  }
  if (commentsPortable.length > 0) {
    domains.comments = { disposition: "replace", data: commentsPortable };
  }
  if (templatesPortable.length > 0) {
    domains.templates = { disposition: "replace", data: templatesPortable };
  }

  const manifestId =
    options?.manifestId ??
    `legacy-adapted:${readField(rootRecord, "version") ?? "unknown"}:${exportedAt}`;
  const mode = options?.mode ?? "new";

  const manifest: HabitatImportManifest = {
    version: 3,
    manifestId,
    generatedAt: exportedAt,
    mode,
    identityPolicy: "remap", // ALWAYS remap for legacy (B3)
    lineage: {
      sourceHabitatId: null, // legacy has no lineage
      sourceExportedAt: exportedAt,
      sourceManifestId: null,
    },
    domains,
  };

  return { manifest, warnings };
}

// ===========================================================================
// Per-entity adapters
// ===========================================================================

interface MissionEntry {
  sourceId: string;
  mission: Record<string, unknown>;
  tasks: TaskEntry[];
  isSynthetic: boolean;
}

interface TaskEntry {
  sourceId: string;
  task: Record<string, unknown>;
}

/**
 * Adapts the habitat-level settings (name + description). v2 has no
 * planning-config JSON, so `settings` is the empty object (forward-compat
 * placeholder for v3 native exports that DO carry settings).
 */
function adaptHabitatSettings(
  habitat: Record<string, unknown>,
  warnings: string[],
): HabitatSettingsPortable | undefined {
  const name = asString(habitat.name);
  if (name === undefined) {
    warnings.push("habitat: missing 'name' — habitatSettings domain omitted from manifest");
    return undefined;
  }
  const sourceId = synthesizeStructuralSourceId(["habitat", 0]);
  return {
    sourceId,
    name,
    description: asString(habitat.description) ?? "",
    settings: {},
  };
}

/**
 * Adapts the v2 columns array to v3 {@link ColumnPortable} shape. v2 column
 * policy fields (`autoAdvance`, `requiresClaim`) have no slot in v3
 * ColumnPortable — dropped with a per-column warning (explicit over silent).
 */
function adaptColumns(columnsRaw: unknown, warnings: string[]): ColumnPortable[] {
  const arr = asArray(columnsRaw);
  if (!arr) return [];
  const out: ColumnPortable[] = [];
  for (let i = 0; i < arr.length; i++) {
    const col = asRecord(arr[i]);
    if (!col) {
      warnings.push(`column[${i}]: not an object — skipped`);
      continue;
    }
    const name = asString(col.name);
    if (name === undefined) {
      warnings.push(`column[${i}]: missing 'name' — skipped`);
      continue;
    }
    const sourceId = synthesizeStructuralSourceId(["column", i]);
    const order = asNumber(col.order) ?? i;
    const wipLimit = asNullableNumber(col.wipLimit) ?? null;
    const nextColumnName = asNullableString(col.nextColumnName) ?? null;
    const isTerminal = asBoolean(col.isTerminal) ?? false;

    // C4 absorption: column policy fields not portable to v3 ColumnPortable.
    const autoAdvance = asBoolean(col.autoAdvance);
    const requiresClaim = asBoolean(col.requiresClaim);
    const droppedPolicyFields: string[] = [];
    if (autoAdvance === true) droppedPolicyFields.push("autoAdvance=true");
    if (requiresClaim === true) droppedPolicyFields.push("requiresClaim=true");
    if (droppedPolicyFields.length > 0) {
      warnings.push(
        `column '${name}': policy fields (${droppedPolicyFields.join(", ")}) not portable to v3 ColumnPortable — dropped`,
      );
    }

    out.push({
      sourceId,
      name,
      order,
      color: null, // v2 has no color; default null
      wipLimit,
      nextColumnName,
      isTerminal,
    });
  }
  return out;
}

/**
 * Adapts a v2 mission to v3 {@link MissionPortable}. The mission's
 * `dependsOn`/`blocks` title-keyed arrays are re-keyed through structural
 * source IDs (the B3 correction). Unknown title refs are dropped with a
 * warning (explicit over silent).
 *
 * Per the C4 absorption table, mission `status` is NOT portable
 * (MissionPortable has no slot) — dropped with a per-mission warning.
 */
function adaptMission(
  mission: Record<string, unknown>,
  sourceId: string,
  missionTitleToSourceId: Map<string, string>,
  warnings: string[],
): MissionPortable {
  const title = asString(mission.title) ?? "";

  // C4 absorption: mission execution state.
  const status = asString(mission.status);
  if (status !== undefined && status !== "not_started") {
    warnings.push(
      `mission '${title}': execution state (status='${status}') not portable — reset to not_started`,
    );
  }

  // B3 re-keying: title-keyed dependsOn/blocks → structural source IDs.
  const dependsOnTitles = stringArrayField(mission.dependsOn);
  const blocksTitles = stringArrayField(mission.blocks);
  const dependsOnSourceIds = resolveTitleRefs(
    dependsOnTitles,
    missionTitleToSourceId,
    "mission",
    title,
    "dependsOn",
    warnings,
  );
  const blocksSourceIds = resolveTitleRefs(
    blocksTitles,
    missionTitleToSourceId,
    "mission",
    title,
    "blocks",
    warnings,
  );

  return {
    sourceId,
    title,
    description: asString(mission.description) ?? "",
    acceptanceCriteria: asString(mission.acceptanceCriteria) ?? "",
    priority: asPriority(mission.priority, "medium", warnings, `mission '${title}'`),
    labels: stringArrayField(mission.labels),
    columnName: asString(mission.columnName) ?? "",
    dependsOnSourceIds,
    blocksSourceIds,
    dueAt: asNullableString(mission.dueAt) ?? null,
  };
}

/**
 * Adapts a v2 task to v3 {@link TaskPortable}. Per the C4 absorption table,
 * task execution state (`status`/`result`/`artifacts`/`assignedAgentId`/
 * `rejectedCount`/`rejectionReason`/retry fields) is NOT portable — dropped
 * with a per-task warning enumerating every field that was present + non-
 * default. This is the explicit-over-silent directive (gap-audit R3).
 */
function adaptTask(
  task: Record<string, unknown>,
  sourceId: string,
  missionSourceId: string,
  warnings: string[],
): TaskPortable {
  const title = asString(task.title) ?? "";

  // C4 absorption: collect every execution-state field that was present + non-
  // default. Emit ONE aggregate warning per task (enumerating the dropped
  // fields) so the audit trail is concise but complete.
  const droppedExecFields: string[] = [];
  const status = asString(task.status);
  if (status !== undefined && status !== "pending") {
    droppedExecFields.push(`status='${status}'`);
  }
  if (task.result !== undefined && task.result !== null) {
    droppedExecFields.push("result");
  }
  if (taskHasNonEmptyArtifacts(task.artifacts)) {
    droppedExecFields.push("artifacts");
  }
  if (task.assignedAgentId !== undefined && task.assignedAgentId !== null) {
    droppedExecFields.push("assignedAgentId");
  }
  if (task.rejectedCount !== undefined && task.rejectedCount !== 0) {
    droppedExecFields.push(`rejectedCount=${JSON.stringify(task.rejectedCount)}`);
  }
  if (task.rejectionReason !== undefined && task.rejectionReason !== null) {
    droppedExecFields.push("rejectionReason");
  }
  if (task.retryCount !== undefined && task.retryCount !== 0) {
    droppedExecFields.push(`retryCount=${JSON.stringify(task.retryCount)}`);
  }
  if (droppedExecFields.length > 0) {
    warnings.push(
      `task '${title}': execution state (${droppedExecFields.join(", ")}) not portable — reset to default (pending / empty)`,
    );
  }

  // `createdBy` is execution-ish attribution state — TaskPortable has no slot.
  // Silently dropped (the publication kernel assigns `createdBy` at apply time
  // from the audit context). Not warned: not in the C4 table's per-row rules.
  // Documented here to prevent "why is this dropped?" confusion.

  return {
    sourceId,
    missionSourceId,
    title,
    description: asString(task.description) ?? "",
    priority: asPriority(task.priority, "medium", warnings, `task '${title}'`),
    requiredDomain: asNullableString(task.requiredDomain) ?? null,
    requiredCapabilities: stringArrayField(task.requiredCapabilities),
  };
}

/**
 * Adapts a v2 comment to v3 {@link CommentPortable}. Per the C4 absorption
 * table, `authorId` is carried through as `author.importedAttribution` with
 * `resolvedActorId: null` (T10B resolves at apply time against the local
 * actor table; unresolved → defaults to a documented imported-attribution
 * identity).
 *
 * `parentTaskTitle` (v2) is faithfully dropped: the v0.31 importer ignored it
 * (always set `parentId: null` at `habitatService.ts:640`), so the adapter
 * emits `parentCommentSourceId: null` — byte-faithful v0.31 behavior.
 *
 * `authoredAt` (required by v3) has no v2 source; defaults to the manifest's
 * `exportedAt` (the source-level timestamp).
 */
function adaptComment(
  comment: Record<string, unknown>,
  sourceId: string,
  taskSourceId: string,
  exportedAt: string,
  warnings: string[],
  commentIndex: number,
): CommentPortable {
  const content = asString(comment.content) ?? "";
  const authorId = asString(comment.authorId) ?? "";

  // C4 absorption: authorId → importedAttribution (resolvedActorId: null).
  // No warning — this is the documented resolution (every comment carries
  // both fields; T10B resolves at apply time).

  // authorType: v3 widens the union to include `remote_human` / `remote_orcy`
  // for legacy v2 attribution that pre-dated the canonical actor taxonomy.
  const rawAuthorType = asString(comment.authorType);
  let authorType: CommentPortable["authorType"];
  if (
    rawAuthorType === "human" ||
    rawAuthorType === "agent" ||
    rawAuthorType === "remote_human" ||
    rawAuthorType === "remote_orcy"
  ) {
    authorType = rawAuthorType;
  } else {
    warnings.push(
      `comment[${commentIndex}]: authorType '${String(rawAuthorType)}' not in {human, agent, remote_human, remote_orcy} — defaulted to 'human'`,
    );
    authorType = "human";
  }

  // authoredAt: v2 has no per-comment timestamp; use the manifest exportedAt.
  const authoredAt = asString(comment.authoredAt) ?? exportedAt;

  return {
    sourceId,
    taskSourceId,
    parentCommentSourceId: null, // v0.31 ignores parentTaskTitle — faithful
    content,
    author: {
      resolvedActorId: null,
      importedAttribution: authorId,
    },
    authorType,
    authoredAt,
  };
}

/**
 * Adapts a v2 template to v3 {@link TemplatePortable}. v2 templates carry
 * task-generation patterns (`titlePattern`, `descriptionPattern`) +
 * task-level fields (`requiredDomain`, `requiredCapabilities`). The v3
 * {@link TemplateContentPortable} is mission-shaped — task-level fields
 * don't fit. The adapter synthesizes a single mission in `content.missions`
 * (preserving `priority` + `labels`) + warns per template about the dropped
 * task-level fields (explicit over silent).
 */
function adaptTemplate(
  template: Record<string, unknown>,
  sourceId: string,
  warnings: string[],
  templateIndex: number,
): TemplatePortable {
  const name = asString(template.name) ?? `template-${templateIndex}`;
  const descriptionPattern = asString(template.descriptionPattern) ?? "";
  const titlePattern = asString(template.titlePattern) ?? name;

  // C4 absorption: task-level fields not portable to v3 TemplateContent.missions.
  const droppedTaskFields: string[] = [];
  const requiredDomain = asNullableString(template.requiredDomain);
  if (requiredDomain !== undefined && requiredDomain !== null) {
    droppedTaskFields.push(`requiredDomain='${requiredDomain}'`);
  }
  const requiredCapabilitiesArr = asArray(template.requiredCapabilities);
  if (requiredCapabilitiesArr && requiredCapabilitiesArr.length > 0) {
    droppedTaskFields.push(`requiredCapabilities (count=${requiredCapabilitiesArr.length})`);
  }
  if (droppedTaskFields.length > 0) {
    warnings.push(
      `template '${name}': task-level fields (${droppedTaskFields.join(", ")}) not portable to v3 TemplateContent.missions (mission-shaped) — dropped`,
    );
  }

  const priority = asPriority(template.priority, "medium", warnings, `template '${name}'`);
  const labels = stringArrayField(template.labels);
  const isDefault = asBoolean(template.isDefault) ?? false;

  const content: TemplateContentPortable = {
    columns: [], // v2 templates don't carry column layouts
    labels,
    missions: [
      {
        title: titlePattern,
        description: descriptionPattern,
        acceptanceCriteria: "",
        priority,
        labels,
        dependsOnSourceIds: [],
        blocksSourceIds: [],
        dueAt: null,
      },
    ],
  };

  return {
    sourceId,
    name,
    description: descriptionPattern,
    content,
    isDefault,
  };
}

// ===========================================================================
// Title-ref re-keying (B3 — title-keyed → structural source IDs)
// ===========================================================================

/**
 * Resolves a list of title refs against the title→sourceId map. Unknown
 * titles are dropped with a warning (explicit over silent). Returns the
 * resolved source IDs in input order.
 */
function resolveTitleRefs(
  titles: readonly string[],
  titleToSourceId: Map<string, string>,
  entityKind: "mission",
  fromTitle: string,
  field: "dependsOn" | "blocks",
  warnings: string[],
): string[] {
  const out: string[] = [];
  for (const title of titles) {
    const sourceId = titleToSourceId.get(title);
    if (sourceId === undefined) {
      warnings.push(
        `${entityKind} '${fromTitle}': ${field} references unknown title '${title}' — dropped`,
      );
      continue;
    }
    out.push(sourceId);
  }
  return out;
}

// ===========================================================================
// Field extractors — PURE, total (never throw on bad shape)
// ===========================================================================

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

function asArray(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asNullableNumber(v: unknown): number | null | undefined {
  if (v === null) return null;
  return asNumber(v);
}

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function asNullableString(v: unknown): string | null | undefined {
  if (v === null) return null;
  return asString(v);
}

function asStringArray(v: unknown): string[] {
  const arr = asArray(v);
  if (!arr) return [];
  return arr.filter((s): s is string => typeof s === "string");
}

function stringArrayField(v: unknown): string[] {
  return asStringArray(asArray(v));
}

function asPriority(
  v: unknown,
  def: TaskPriority,
  warnings: string[],
  context: string,
): TaskPriority {
  if (v === "low" || v === "medium" || v === "high" || v === "critical") {
    return v;
  }
  if (v !== undefined) {
    warnings.push(
      `${context}: priority '${String(v)}' not in {low, medium, high, critical} — defaulted to '${def}'`,
    );
  }
  return def;
}

function taskHasNonEmptyArtifacts(v: unknown): boolean {
  const arr = asArray(v);
  return !!arr && arr.length > 0;
}

function readField(input: unknown, field: string): unknown {
  const rec = asRecord(input);
  return rec?.[field];
}

function firstColumnName(columns: readonly ColumnPortable[]): string {
  // Sort by order, take the first; fallback to empty string.
  const sorted = [...columns].sort((a, b) => a.order - b.order);
  return sorted[0]?.name ?? "";
}
