/**
 * T10A Milestone 1 — Manifest v3 types + structural-source-ID helpers.
 *
 * Tests the TYPE-NARROWING assertions for the manifest v3 contract + the
 * B3 helpers (`synthesizeStructuralSourceId`, `detectAmbiguousTitleRefs`,
 * `isNativeSourceId`). These helpers are the import-side foundation M2 / M3
 * compose against — bugs here cascade into the legacy adapter and the
 * preflight pipeline.
 *
 * Out of scope: the zod strict schema (M4), the legacy adapter (M2), the
 * domain handlers (M3). These are the pure type + helper tests.
 */
import { describe, it, expect } from "vitest";
import {
  synthesizeStructuralSourceId,
  detectAmbiguousTitleRefs,
  isNativeSourceId,
  LEGACY_SOURCE_ID_PREFIX,
  type TitleKeyedRefs,
  type AmbiguityError,
} from "../services/importManifest/sourceIdentity.js";
import {
  MANIFEST_DOMAIN_NAMES,
  type HabitatImportManifest,
  type DomainEnvelope,
  type DomainDisposition,
  type ManifestDomainName,
  type HabitatSettingsPortable,
  type ColumnPortable,
  type MissionPortable,
  type TaskPortable,
  type SubtaskPortable,
  type DependencyPortable,
  type CommentPortable,
  type TemplatePortable,
  type ManifestDomains,
} from "../services/importManifest/types.js";

// ---------------------------------------------------------------------------
// 1. synthesizeStructuralSourceId — the structural-ID renderer.
// ---------------------------------------------------------------------------

describe("synthesizeStructuralSourceId — structural source ID synthesis", () => {
  it("empty path → 'legacy:' (the root of the synthetic ID space)", () => {
    expect(synthesizeStructuralSourceId([])).toBe("legacy:");
  });

  it("single (kind, index) pair → 'legacy:<kind>[<index>]'", () => {
    expect(synthesizeStructuralSourceId(["mission", 0])).toBe("legacy:mission[0]");
    expect(synthesizeStructuralSourceId(["column", 2])).toBe("legacy:column[2]");
    expect(synthesizeStructuralSourceId(["template", 0])).toBe("legacy:template[0]");
  });

  it("nested (kind, index) pairs joined by '.'", () => {
    expect(synthesizeStructuralSourceId(["mission", 0, "task", 2])).toBe(
      "legacy:mission[0].task[2]",
    );
    expect(synthesizeStructuralSourceId(["mission", 1, "subtask", 0])).toBe(
      "legacy:mission[1].subtask[0]",
    );
    expect(synthesizeStructuralSourceId(["mission", 0, "task", 2, "subtask", 1])).toBe(
      "legacy:mission[0].task[2].subtask[1]",
    );
    expect(synthesizeStructuralSourceId(["mission", 0, "task", 2, "comment", 0])).toBe(
      "legacy:mission[0].task[2].comment[0]",
    );
  });

  it("determinism: same path → same ID across re-runs (re-imports)", () => {
    const path: readonly (number | string)[] = ["mission", 0, "task", 2];
    const a = synthesizeStructuralSourceId(path);
    const b = synthesizeStructuralSourceId(path);
    const c = synthesizeStructuralSourceId(["mission", 0, "task", 2]);
    expect(a).toBe(b);
    expect(b).toBe(c);

    // **Failure mode**: if the renderer used random / timestamp suffixes,
    // re-imports of the same legacy payload would emit DIFFERENT sourceIds
    // → cross-domain reference resolution (a Task's `missionSourceId`
    // resolving against the missions domain) would silently fail.
  });

  it("index 0 and large indices are valid (only non-negative integers accepted)", () => {
    expect(synthesizeStructuralSourceId(["mission", 0])).toBe("legacy:mission[0]");
    expect(synthesizeStructuralSourceId(["mission", 99])).toBe("legacy:mission[99]");
    expect(synthesizeStructuralSourceId(["mission", 1000])).toBe("legacy:mission[1000]");
  });

  it("validation: odd-length path throws (the last element is a kind with no index)", () => {
    expect(() => synthesizeStructuralSourceId(["mission"])).toThrow(/even/);
    expect(() => synthesizeStructuralSourceId(["mission", 0, "task"])).toThrow(/even/);

    // **Failure mode**: an odd-length path is a caller bug — the renderer
    // throws so the call site is diagnosable (vs. silently emitting a
    // malformed sourceId like `legacy:mission[0].task`).
  });

  it("validation: non-string kind throws", () => {
    expect(() => synthesizeStructuralSourceId([123, 0])).toThrow(/entity-kind string/);
    expect(() => synthesizeStructuralSourceId(["mission", 0, "", 1])).toThrow(
      /non-empty entity-kind string/,
    );
  });

  it("validation: non-integer / negative index throws", () => {
    expect(() => synthesizeStructuralSourceId(["mission", -1])).toThrow(/non-negative integer/);
    expect(() => synthesizeStructuralSourceId(["mission", 1.5])).toThrow(/non-negative integer/);
    expect(() => synthesizeStructuralSourceId(["mission", "0"])).toThrow(/non-negative integer/);
  });

  it("the rendered ID always starts with LEGACY_SOURCE_ID_PREFIX", () => {
    expect(synthesizeStructuralSourceId([]).startsWith(LEGACY_SOURCE_ID_PREFIX)).toBe(true);
    expect(synthesizeStructuralSourceId(["mission", 0]).startsWith(LEGACY_SOURCE_ID_PREFIX)).toBe(
      true,
    );
    expect(
      synthesizeStructuralSourceId(["mission", 0, "task", 2]).startsWith(LEGACY_SOURCE_ID_PREFIX),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. isNativeSourceId — the native-vs-legacy classifier.
// ---------------------------------------------------------------------------

describe("isNativeSourceId — native vs. legacy classifier", () => {
  it("legacy: prefixed IDs are NOT native (return false)", () => {
    expect(isNativeSourceId("legacy:")).toBe(false);
    expect(isNativeSourceId("legacy:mission[0]")).toBe(false);
    expect(isNativeSourceId("legacy:mission[0].task[2]")).toBe(false);
  });

  it("UUID-format IDs are native (return true)", () => {
    expect(isNativeSourceId("01926f5e-1234-7abc-9def-0123456789ab")).toBe(true);
    expect(isNativeSourceId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    // UPPERCASE variant — UUIDs are case-insensitive.
    expect(isNativeSourceId("01926F5E-1234-7ABC-9DEF-0123456789AB")).toBe(true);
  });

  it("opaque / custom IDs (not starting with 'legacy:') are native", () => {
    // The classifier is prefix-based, NOT UUID-regex — opaque tokens,
    // namespaced IDs, etc. all count as native. The preflight's downstream
    // logic only cares about the distinction.
    expect(isNativeSourceId("v3:abc:123")).toBe(true);
    expect(isNativeSourceId("not-legacy-some-token")).toBe(true);
    expect(isNativeSourceId("")).toBe(true); // empty string → not "legacy:" prefix
  });

  it("the inverse property: every legacy ID is NOT native, every non-legacy string IS native", () => {
    const samples = ["legacy:", "legacy:x", "abc", "01926f5e-1234-7abc-9def-0123456789ab"];
    for (const s of samples) {
      const isLegacy = s.startsWith(LEGACY_SOURCE_ID_PREFIX);
      expect(isNativeSourceId(s)).toBe(!isLegacy);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. detectAmbiguousTitleRefs — the B3 ambiguity detector.
// ---------------------------------------------------------------------------

describe("detectAmbiguousTitleRefs — B3 ambiguity detector", () => {
  it("empty input → no errors", () => {
    const refs: TitleKeyedRefs = {
      missionTitles: [],
      missionDependsOn: [],
      missionBlocks: [],
      taskTitles: [],
      taskCommentReferences: [],
    };
    expect(detectAmbiguousTitleRefs(refs)).toEqual([]);
  });

  it("unique mission titles + no refs → no errors", () => {
    const refs: TitleKeyedRefs = {
      missionTitles: ["M1", "M2", "M3"],
      missionDependsOn: [{ fromTitle: "M1", referencedTitle: "M2" }],
      missionBlocks: [],
      taskTitles: [],
      taskCommentReferences: [],
    };
    expect(detectAmbiguousTitleRefs(refs)).toEqual([]);
  });

  it("duplicate mission titles BUT no refs to the duplicate → no errors", () => {
    const refs: TitleKeyedRefs = {
      missionTitles: ["Dup", "Dup", "Other"],
      missionDependsOn: [{ fromTitle: "Other", referencedTitle: "M2" }],
      missionBlocks: [],
      taskTitles: [],
      taskCommentReferences: [],
    };
    expect(detectAmbiguousTitleRefs(refs)).toEqual([]);

    // **Failure mode**: a naive detector would flag ANY duplicate mission
    // title as ambiguous — the contract is "duplicate + referenced" (the
    // duplicate is only ambiguous if SOMEONE tries to reference it via a
    // title-keyed ref).
  });

  it("duplicate mission title referenced via dependsOn → ambiguity error", () => {
    const refs: TitleKeyedRefs = {
      missionTitles: ["Dup", "Dup", "Ref"],
      missionDependsOn: [{ fromTitle: "Ref", referencedTitle: "Dup" }],
      missionBlocks: [],
      taskTitles: [],
      taskCommentReferences: [],
    };
    const errors = detectAmbiguousTitleRefs(refs);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      kind: "duplicate_mission_title_in_dependsOn",
      missionTitle: "Dup",
      fromMissionTitles: ["Ref"],
    });
  });

  it("duplicate mission title referenced via blocks → ambiguity error", () => {
    const refs: TitleKeyedRefs = {
      missionTitles: ["Dup", "Dup", "Blocker"],
      missionDependsOn: [],
      missionBlocks: [{ fromTitle: "Blocker", referencedTitle: "Dup" }],
      taskTitles: [],
      taskCommentReferences: [],
    };
    const errors = detectAmbiguousTitleRefs(refs);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      kind: "duplicate_mission_title_in_blocks",
      missionTitle: "Dup",
      fromMissionTitles: ["Blocker"],
    });
  });

  it("duplicate task title referenced via comment → ambiguity error", () => {
    const refs: TitleKeyedRefs = {
      missionTitles: [],
      missionDependsOn: [],
      missionBlocks: [],
      taskTitles: ["T-Dup", "T-Dup", "Other"],
      taskCommentReferences: [
        { referencedTaskTitle: "T-Dup" },
        { referencedTaskTitle: "T-Dup" },
      ],
    };
    const errors = detectAmbiguousTitleRefs(refs);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      kind: "duplicate_task_title_in_comment",
      taskTitle: "T-Dup",
      commentRefCount: 2,
    });
  });

  it("multiple from-mission titles accumulate in the fromMissionTitles array (source order)", () => {
    const refs: TitleKeyedRefs = {
      missionTitles: ["Dup", "Dup", "Ref1", "Ref2", "Ref3"],
      missionDependsOn: [
        { fromTitle: "Ref2", referencedTitle: "Dup" },
        { fromTitle: "Ref1", referencedTitle: "Dup" },
        { fromTitle: "Ref3", referencedTitle: "Dup" },
      ],
      missionBlocks: [],
      taskTitles: [],
      taskCommentReferences: [],
    };
    const errors = detectAmbiguousTitleRefs(refs);
    expect(errors).toHaveLength(1);
    // Source-order: Ref2, Ref1, Ref3 (the order they appear in the
    // missionDependsOn array).
    expect(errors[0]).toMatchObject({
      kind: "duplicate_mission_title_in_dependsOn",
      missionTitle: "Dup",
      fromMissionTitles: ["Ref2", "Ref1", "Ref3"],
    });
  });

  it("ALL three ambiguity kinds accumulate when the input triggers them all", () => {
    const refs: TitleKeyedRefs = {
      missionTitles: ["M-Dup", "M-Dup", "M-Ref"],
      missionDependsOn: [{ fromTitle: "M-Ref", referencedTitle: "M-Dup" }],
      missionBlocks: [{ fromTitle: "M-Ref", referencedTitle: "M-Dup" }],
      taskTitles: ["T-Dup", "T-Dup"],
      taskCommentReferences: [{ referencedTaskTitle: "T-Dup" }],
    };
    const errors = detectAmbiguousTitleRefs(refs);
    expect(errors).toHaveLength(3);
    // Verify each kind is present.
    const kinds = errors.map((e) => e.kind);
    expect(kinds).toContain("duplicate_mission_title_in_dependsOn");
    expect(kinds).toContain("duplicate_mission_title_in_blocks");
    expect(kinds).toContain("duplicate_task_title_in_comment");

    // **Failure mode**: a first-error detector would return ONE error and
    // short-circuit. The preflight's "ACCUMULATE ALL errors" directive
    // (per the plan) requires all three to surface so the caller fixes
    // everything in one preflight pass.
  });

  it("determinism: same input → same error array (in stable order)", () => {
    const refs: TitleKeyedRefs = {
      missionTitles: ["Dup1", "Dup2", "Dup1", "Dup2"],
      missionDependsOn: [
        { fromTitle: "Dup1", referencedTitle: "Dup2" },
        { fromTitle: "Dup2", referencedTitle: "Dup1" },
      ],
      missionBlocks: [],
      taskTitles: [],
      taskCommentReferences: [],
    };
    const a = detectAmbiguousTitleRefs(refs);
    const b = detectAmbiguousTitleRefs(refs);
    expect(a).toEqual(b);

    // **Failure mode**: if the detector used Set / Map iteration order
    // (which varies across runs), the preflight's retry-after-fix would
    // produce a different error set — the caller can't reliably track
    // progress.
  });

  it("commentRefCount counts every comment ref to the duplicate task title", () => {
    const refs: TitleKeyedRefs = {
      missionTitles: [],
      missionDependsOn: [],
      missionBlocks: [],
      taskTitles: ["T-Dup", "T-Dup"],
      taskCommentReferences: [
        { referencedTaskTitle: "T-Dup" },
        { referencedTaskTitle: "T-Dup" },
        { referencedTaskTitle: "T-Dup" },
        { referencedTaskTitle: "Other" }, // not a duplicate → ignored
      ],
    };
    const errors = detectAmbiguousTitleRefs(refs);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      kind: "duplicate_task_title_in_comment",
      taskTitle: "T-Dup",
      commentRefCount: 3,
    });
  });

  it("the discriminated union is type-narrowable (the AmbiguityError kind field)", () => {
    const refs: TitleKeyedRefs = {
      missionTitles: ["Dup", "Dup"],
      missionDependsOn: [{ fromTitle: "Dup", referencedTitle: "Dup" }],
      missionBlocks: [],
      taskTitles: [],
      taskCommentReferences: [],
    };
    const errors: AmbiguityError[] = detectAmbiguousTitleRefs(refs);
    expect(errors).toHaveLength(1);
    const err = errors[0];
    // Type narrowing via the `kind` discriminator — the type system enforces
    // exhaustive handling.
    switch (err.kind) {
      case "duplicate_mission_title_in_dependsOn":
        expect(err.missionTitle).toBe("Dup");
        expect(err.fromMissionTitles).toEqual(["Dup"]);
        break;
      case "duplicate_mission_title_in_blocks":
        throw new Error("unexpected branch");
      case "duplicate_task_title_in_comment":
        throw new Error("unexpected branch");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Manifest v3 types — type-narrowing assertions (compile-time +
//    runtime shape spot-checks).
// ---------------------------------------------------------------------------

describe("HabitatImportManifest — type-narrowing assertions", () => {
  it("DomainDisposition is the closed 3-value union", () => {
    // Compile-time: this is just a value-space test — assignability of the
    // 3 values confirms the union shape.
    const replace: DomainDisposition = "replace";
    const preserve: DomainDisposition = "preserve";
    const reset: DomainDisposition = "reset";
    expect([replace, preserve, reset]).toEqual(["replace", "preserve", "reset"]);
  });

  it("DomainEnvelope<T> wraps per-domain data with its disposition", () => {
    // The envelope is generic — the per-domain portable data is its `data`
    // field. The disposition is the destructive-intent signal.
    const envelope: DomainEnvelope<HabitatSettingsPortable> = {
      disposition: "replace",
      data: {
        sourceId: "legacy:habitat[0]",
        name: "Imported Habitat",
        description: "A habitat",
        settings: { planningMode: "kanban" },
      },
    };
    expect(envelope.disposition).toBe("replace");
    expect(envelope.data.sourceId).toBe("legacy:habitat[0]");

    // **Failure mode**: a shape WITHOUT the disposition field would let
    // destructive intent slip through silently — the v0.31 patch the C4
    // correction retires.
  });

  it("ManifestDomainName covers exactly the 8 portable domains", () => {
    const names: readonly ManifestDomainName[] = MANIFEST_DOMAIN_NAMES;
    expect(names).toHaveLength(8);
    expect(new Set(names).size).toBe(8); // no duplicates
    expect([...names].sort()).toEqual([
      "columns",
      "comments",
      "dependencies",
      "habitatSettings",
      "missions",
      "subtasks",
      "tasks",
      "templates",
    ]);

    // **Failure mode**: if a 9th domain were silently added, the preflight
    // iteration would skip it. The closed union forces a deliberate
    // declaration + iteration registration.
  });

  it("HabitatImportManifest requires version: 3 literal (dispatch discriminator)", () => {
    // The literal `version: 3` is the discriminator — the legacy adapter
    // dispatches on it. A manifest with `version: 1` or `version: 2` would
    // not satisfy this type.
    const manifest: HabitatImportManifest = {
      version: 3,
      manifestId: "01926f5e-1234-7abc-9def-0123456789ab",
      generatedAt: "2026-07-19T12:00:00.000Z",
      mode: "new",
      identityPolicy: "remap",
      lineage: {
        sourceHabitatId: null,
        sourceExportedAt: null,
        sourceManifestId: null,
      },
      domains: {},
    };
    expect(manifest.version).toBe(3);
    expect(manifest.mode).toBe("new");
    expect(manifest.identityPolicy).toBe("remap");
  });

  it("ManifestDomains: every declared domain is OPTIONAL (omitted = preserve-by-default)", () => {
    // An empty `domains: {}` is valid — every domain is preserve-by-default.
    const domains: ManifestDomains = {};
    expect(domains.habitatSettings).toBeUndefined();
    expect(domains.columns).toBeUndefined();
    expect(domains.missions).toBeUndefined();
    expect(domains.tasks).toBeUndefined();
    expect(domains.subtasks).toBeUndefined();
    expect(domains.dependencies).toBeUndefined();
    expect(domains.comments).toBeUndefined();
    expect(domains.templates).toBeUndefined();
  });

  it("MissionPortable: structural source IDs (NOT title-keyed) for dependsOn / blocks", () => {
    // The B3 correction: dependsOn / blocks carry structural source IDs
    // (synthesized for legacy v1/v2), not titles. The preflight resolves
    // these against the missions domain.
    const mission: MissionPortable = {
      sourceId: "legacy:mission[0]",
      title: "Refactor the import pipeline",
      description: "Replace the silent title-keyed ref logic with structural IDs",
      acceptanceCriteria: "All legacy v2 imports round-trip through the new adapter",
      priority: "high",
      labels: ["refactor", "import"],
      columnName: "In Progress",
      dependsOnSourceIds: ["legacy:mission[1]"],
      blocksSourceIds: ["legacy:mission[2]", "legacy:mission[3]"],
      dueAt: "2026-08-01T00:00:00.000Z",
    };
    expect(mission.dependsOnSourceIds).toEqual(["legacy:mission[1]"]);
    expect(mission.blocksSourceIds).toEqual(["legacy:mission[2]", "legacy:mission[3]"]);
  });

  it("TaskPortable: NO execution-state slots (the C4 absorption rule)", () => {
    // TaskPortable has NO `status` / `result` / `artifacts` / `assignedAgentId`
    // / retry fields. The C4 absorption table resets execution state — a
    // TaskPortable with execution state would be a type-space violation.
    const task: TaskPortable = {
      sourceId: "legacy:mission[0].task[2]",
      missionSourceId: "legacy:mission[0]",
      title: "Implement the structural ID synthesis",
      description: "Walk the v2 input arrays, emit legacy:* IDs",
      priority: "medium",
      requiredDomain: null,
      requiredCapabilities: [],
    };
    // The shape is frozen at compile time — TypeScript would refuse to add
    // an execution-state field. This assertion documents the contract.
    expect(task.priority).toBe("medium");
  });

  it("CommentPortable: author carries resolvedActorId + importedAttribution (C4 absorption)", () => {
    // The C4 absorption: v2 `authorId` is RESOLVED at apply time — the
    // manifest carries BOTH the resolved (when known) AND the imported
    // attribution (the original). Unresolved → resolvedActorId: null +
    // importedAttribution: <v2-authorId>.
    const comment: CommentPortable = {
      sourceId: "legacy:mission[0].task[2].comment[0]",
      taskSourceId: "legacy:mission[0].task[2]",
      parentCommentSourceId: null,
      content: "Looks good — proceed with the structural-ID synthesis",
      author: {
        resolvedActorId: null, // legacy v2 id doesn't match a local actor
        importedAttribution: "agent-007", // the v2 authorId, preserved verbatim
      },
      authorType: "agent",
      authoredAt: "2026-07-19T12:00:00.000Z",
    };
    expect(comment.author.resolvedActorId).toBeNull();
    expect(comment.author.importedAttribution).toBe("agent-007");
  });

  it("DependencyPortable: structural source IDs (B3) — task dependsOn task by sourceId", () => {
    const dep: DependencyPortable = {
      sourceId: "legacy:mission[0].task[2].dep[0]",
      taskSourceId: "legacy:mission[0].task[2]",
      dependsOnTaskSourceId: "legacy:mission[0].task[0]",
      kind: "blocks",
    };
    expect(dep.kind).toBe("blocks");
    expect(dep.taskSourceId).toBe("legacy:mission[0].task[2]");
    expect(dep.dependsOnTaskSourceId).toBe("legacy:mission[0].task[0]");
  });

  it("TemplatePortable: content lifts the Mission-shaped layout (no dynamic state)", () => {
    const template: TemplatePortable = {
      sourceId: "legacy:template[0]",
      name: "Standard Mission Template",
      description: "Default template used by `missionTemplates`",
      content: {
        columns: [
          {
            sourceId: "legacy:template[0].column[0]",
            name: "Backlog",
            order: 0,
            color: null,
            wipLimit: null,
            nextColumnName: "In Progress",
            isTerminal: false,
          },
        ],
        labels: ["imported"],
        missions: [
          {
            title: "New Mission",
            description: "",
            acceptanceCriteria: "",
            priority: "medium",
            labels: [],
            dependsOnSourceIds: [],
            blocksSourceIds: [],
            dueAt: null,
          },
        ],
      },
      isDefault: true,
    };
    expect(template.isDefault).toBe(true);
    expect(template.content.columns).toHaveLength(1);
  });

  it("ColumnPortable / SubtaskPortable carry sourceIds", () => {
    const column: ColumnPortable = {
      sourceId: "legacy:column[0]",
      name: "Backlog",
      order: 0,
      color: "#cccccc",
      wipLimit: null,
      nextColumnName: "In Progress",
      isTerminal: false,
    };
    const subtask: SubtaskPortable = {
      sourceId: "legacy:mission[0].task[0].subtask[0]",
      taskSourceId: "legacy:mission[0].task[0]",
      title: "Define the strict zod schema",
      order: 0,
      completed: false,
      assigneeId: null,
    };
    expect(column.sourceId).toBe("legacy:column[0]");
    expect(subtask.sourceId).toBe("legacy:mission[0].task[0].subtask[0]");

    // **Failure mode**: a column / subtask WITHOUT a sourceId would be
    // impossible to reference from cross-domain portable content — the
    // contract enforces the structural-ID presence.
  });
});
