/**
 * T10A Milestone 2 — Declared Legacy Import Adapter (v1/v2 → v3).
 *
 * Tests the PURE transformation from legacy v1 (`board`/`features`) and v2
 * (`habitat.missions`) inputs into manifest v3 shape. Covers:
 *
 *   - v1 → v3 happy path (with `board`→`habitat`, `features`→`missions`)
 *   - v2 → v3 happy path (with structural sourceIds)
 *   - The C4 forbidden-field absorption table (one test per row)
 *   - B3 ambiguity detection (accumulate + throw; never silently pick one)
 *   - Structural sourceId determinism (re-adaptation produces same IDs)
 *   - Round-trip determinism (manifest + warnings stable)
 *   - Unknown version → `UnknownManifestVersion`
 *   - Webhook/integration NOT emitted as portable content; warnings carry
 *     source counts
 *
 * Out of scope: the strict v3 zod schema (M4), the domain handlers (M3), the
 * preflight orchestrator (M4), the legacy `importHabitat` path (PRESERVE —
 * stays byte-identical behind the flag until T11).
 */
import { describe, it, expect } from "vitest";
import {
  adaptV1,
  adaptV2,
  adaptUnknown,
  UnknownManifestVersion,
  AmbiguousLegacyTitleError,
  type AdaptedManifest,
  type AdaptOptions,
} from "../services/importManifest/legacyAdapter.js";
import type {
  HabitatImportManifest,
  MissionPortable,
  TaskPortable,
  CommentPortable,
} from "../services/importManifest/types.js";

// ---------------------------------------------------------------------------
// Fixture builders — keep inputs MINIMAL but realistic for v2 + v1 shapes.
// ---------------------------------------------------------------------------

const exportedAt = "2026-07-19T12:00:00.000Z";

interface V2ColumnOpts {
  name?: string;
  order?: number;
  wipLimit?: number | null;
  autoAdvance?: boolean;
  requiresClaim?: boolean;
  nextColumnName?: string | null;
  isTerminal?: boolean;
}

function v2Column(opts?: V2ColumnOpts): Record<string, unknown> {
  const o = opts ?? {};
  return {
    name: o.name ?? "Todo",
    order: o.order ?? 0,
    wipLimit: o.wipLimit ?? null,
    autoAdvance: o.autoAdvance ?? false,
    requiresClaim: o.requiresClaim ?? false,
    nextColumnName: o.nextColumnName ?? null,
    isTerminal: o.isTerminal ?? false,
  };
}

function v2Mission(opts?: {
  title?: string;
  description?: string;
  columnName?: string;
  status?: string;
  dependsOn?: string[];
  blocks?: string[];
  tasks?: Record<string, unknown>[];
  priority?: string;
  labels?: string[];
  dueAt?: string | null;
}): Record<string, unknown> {
  const o = opts ?? {};
  return {
    title: o.title ?? "Mission Alpha",
    description: o.description ?? "Alpha description",
    acceptanceCriteria: "AC",
    priority: o.priority ?? "high",
    labels: o.labels ?? [],
    columnName: o.columnName ?? "Todo",
    status: o.status ?? "not_started",
    dependsOn: o.dependsOn ?? [],
    blocks: o.blocks ?? [],
    dueAt: o.dueAt ?? null,
    tasks: o.tasks ?? [],
  };
}

function v2Task(opts?: {
  title?: string;
  status?: string;
  result?: string | null;
  artifacts?: unknown[];
  assignedAgentId?: string | null;
  rejectedCount?: number;
  rejectionReason?: string | null;
  requiredDomain?: string | null;
  requiredCapabilities?: string[];
  priority?: string;
}): Record<string, unknown> {
  const o = opts ?? {};
  return {
    title: o.title ?? "Task One",
    description: "Task description",
    priority: o.priority ?? "medium",
    status: o.status ?? "pending",
    requiredDomain: o.requiredDomain ?? null,
    requiredCapabilities: o.requiredCapabilities ?? [],
    result: o.result ?? null,
    artifacts: o.artifacts ?? [],
    assignedAgentId: o.assignedAgentId ?? null,
    rejectedCount: o.rejectedCount ?? 0,
    rejectionReason: o.rejectionReason ?? null,
    createdBy: "import",
  };
}

function v2Comment(opts?: {
  taskTitle?: string;
  authorId?: string;
  authorType?: string;
  content?: string;
}): Record<string, unknown> {
  const o = opts ?? {};
  return {
    taskTitle: o.taskTitle ?? "Task One",
    parentTaskTitle: null,
    content: o.content ?? "Comment body",
    authorType: o.authorType ?? "human",
    authorId: o.authorId ?? "user-1",
  };
}

function v2Template(opts?: {
  name?: string;
  titlePattern?: string;
  descriptionPattern?: string;
  priority?: string;
  labels?: string[];
  requiredDomain?: string | null;
  requiredCapabilities?: string[];
  isDefault?: boolean;
}): Record<string, unknown> {
  const o = opts ?? {};
  return {
    name: o.name ?? "Template A",
    titlePattern: o.titlePattern ?? "Mission {n}",
    descriptionPattern: o.descriptionPattern ?? "",
    priority: o.priority ?? "medium",
    labels: o.labels ?? [],
    requiredDomain: o.requiredDomain ?? null,
    requiredCapabilities: o.requiredCapabilities ?? [],
    isDefault: o.isDefault ?? false,
  };
}

function v2Webhook(opts?: { name?: string; url?: string }): Record<string, unknown> {
  const o = opts ?? {};
  return {
    name: o.name ?? "Hook A",
    url: o.url ?? "https://example.com/hook",
    events: [],
    headers: {},
    format: "standard",
    enabled: true,
  };
}

function v2Fixture(overrides?: {
  columns?: Record<string, unknown>[];
  missions?: Record<string, unknown>[];
  comments?: Record<string, unknown>[];
  templates?: Record<string, unknown>[];
  webhooks?: Record<string, unknown>[];
}): unknown {
  return {
    version: 2,
    exportedAt,
    habitat: {
      name: "Habitat A",
      description: "Top-level description",
      columns: overrides?.columns ?? [v2Column()],
      missions: overrides?.missions ?? [v2Mission()],
      comments: overrides?.comments ?? [],
      templates: overrides?.templates ?? [],
      webhooks: overrides?.webhooks ?? [],
    },
  };
}

function v1Fixture(overrides?: {
  boardName?: string;
  features?: Record<string, unknown>[];
  columns?: Record<string, unknown>[];
  board?: Record<string, unknown> | null;
  habitat?: Record<string, unknown> | null;
}): unknown {
  // v1 uses top-level `board` with `features` (the legacy shape the
  // silent z.preprocess normalized). If `board` is explicitly null, use the
  // explicit `habitat` shape; otherwise default to the v1 board+features form.
  if (overrides?.board !== undefined || overrides?.habitat !== undefined) {
    const habitat =
      overrides?.habitat ??
      ({
        name: overrides?.boardName ?? "Board A",
        columns: overrides?.columns ?? [v2Column()],
        features: overrides?.features ?? [v2Mission()],
      } as Record<string, unknown>);
    return { version: 1, exportedAt, habitat };
  }
  return {
    version: 1,
    exportedAt,
    board: {
      name: overrides?.boardName ?? "Board A",
      columns: overrides?.columns ?? [v2Column()],
      features: overrides?.features ?? [v2Mission()],
    },
  };
}

// ---------------------------------------------------------------------------
// 1. adaptUnknown — version dispatch
// ---------------------------------------------------------------------------

describe("adaptUnknown — version dispatch", () => {
  it("routes version:1 → adaptV1 (board/features → v3)", () => {
    const adapted = adaptUnknown(v1Fixture());
    expect(adapted.manifest.version).toBe(3);
    expect(adapted.manifest.identityPolicy).toBe("remap");
  });

  it("routes version:2 → adaptV2 (habitat.missions → v3)", () => {
    const adapted = adaptUnknown(v2Fixture());
    expect(adapted.manifest.version).toBe(3);
  });

  it("throws UnknownManifestVersion for version:4", () => {
    expect(() => adaptUnknown({ version: 4, exportedAt, habitat: {} })).toThrow(
      UnknownManifestVersion,
    );
    try {
      adaptUnknown({ version: 4, exportedAt, habitat: {} });
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownManifestVersion);
      expect((e as UnknownManifestVersion).version).toBe(4);
    }
  });

  it("throws UnknownManifestVersion for version:3 (v3 inputs pass through, not adapt)", () => {
    // `adaptUnknown` is for LEGACY adaptation only. v3 inputs are already v3;
    // M4's preflight passes them through. Routing them through `adaptUnknown`
    // is a caller bug — surface it.
    expect(() =>
      adaptUnknown({ version: 3, manifestId: "x", generatedAt: exportedAt, domains: {} }),
    ).toThrow(UnknownManifestVersion);
  });

  it("throws UnknownManifestVersion for missing version", () => {
    expect(() => adaptUnknown({ exportedAt, habitat: {} })).toThrow(UnknownManifestVersion);
  });

  it("throws UnknownManifestVersion for non-numeric version", () => {
    expect(() => adaptUnknown({ version: "two", exportedAt, habitat: {} })).toThrow(
      UnknownManifestVersion,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. adaptV1 — v1 → v3 happy path
// ---------------------------------------------------------------------------

describe("adaptV1 — v1 → v3 happy path", () => {
  it("normalizes board → habitat + features → missions + emits v3 manifest", () => {
    const adapted = adaptV1(v1Fixture());
    expect(adapted.manifest.version).toBe(3);
    expect(adapted.manifest.identityPolicy).toBe("remap");
    expect(adapted.manifest.mode).toBe("new");
    expect(adapted.manifest.generatedAt).toBe(exportedAt);
    expect(adapted.manifest.domains.habitatSettings?.data.name).toBe("Board A");
    expect(adapted.manifest.domains.missions?.data).toHaveLength(1);
    expect(adapted.manifest.domains.missions?.data[0].title).toBe("Mission Alpha");
  });

  it("records each v1 normalization in warnings (explicit over silent)", () => {
    const adapted = adaptV1(v1Fixture());
    // Both v1 normalizations happened: board→habitat AND features→missions.
    expect(adapted.warnings).toContain("v1 input: normalized top-level 'board' → 'habitat'");
    expect(adapted.warnings).toContain("v1 input: normalized habitat 'features' → 'missions'");
  });

  it("accepts a v1 input with explicit `habitat` + `features` (mixed form)", () => {
    const adapted = adaptV1(
      v1Fixture({ habitat: { name: "H", columns: [v2Column()], features: [v2Mission()] } }),
    );
    expect(adapted.manifest.domains.habitatSettings?.data.name).toBe("H");
    expect(adapted.warnings).toContain("v1 input: normalized habitat 'features' → 'missions'");
    // board→habitat warning NOT emitted when habitat is present.
    expect(adapted.warnings).not.toContain("v1 input: normalized top-level 'board' → 'habitat'");
  });

  it("throws when neither board nor habitat is present", () => {
    expect(() => adaptV1({ version: 1, exportedAt })).toThrow(/habitat/);
  });
});

// ---------------------------------------------------------------------------
// 3. adaptV2 — v2 → v3 happy path
// ---------------------------------------------------------------------------

describe("adaptV2 — v2 → v3 happy path", () => {
  it("emits a v3 manifest with structural sourceIds for every entity", () => {
    const adapted = adaptV2(
      v2Fixture({
        columns: [v2Column({ name: "Todo", order: 0 }), v2Column({ name: "Done", order: 1 })],
        missions: [
          v2Mission({
            title: "M1",
            columnName: "Todo",
            tasks: [v2Task({ title: "T1" }), v2Task({ title: "T2" })],
          }),
          v2Mission({ title: "M2", columnName: "Todo" }),
        ],
        comments: [v2Comment({ taskTitle: "T1" })],
        templates: [v2Template({ name: "Tmpl" })],
        webhooks: [v2Webhook({ name: "Hook" })],
      }),
    );

    const m = adapted.manifest;
    expect(m.version).toBe(3);
    expect(m.identityPolicy).toBe("remap");
    expect(m.mode).toBe("new");
    expect(m.lineage.sourceHabitatId).toBeNull();
    expect(m.lineage.sourceExportedAt).toBe(exportedAt);

    // Every entity has a `legacy:` structural sourceId.
    expect(m.domains.habitatSettings?.data.sourceId).toBe("legacy:habitat[0]");
    expect(m.domains.columns?.data[0].sourceId).toBe("legacy:column[0]");
    expect(m.domains.columns?.data[1].sourceId).toBe("legacy:column[1]");
    expect(m.domains.missions?.data[0].sourceId).toBe("legacy:mission[0]");
    expect(m.domains.missions?.data[1].sourceId).toBe("legacy:mission[1]");
    expect(m.domains.tasks?.data[0].sourceId).toBe("legacy:mission[0].task[0]");
    expect(m.domains.tasks?.data[1].sourceId).toBe("legacy:mission[0].task[1]");
    expect(m.domains.comments?.data[0].sourceId).toBe("legacy:comment[0]");
    expect(m.domains.templates?.data[0].sourceId).toBe("legacy:template[0]");

    // Task → mission linkage uses the mission's structural sourceId.
    expect(m.domains.tasks?.data[0].missionSourceId).toBe("legacy:mission[0]");
    expect(m.domains.tasks?.data[1].missionSourceId).toBe("legacy:mission[0]");
    // Comment → task linkage uses the task's structural sourceId.
    expect(m.domains.comments?.data[0].taskSourceId).toBe("legacy:mission[0].task[0]");
  });

  it("structural sourceIds are deterministic across re-adaptation (B3)", () => {
    const input = v2Fixture({
      missions: [
        v2Mission({ title: "M1", tasks: [v2Task({ title: "T1" })] }),
        v2Mission({ title: "M2", tasks: [v2Task({ title: "T2" })] }),
      ],
    });
    const a = adaptV2(input);
    const b = adaptV2(input);

    // Re-adaptation produces IDENTICAL sourceIds.
    expect(a.manifest.domains.missions?.data.map((m) => m.sourceId)).toEqual(
      b.manifest.domains.missions?.data.map((m) => m.sourceId),
    );
    expect(a.manifest.domains.tasks?.data.map((t) => t.sourceId)).toEqual(
      b.manifest.domains.tasks?.data.map((t) => t.sourceId),
    );

    // The actual values: structural, predictable, prefixed.
    expect(a.manifest.domains.missions?.data[0].sourceId).toBe("legacy:mission[0]");
    expect(a.manifest.domains.missions?.data[1].sourceId).toBe("legacy:mission[1]");
    expect(a.manifest.domains.tasks?.data[0].sourceId).toBe("legacy:mission[0].task[0]");
    expect(a.manifest.domains.tasks?.data[1].sourceId).toBe("legacy:mission[1].task[0]");
  });

  it("round-trip determinism: adapting the same input twice produces identical manifest + warnings", () => {
    const input = v2Fixture({
      missions: [
        v2Mission({
          title: "M1",
          status: "in_progress",
          dependsOn: ["M2"],
          tasks: [v2Task({ title: "T1", status: "in_progress", result: "done" })],
        }),
        v2Mission({ title: "M2", blocks: ["M1"] }),
      ],
      comments: [v2Comment({ taskTitle: "T1", authorId: "agent-7" })],
      webhooks: [v2Webhook({ name: "W1" }), v2Webhook({ name: "W2" })],
    });
    const a = adaptV2(input);
    const b = adaptV2(input);
    expect(a).toEqual(b);

    // **Failure mode**: non-deterministic warnings (e.g. Set/Map iteration
    // order) would make `a !== b` — the preflight's retry-after-fix would
    // produce a different error/warning set, breaking progress tracking.
  });

  it("accepts a caller-supplied manifestId + mode override", () => {
    const options: AdaptOptions = {
      manifestId: "attempt-01926f5e",
      mode: "replacement",
    };
    const adapted = adaptV2(v2Fixture(), options);
    expect(adapted.manifest.manifestId).toBe("attempt-01926f5e");
    expect(adapted.manifest.mode).toBe("replacement");
    // identityPolicy stays remap regardless of mode override (B3).
    expect(adapted.manifest.identityPolicy).toBe("remap");
  });

  it("derives a stable manifestId from the input when no override is provided", () => {
    const a = adaptV2(v2Fixture());
    const b = adaptV2(v2Fixture());
    expect(a.manifest.manifestId).toBe(b.manifest.manifestId);
    expect(a.manifest.manifestId).toBe(`legacy-adapted:2:${exportedAt}`);
  });
});

// ---------------------------------------------------------------------------
// 4. C4 forbidden-field absorption (one test per row of the C4 table)
// ---------------------------------------------------------------------------

describe("C4 forbidden-field absorption", () => {
  // ----- C4 row 1: Task execution state -----
  it("Task execution state (status/result/artifacts/assignedAgentId/retry) dropped; warn per Task", () => {
    const adapted = adaptV2(
      v2Fixture({
        missions: [
          v2Mission({
            title: "M1",
            tasks: [
              v2Task({
                title: "T1",
                status: "in_progress",
                result: "shipped artifact X",
                artifacts: [{ type: "build", url: "https://x", description: "" }],
                assignedAgentId: "agent-7",
                rejectedCount: 2,
                rejectionReason: "policy_veto",
              }),
            ],
          }),
        ],
      }),
    );

    const task = adapted.manifest.domains.tasks?.data[0] as TaskPortable;
    // TaskPortable has NO execution-state slots — shape is clean.
    expect(task).toMatchObject({
      title: "T1",
      missionSourceId: "legacy:mission[0]",
      priority: "medium",
      requiredDomain: null,
      requiredCapabilities: [],
    });
    expect((task as unknown as Record<string, unknown>).status).toBeUndefined();
    expect((task as unknown as Record<string, unknown>).result).toBeUndefined();
    expect((task as unknown as Record<string, unknown>).artifacts).toBeUndefined();
    expect((task as unknown as Record<string, unknown>).assignedAgentId).toBeUndefined();

    // The warning enumerates every dropped field.
    const taskWarning = adapted.warnings.find((w) => w.startsWith("task 'T1':"));
    expect(taskWarning).toBeDefined();
    expect(taskWarning).toContain("status='in_progress'");
    expect(taskWarning).toContain("result");
    expect(taskWarning).toContain("artifacts");
    expect(taskWarning).toContain("assignedAgentId");
    expect(taskWarning).toContain("rejectedCount=2");
    expect(taskWarning).toContain("rejectionReason");
  });

  it("Task with default execution state emits NO warning (no absorption needed)", () => {
    const adapted = adaptV2(
      v2Fixture({
        missions: [
          v2Mission({
            tasks: [v2Task({ title: "T-clean", status: "pending", result: null, artifacts: [] })],
          }),
        ],
      }),
    );
    expect(adapted.warnings.find((w) => w.startsWith("task 'T-clean':"))).toBeUndefined();
  });

  // ----- C4 row 2: Mission execution state -----
  it("Mission execution state (status) dropped; warn per Mission", () => {
    const adapted = adaptV2(
      v2Fixture({
        missions: [
          v2Mission({ title: "M-active", status: "in_progress" }),
          v2Mission({ title: "M-clean", status: "not_started" }),
        ],
      }),
    );
    const missions = adapted.manifest.domains.missions?.data as MissionPortable[];
    expect((missions[0] as unknown as Record<string, unknown>).status).toBeUndefined();
    expect((missions[1] as unknown as Record<string, unknown>).status).toBeUndefined();

    // Warning emitted for the non-default mission only.
    const warnActive = adapted.warnings.find((w) => w.startsWith("mission 'M-active':"));
    expect(warnActive).toBeDefined();
    expect(warnActive).toContain("status='in_progress'");
    expect(warnActive).toContain("reset to not_started");

    // Clean mission emits NO status warning.
    expect(adapted.warnings.find((w) => w.startsWith("mission 'M-clean':"))).toBeUndefined();
  });

  // ----- C4 row 3: Webhook/integration domain -----
  it("Webhook/integration NOT emitted as portable; warn per source webhook", () => {
    const adapted = adaptV2(
      v2Fixture({
        webhooks: [
          v2Webhook({ name: "Hook1", url: "https://a" }),
          v2Webhook({ name: "Hook2", url: "https://b" }),
          v2Webhook({ name: "Hook3", url: "https://c" }),
        ],
      }),
    );

    // The manifest has NO webhook domain (whole-domain preserve/reset only).
    expect(adapted.manifest.domains).not.toHaveProperty("webhooks");
    expect(adapted.manifest.domains).not.toHaveProperty("integrations");

    // Warnings carry per-source counts (3 webhooks = 3 warnings).
    const webhookWarnings = adapted.warnings.filter((w) => w.startsWith("webhook 'Hook"));
    expect(webhookWarnings).toHaveLength(3);
    expect(webhookWarnings[0]).toContain("Hook1");
    expect(webhookWarnings[1]).toContain("Hook2");
    expect(webhookWarnings[2]).toContain("Hook3");
    // Every warning notes the disposition rule.
    for (const w of webhookWarnings) {
      expect(w).toContain("preserve/reset only");
      expect(w).toContain("never reconstructed");
    }
  });

  // ----- C4 row 4: Comment authorId → importedAttribution -----
  it("Comment authorId carried as author.importedAttribution with resolvedActorId: null", () => {
    const adapted = adaptV2(
      v2Fixture({
        missions: [v2Mission({ title: "M1", tasks: [v2Task({ title: "T1" })] })],
        comments: [
          v2Comment({ taskTitle: "T1", authorId: "agent-007", authorType: "agent" }),
          v2Comment({ taskTitle: "T1", authorId: "user-42", authorType: "human" }),
        ],
      }),
    );
    const comments = adapted.manifest.domains.comments?.data as CommentPortable[];
    expect(comments).toHaveLength(2);
    expect(comments[0].author).toEqual({
      resolvedActorId: null,
      importedAttribution: "agent-007",
    });
    expect(comments[0].authorType).toBe("agent");
    expect(comments[1].author).toEqual({
      resolvedActorId: null,
      importedAttribution: "user-42",
    });
    expect(comments[1].authorType).toBe("human");

    // No warning emitted for the authorId resolution — this is the
    // documented resolution (every comment carries both fields; T10B
    // resolves at apply time).
    expect(adapted.warnings.filter((w) => w.includes("authorId"))).toEqual([]);
  });

  // ----- C4 row 5: Mission dependsOn/blocks (title-keyed) → structural IDs -----
  it("Mission dependsOn/blocks re-keyed through structural source IDs", () => {
    const adapted = adaptV2(
      v2Fixture({
        missions: [
          v2Mission({ title: "M1", columnName: "Todo", dependsOn: ["M2"], blocks: ["M3"] }),
          v2Mission({ title: "M2", columnName: "Todo" }),
          v2Mission({ title: "M3", columnName: "Todo" }),
        ],
      }),
    );
    const missions = adapted.manifest.domains.missions?.data as MissionPortable[];
    expect(missions[0].dependsOnSourceIds).toEqual(["legacy:mission[1]"]);
    expect(missions[0].blocksSourceIds).toEqual(["legacy:mission[2]"]);

    // No titles leak into the structural-ID arrays.
    expect(missions[0].dependsOnSourceIds.every((id) => id.startsWith("legacy:"))).toBe(true);
    expect(missions[0].blocksSourceIds.every((id) => id.startsWith("legacy:"))).toBe(true);
  });

  it("Mission dependsOn referencing unknown title → dropped with warning", () => {
    const adapted = adaptV2(
      v2Fixture({
        missions: [v2Mission({ title: "M1", dependsOn: ["DoesNotExist"] })],
      }),
    );
    const mission = adapted.manifest.domains.missions?.data[0] as MissionPortable;
    expect(mission.dependsOnSourceIds).toEqual([]);
    expect(
      adapted.warnings.find(
        (w) => w.includes("references unknown title") && w.includes("DoesNotExist"),
      ),
    ).toBeDefined();
  });

  // ----- C4 row 6: Planning config preserved as-is -----
  it("Planning config (columns, templates, labels, priority) preserved as-is", () => {
    const adapted = adaptV2(
      v2Fixture({
        columns: [
          v2Column({ name: "Todo", order: 0, wipLimit: 3, isTerminal: false }),
          v2Column({
            name: "Done",
            order: 1,
            wipLimit: null,
            nextColumnName: null,
            isTerminal: true,
          }),
        ],
        missions: [
          v2Mission({
            title: "M1",
            columnName: "Todo",
            priority: "critical",
            labels: ["alpha", "beta"],
          }),
        ],
        templates: [
          v2Template({
            name: "Tmpl",
            priority: "high",
            labels: ["tpl-label"],
            isDefault: true,
          }),
        ],
      }),
    );

    const columns = adapted.manifest.domains.columns?.data;
    expect(columns?.[0]).toMatchObject({
      name: "Todo",
      order: 0,
      wipLimit: 3,
      isTerminal: false,
    });
    expect(columns?.[1]).toMatchObject({
      name: "Done",
      order: 1,
      isTerminal: true,
    });

    const mission = adapted.manifest.domains.missions?.data[0];
    expect(mission?.priority).toBe("critical");
    expect(mission?.labels).toEqual(["alpha", "beta"]);

    const template = adapted.manifest.domains.templates?.data[0];
    expect(template?.isDefault).toBe(true);
    expect(template?.content.labels).toEqual(["tpl-label"]);
    expect(template?.content.missions[0].priority).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// 5. B3 ambiguity detection (accumulate + throw; never silently pick one)
// ---------------------------------------------------------------------------

describe("B3 ambiguity detection — accumulate + throw", () => {
  it("duplicate mission titles referenced via dependsOn → throws AmbiguousLegacyTitleError", () => {
    expect(() =>
      adaptV2(
        v2Fixture({
          missions: [
            v2Mission({ title: "Dup", columnName: "Todo", dependsOn: ["Target"] }),
            v2Mission({ title: "Dup", columnName: "Todo" }),
            v2Mission({ title: "Target", columnName: "Todo", dependsOn: ["Dup"] }),
          ],
        }),
      ),
    ).toThrow(AmbiguousLegacyTitleError);
  });

  it("duplicate task titles referenced via comment → throws AmbiguousLegacyTitleError", () => {
    expect(() =>
      adaptV2(
        v2Fixture({
          missions: [
            v2Mission({
              title: "M",
              tasks: [v2Task({ title: "TDup" }), v2Task({ title: "TDup" })],
            }),
          ],
          comments: [v2Comment({ taskTitle: "TDup" })],
        }),
      ),
    ).toThrow(AmbiguousLegacyTitleError);
  });

  it("ALL ambiguities accumulate in the thrown error (not first-error)", () => {
    // Trigger all three ambiguity kinds in one input. To trigger
    // `duplicate_mission_title_in_blocks`, Ref must BLOCK the duplicate
    // (the detector flags refs TO a duplicate title, not FROM one).
    try {
      adaptV2(
        v2Fixture({
          missions: [
            v2Mission({
              title: "M-Dup",
              columnName: "Todo",
              dependsOn: ["Ref"],
              blocks: ["Ref"],
              tasks: [v2Task({ title: "T-Dup" }), v2Task({ title: "T-Dup" })],
            }),
            v2Mission({ title: "M-Dup", columnName: "Todo" }),
            v2Mission({
              title: "Ref",
              columnName: "Todo",
              dependsOn: ["M-Dup"],
              blocks: ["M-Dup"],
            }),
          ],
          comments: [v2Comment({ taskTitle: "T-Dup" })],
        }),
      );
      throw new Error("expected adaptV2 to throw AmbiguousLegacyTitleError");
    } catch (e) {
      expect(e).toBeInstanceOf(AmbiguousLegacyTitleError);
      const err = e as AmbiguousLegacyTitleError;
      // All three ambiguity kinds present — NOT first-error short-circuit.
      expect(err.ambiguities.length).toBeGreaterThanOrEqual(3);
      const kinds = new Set(err.ambiguities.map((a) => a.kind));
      expect(kinds.has("duplicate_mission_title_in_dependsOn")).toBe(true);
      expect(kinds.has("duplicate_mission_title_in_blocks")).toBe(true);
      expect(kinds.has("duplicate_task_title_in_comment")).toBe(true);
    }
  });

  it("duplicate titles NOT referenced → does NOT throw (duplicates alone are not ambiguous)", () => {
    // Two missions share a title but nothing references either. The
    // detector only flags referenced duplicates — silent duplicates are
    // de-duped by first-occurrence-wins in the title→sourceId map.
    const adapted = adaptV2(
      v2Fixture({
        missions: [
          v2Mission({ title: "SilentDup", columnName: "Todo" }),
          v2Mission({ title: "SilentDup", columnName: "Todo" }),
        ],
      }),
    );
    expect(adapted.manifest.domains.missions?.data).toHaveLength(2);
  });

  it("the thrown error carries the offending titles for diagnostic display", () => {
    try {
      adaptV2(
        v2Fixture({
          missions: [
            v2Mission({ title: "Dup", columnName: "Todo", dependsOn: ["Ref"] }),
            v2Mission({ title: "Dup", columnName: "Todo" }),
            v2Mission({ title: "Ref", columnName: "Todo", dependsOn: ["Dup"] }),
          ],
        }),
      );
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AmbiguousLegacyTitleError);
      const err = e as AmbiguousLegacyTitleError;
      const titles = err.ambiguities.map((a) =>
        a.kind === "duplicate_task_title_in_comment" ? a.taskTitle : a.missionTitle,
      );
      expect(titles).toContain("Dup");
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Identity policy (legacy = remap-only)
// ---------------------------------------------------------------------------

describe("Identity policy — legacy always remap", () => {
  it("v1 always emits identityPolicy: 'remap'", () => {
    const adapted = adaptV1(v1Fixture());
    expect(adapted.manifest.identityPolicy).toBe("remap");
  });

  it("v2 always emits identityPolicy: 'remap'", () => {
    const adapted = adaptV2(v2Fixture());
    expect(adapted.manifest.identityPolicy).toBe("remap");
  });

  it("lineage.sourceHabitatId is null (legacy has no lineage — restore requires proof)", () => {
    const adapted = adaptV2(v2Fixture());
    expect(adapted.manifest.lineage.sourceHabitatId).toBeNull();
    expect(adapted.manifest.lineage.sourceManifestId).toBeNull();
    // sourceExportedAt is preserved (the input's exportedAt).
    expect(adapted.manifest.lineage.sourceExportedAt).toBe(exportedAt);
  });
});

// ---------------------------------------------------------------------------
// 7. Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  it("empty habitat (no missions, no tasks) → emits v3 manifest with empty domains", () => {
    const adapted = adaptV2({
      version: 2,
      exportedAt,
      habitat: {
        name: "Empty",
        description: "",
        columns: [v2Column()],
        missions: [],
        comments: [],
        templates: [],
        webhooks: [],
      },
    });
    expect(adapted.manifest.version).toBe(3);
    expect(adapted.manifest.domains.habitatSettings?.data.name).toBe("Empty");
    expect(adapted.manifest.domains.missions).toBeUndefined();
    expect(adapted.manifest.domains.tasks).toBeUndefined();
    expect(adapted.manifest.domains.comments).toBeUndefined();
    expect(adapted.manifest.domains.templates).toBeUndefined();
  });

  it("standalone tasks (habitat.tasks with no missions) → synthetic missions (v0.31 compat)", () => {
    const adapted = adaptV2({
      version: 2,
      exportedAt,
      habitat: {
        name: "Standalone",
        description: "",
        columns: [v2Column({ name: "Todo" })],
        missions: [],
        tasks: [v2Task({ title: "Standalone-A" }), v2Task({ title: "Standalone-B" })],
        comments: [],
        templates: [],
        webhooks: [],
      },
    });
    // Two synthetic missions, one per standalone task.
    expect(adapted.manifest.domains.missions?.data).toHaveLength(2);
    expect(adapted.manifest.domains.missions?.data[0].title).toBe("Standalone-A");
    expect(adapted.manifest.domains.missions?.data[1].title).toBe("Standalone-B");

    // Each task is nested under its synthetic mission.
    const tasks = adapted.manifest.domains.tasks?.data;
    expect(tasks?.[0].missionSourceId).toBe("legacy:mission[0]");
    expect(tasks?.[1].missionSourceId).toBe("legacy:mission[1]");

    // Warnings note the synthetic-mission lift.
    const liftWarnings = adapted.warnings.filter((w) => w.includes("lifted to synthetic mission"));
    expect(liftWarnings).toHaveLength(2);
  });

  it("comment referencing unknown task → dropped with warning", () => {
    const adapted = adaptV2(
      v2Fixture({
        comments: [v2Comment({ taskTitle: "DoesNotExist" })],
      }),
    );
    expect(adapted.manifest.domains.comments).toBeUndefined();
    expect(
      adapted.warnings.find((w) => w.includes("DoesNotExist") && w.includes("does not resolve")),
    ).toBeDefined();
  });

  it("comment with invalid authorType → defaulted + warned", () => {
    const adapted = adaptV2(
      v2Fixture({
        missions: [v2Mission({ tasks: [v2Task({ title: "T1" })] })],
        comments: [v2Comment({ taskTitle: "T1", authorType: "alien" })],
      }),
    );
    const comment = adapted.manifest.domains.comments?.data[0] as CommentPortable;
    expect(comment.authorType).toBe("human");
    expect(adapted.warnings.find((w) => w.includes("authorType 'alien'"))).toBeDefined();
  });

  it("invalid priority value → defaulted + warned", () => {
    const adapted = adaptV2(
      v2Fixture({
        missions: [v2Mission({ title: "M1", priority: "urgent" as unknown as string })],
      }),
    );
    const mission = adapted.manifest.domains.missions?.data[0];
    expect(mission?.priority).toBe("medium"); // defaulted
    expect(
      adapted.warnings.find((w) => w.includes("priority 'urgent'") && w.includes("mission 'M1'")),
    ).toBeDefined();
  });

  it("column with autoAdvance/requiresClaim true → policy fields warned + dropped", () => {
    const adapted = adaptV2(
      v2Fixture({
        columns: [v2Column({ name: "Auto", order: 0, autoAdvance: true, requiresClaim: true })],
      }),
    );
    const col = adapted.manifest.domains.columns?.data[0];
    // v3 ColumnPortable has no autoAdvance/requiresClaim slots.
    expect((col as unknown as Record<string, unknown>).autoAdvance).toBeUndefined();
    expect((col as unknown as Record<string, unknown>).requiresClaim).toBeUndefined();
    expect(
      adapted.warnings.find((w) => w.includes("column 'Auto'") && w.includes("autoAdvance=true")),
    ).toBeDefined();
  });

  it("template with requiredDomain/requiredCapabilities → task-level fields warned + dropped", () => {
    const adapted = adaptV2(
      v2Fixture({
        templates: [
          v2Template({
            name: "Tpl",
            requiredDomain: "code_review",
            requiredCapabilities: ["rust", "typescript"],
          }),
        ],
      }),
    );
    const tpl = adapted.manifest.domains.templates?.data[0];
    expect(tpl).toBeDefined();
    const tplMission = tpl!.content.missions[0];
    expect(tplMission).toBeDefined();
    // Task-level fields not on the mission-shaped content.
    expect((tplMission as unknown as Record<string, unknown>).requiredDomain).toBeUndefined();
    expect(
      adapted.warnings.find(
        (w) => w.includes("template 'Tpl'") && w.includes("requiredDomain='code_review'"),
      ),
    ).toBeDefined();
  });

  it("parentCommentSourceId is always null (v0.31 ignores parentTaskTitle)", () => {
    // v2's parentTaskTitle field is ignored by the v0.31 importer
    // (habitatService.ts:640 sets parentId: null unconditionally). The
    // adapter faithfully reflects that behavior.
    const adapted = adaptV2(
      v2Fixture({
        missions: [v2Mission({ tasks: [v2Task({ title: "T1" })] })],
        comments: [
          {
            ...v2Comment({ taskTitle: "T1" }),
            parentTaskTitle: "T1",
          },
        ],
      }),
    );
    const comment = adapted.manifest.domains.comments?.data[0];
    expect(comment?.parentCommentSourceId).toBeNull();
  });

  it("non-object input → throws clear error", () => {
    expect(() => adaptV2(null)).toThrow(/non-null object/);
    expect(() => adaptV2("not-an-object")).toThrow(/non-null object/);
    expect(() => adaptV2([])).toThrow(/non-null object/);
    expect(() => adaptV1(null)).toThrow(/non-null object/);
  });
});

// ---------------------------------------------------------------------------
// 8. Output shape — AdaptedManifest
// ---------------------------------------------------------------------------

describe("AdaptedManifest shape", () => {
  it("returns { manifest, warnings } with manifest.version === 3", () => {
    const adapted: AdaptedManifest = adaptV2(v2Fixture());
    expect(adapted).toHaveProperty("manifest");
    expect(adapted).toHaveProperty("warnings");
    expect(adapted.manifest.version).toBe(3);
    expect(Array.isArray(adapted.warnings)).toBe(true);
  });

  it("every declared domain carries disposition: 'replace' (legacy replaces target content)", () => {
    const adapted = adaptV2(v2Fixture());
    const domains = adapted.manifest.domains;
    // Legacy adapter always emits `disposition: "replace"` for declared
    // domains (the route decides the actual disposition via the preflight
    // override; the adapter's default reflects "the source content REPLACES
    // the target's existing domain content" — the destructive-intent signal).
    if (domains.habitatSettings) expect(domains.habitatSettings.disposition).toBe("replace");
    if (domains.columns) expect(domains.columns.disposition).toBe("replace");
    if (domains.missions) expect(domains.missions.disposition).toBe("replace");
    if (domains.tasks) expect(domains.tasks.disposition).toBe("replace");
    if (domains.comments) expect(domains.comments.disposition).toBe("replace");
    if (domains.templates) expect(domains.templates.disposition).toBe("replace");
  });
});
