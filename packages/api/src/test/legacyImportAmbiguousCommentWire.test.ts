/**
 * Wire regression for GitHub issue #417 — typed legacy Task-title ambiguity
 * mapped to bounded actionable HTTP 400 on both new and replacement import
 * entry points, before attempt reservation or Habitat state changes.
 *
 * Uses the real production HTTP assembly (`createHttpApplication` + empty
 * validated plugin catalog + `finalize`) backed by a disposable native
 * SQLite file (`initDb`), authenticated JWTs, and synthetic data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";

import { closeDb, getDb, initDb } from "../db/index.js";
import {
  habitats,
  importAttempts,
  missionComments,
  missions,
  taskComments,
  taskCreationAttempts,
  tasks,
  users,
} from "../db/schema/index.js";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import * as columnRepo from "../repositories/column.js";
import * as commentRepo from "../repositories/comment.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as missionRepo from "../repositories/mission.js";
import * as orgRepo from "../repositories/organization.js";
import * as taskRepo from "../repositories/task.js";
import * as teamRepo from "../repositories/team.js";
import * as memberRepo from "../repositories/teamMember.js";
import { createHabitat, exportHabitat } from "../services/habitatService.js";
import { exportHabitatManifest } from "../services/habitatManifestExporter.js";

const preflightSeam = vi.hoisted(() => ({ throwInfraError: false }));
vi.mock("../services/importManifest/preflightImport.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/importManifest/preflightImport.js")>();
  return {
    ...actual,
    prepareImport: (input: Parameters<typeof actual.prepareImport>[0]) => {
      if (preflightSeam.throwInfraError) {
        throw new Error("simulated database connection loss");
      }
      return actual.prepareImport(input);
    },
  };
});

const EXPORTED_AT = "2026-11-28T12:00:00.000Z";

let app: HttpRuntimeHandle;
let tempDir: string;

const priorEnv = Object.fromEntries(
  ["SLACK_SIGNING_SECRET", "DISCORD_PUBLIC_KEY", "ORCY_REGISTRATION_TOKEN", "HOST"].map((k) => [
    k,
    process.env[k],
  ]),
);

function seedUser(role: "admin" | "editor" = "editor"): string {
  const id = randomUUID();
  getDb()
    .insert(users)
    .values({ id, username: `user-${id}`, passwordHash: "x", role })
    .run();
  return id;
}

function signHumanToken(sub: string, role: "admin" | "editor" = "editor"): string {
  return jwt.sign({ sub, username: `user-${sub}`, role }, getJwtSecret(), {
    issuer: "orcy",
    expiresIn: "1h",
  });
}

function seedExportedAmbiguousV2Artifact(): Record<string, unknown> {
  const { habitat } = createHabitat({ name: "Ambiguous Source", defaultColumns: true });
  habitatRepo.updateHabitat(habitat.id, {
    description: "Sensitive unrelated habitat description",
  });
  const detail = habitatRepo.getHabitatWithColumnsAndTasks(habitat.id)!;
  const todoCol = detail.columns[0]!;

  const m1 = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: todoCol.id,
    title: "Unrelated Mission One",
    createdBy: "seed-user",
  });
  const m2 = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: todoCol.id,
    title: "Unrelated Mission Two",
    createdBy: "seed-user",
  });

  const sharedTask1 = taskRepo.createTask({
    missionId: m1.id,
    title: "Shared Task Title",
    description: "Unrelated task one description",
    createdBy: "seed-user",
  });
  taskRepo.createTask({
    missionId: m2.id,
    title: "Shared Task Title",
    description: "Unrelated task two description",
    createdBy: "seed-user",
  });
  taskRepo.createTask({
    missionId: m2.id,
    title: "Unrelated Distinct Task",
    description: "Unrelated distinct description",
    createdBy: "seed-user",
  });

  commentRepo.createComment({
    taskId: sharedTask1.id,
    authorType: "human",
    authorId: "secret-comment-author-id",
    content: "Sensitive comment body content that must not leak",
  });

  const exported = exportHabitat(habitat.id)!;
  // Clean up source habitat so assertions only observe target/new state.
  habitatRepo.deleteHabitat(habitat.id);
  return exported as unknown as Record<string, unknown>;
}

function buildUnambiguousV2Artifact(
  habitatName = "Unambiguous Habitat",
  exportedAt = EXPORTED_AT,
): Record<string, unknown> {
  return {
    version: 2,
    exportedAt,
    habitat: {
      name: habitatName,
      description: "Clean v2 export",
      columns: [
        { name: "Todo", order: 0, wipLimit: null, nextColumnName: null, isTerminal: false },
      ],
      missions: [
        {
          title: "Clean Mission",
          description: "",
          acceptanceCriteria: "",
          priority: "medium",
          labels: [],
          columnName: "Todo",
          dependsOn: [],
          blocks: [],
          dueAt: null,
          tasks: [
            {
              title: "Unique Task Alpha",
              description: "First",
              priority: "medium",
              requiredDomain: null,
              requiredCapabilities: [],
            },
            {
              title: "Unique Task Beta",
              description: "Second",
              priority: "medium",
              requiredDomain: null,
              requiredCapabilities: [],
            },
          ],
        },
      ],
      comments: [
        {
          taskTitle: "Unique Task Alpha",
          parentTaskTitle: null,
          content: "Pinned to Task Alpha",
          authorType: "human",
          authorId: "author-1",
        },
      ],
      templates: [],
      webhooks: [],
    },
  };
}

beforeEach(async () => {
  preflightSeam.throwInfraError = false;
  process.env.SLACK_SIGNING_SECRET ??= randomBytes(16).toString("hex");
  process.env.DISCORD_PUBLIC_KEY ??= randomBytes(32).toString("hex");
  process.env.ORCY_REGISTRATION_TOKEN ??= randomBytes(16).toString("hex");
  delete process.env.HOST;

  tempDir = mkdtempSync(join(tmpdir(), "orcy-legacy-import-ambig-"));
  await initDb(join(tempDir, "orcy.sqlite"));
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]);
  await app.finalize();
}, 120_000);

afterEach(async () => {
  preflightSeam.throwInfraError = false;
  try {
    await app?.close();
  } finally {
    closeDb();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

describe("legacy import ambiguous Task-title comment -> bounded 400", () => {
  it.each(["/api/v1/habitats/import", "/api/habitats/import"])(
    "POST %s returns actionable 400 without reserving attempt or creating Habitat",
    async (url) => {
      const userId = seedUser("admin");
      const token = signHumanToken(userId, "admin");
      const ambiguousPayload = seedExportedAmbiguousV2Artifact();

      const habitatsBefore = getDb().select().from(habitats).all().length;
      const attemptsBefore = getDb().select().from(importAttempts).all().length;
      const coordBefore = getDb().select().from(taskCreationAttempts).all().length;

      const res = await app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${token}` },
        payload: ambiguousPayload,
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.code).toBe("AMBIGUOUS_LEGACY_TITLE");
      expect(typeof body.error).toBe("string");
      expect(body.error).toContain("Shared Task Title");
      expect(body.details).toMatchObject({
        totalAmbiguities: 1,
        truncated: false,
        ambiguities: [
          {
            kind: "duplicate_task_title_in_comment",
            taskTitle: "Shared Task Title",
            commentRefCount: 1,
          },
        ],
      });

      // Do not disclose unrelated input data.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("Sensitive comment body content");
      expect(serialized).not.toContain("secret-comment-author-id");
      expect(serialized).not.toContain("Sensitive unrelated habitat description");
      expect(serialized).not.toContain("Unrelated Distinct Task");
      expect(serialized).not.toContain("Unrelated Mission One");

      // No attempt reserved, no Habitat created.
      expect(getDb().select().from(habitats).all()).toHaveLength(habitatsBefore);
      expect(getDb().select().from(importAttempts).all()).toHaveLength(attemptsBefore);
      expect(getDb().select().from(taskCreationAttempts).all()).toHaveLength(coordBefore);
    },
  );

  it.each(["/api/v1/habitats", "/api/habitats"])(
    "POST %s/:habitatId/import returns actionable 400 without reserving attempt or mutating target Habitat",
    async (prefix) => {
      const memberId = seedUser("editor");
      const token = signHumanToken(memberId, "editor");
      const org = orgRepo.createOrganization({ name: "Org", slug: randomUUID() });
      const team = teamRepo.createTeam({
        organizationId: org.id,
        name: "Team",
        slug: randomUUID(),
      });
      memberRepo.addMember({ teamId: team.id, userId: memberId, role: "member" });
      const target = habitatRepo.createHabitat({ name: "Existing Target", teamId: team.id });
      const col = columnRepo.createColumn({ habitatId: target.id, name: "Todo", order: 0 });
      const existingMission = missionRepo.createMission({
        habitatId: target.id,
        columnId: col.id,
        title: "Existing Mission",
        createdBy: memberId,
      });
      const existingTask = taskRepo.createTask({
        missionId: existingMission.id,
        title: "Shared Task Title",
        createdBy: memberId,
      });
      const beforeHabitat = habitatRepo.getHabitatById(target.id)!;

      const ambiguousPayload = seedExportedAmbiguousV2Artifact();

      const res = await app.inject({
        method: "POST",
        url: `${prefix}/${target.id}/import`,
        headers: { authorization: `Bearer ${token}` },
        payload: ambiguousPayload,
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.code).toBe("AMBIGUOUS_LEGACY_TITLE");
      expect(body.error).toContain("Shared Task Title");

      // Target habitat, mission, tasks, comments, and attempts are untouched.
      const afterHabitat = habitatRepo.getHabitatById(target.id)!;
      expect(afterHabitat.updatedAt).toBe(beforeHabitat.updatedAt);
      expect(afterHabitat.name).toBe("Existing Target");
      expect(getDb().select().from(missions).where(eq(missions.habitatId, target.id)).all()).toHaveLength(1);
      expect(getDb().select().from(tasks).where(eq(tasks.missionId, existingMission.id)).all()).toHaveLength(1);
      expect(getDb().select().from(taskComments).where(eq(taskComments.taskId, existingTask.id)).all()).toHaveLength(0);
      expect(getDb().select().from(missionComments).where(eq(missionComments.missionId, existingMission.id)).all()).toHaveLength(0);
      expect(getDb().select().from(importAttempts).all()).toHaveLength(0);
      expect(getDb().select().from(taskCreationAttempts).all()).toHaveLength(0);
    },
  );

  it("handles v1 (board/features) ambiguous Task-title comment with 400 and no state change", async () => {
    const userId = seedUser("admin");
    const token = signHumanToken(userId, "admin");
    const v1Ambiguous = {
      version: 1,
      exportedAt: EXPORTED_AT,
      board: {
        name: "V1 Ambiguous",
        columns: [{ name: "Todo", order: 0, isTerminal: false }],
        features: [
          {
            title: "V1 Feature",
            columnName: "Todo",
            tasks: [{ title: "Dup V1 Task" }, { title: "Dup V1 Task" }],
          },
        ],
        comments: [
          {
            taskTitle: "Dup V1 Task",
            parentTaskTitle: null,
            content: "Secret v1 comment",
            authorType: "human",
            authorId: "v1-author",
          },
        ],
      },
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/habitats/import",
      headers: { authorization: `Bearer ${token}` },
      payload: v1Ambiguous,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("AMBIGUOUS_LEGACY_TITLE");
    expect(res.json().error).toContain("Dup V1 Task");
    expect(res.body).not.toContain("Secret v1 comment");
    expect(getDb().select().from(habitats).all()).toHaveLength(0);
    expect(getDb().select().from(importAttempts).all()).toHaveLength(0);
  });

  it("bounds error message and details when titles are huge or ambiguities are numerous", async () => {
    const userId = seedUser("admin");
    const token = signHumanToken(userId, "admin");
    const hugeTitle = `LongTitle-${"x".repeat(400)}\nInjectedLine`;
    const dupTasks: Array<Record<string, unknown>> = [
      { title: hugeTitle },
      { title: hugeTitle },
    ];
    const comments: Array<Record<string, unknown>> = [
      {
        taskTitle: hugeTitle,
        parentTaskTitle: null,
        content: "Body",
        authorType: "human",
        authorId: "u1",
      },
    ];
    for (let i = 0; i < 8; i++) {
      const t = `DupTask-${i}`;
      dupTasks.push({ title: t }, { title: t });
      comments.push({
        taskTitle: t,
        parentTaskTitle: null,
        content: "Body",
        authorType: "human",
        authorId: "u1",
      });
    }

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/habitats/import",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        version: 2,
        exportedAt: EXPORTED_AT,
        habitat: {
          name: "Bounded Test",
          columns: [{ name: "Todo", order: 0, isTerminal: false }],
          missions: [
            {
              title: "DupMission",
              columnName: "Todo",
              tasks: dupTasks,
            },
            {
              title: "DupMission",
              columnName: "Todo",
              tasks: [],
            },
            {
              title: "SecretReferencingMission",
              columnName: "Todo",
              dependsOn: ["DupMission"],
              tasks: [],
            },
          ],
          comments,
        },
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("AMBIGUOUS_LEGACY_TITLE");
    expect(body.error.length).toBeLessThan(800);
    expect(body.error).not.toContain("\n");
    expect(body.details.totalAmbiguities).toBe(10);
    expect(body.details.truncated).toBe(true);
    expect(body.details.ambiguities.length).toBeLessThanOrEqual(5);
    const longTaskAmbiguity = (
      body.details.ambiguities as Array<{ kind: string; taskTitle?: string }>
    ).find((a) => a.kind === "duplicate_task_title_in_comment");
    expect(longTaskAmbiguity?.taskTitle).toBeDefined();
    expect(longTaskAmbiguity!.taskTitle!.length).toBeLessThanOrEqual(120);
    expect(longTaskAmbiguity!.taskTitle!.endsWith("...")).toBe(true);
    expect(JSON.stringify(body)).not.toContain("SecretReferencingMission");
  });

  it("enforces the 120-char cap including ellipsis and collapses C1/Unicode line separators", async () => {
    const userId = seedUser("admin");
    const token = signHumanToken(userId, "admin");
    const exact120 = "a".repeat(120);
    const over121 = `${"b".repeat(120)}c`;
    const controlTitle = "Alpha\u0085Beta\u2028Gamma\u2029Delta";

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/habitats/import",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        version: 2,
        exportedAt: EXPORTED_AT,
        habitat: {
          name: "Title Boundary Test",
          columns: [{ name: "Todo", order: 0, isTerminal: false }],
          missions: [
            {
              title: "M",
              columnName: "Todo",
              tasks: [
                { title: exact120 },
                { title: exact120 },
                { title: over121 },
                { title: over121 },
                { title: controlTitle },
                { title: controlTitle },
              ],
            },
          ],
          comments: [
            {
              taskTitle: exact120,
              parentTaskTitle: null,
              content: "c1",
              authorType: "human",
              authorId: "u1",
            },
            {
              taskTitle: over121,
              parentTaskTitle: null,
              content: "c2",
              authorType: "human",
              authorId: "u1",
            },
            {
              taskTitle: controlTitle,
              parentTaskTitle: null,
              content: "c3",
              authorType: "human",
              authorId: "u1",
            },
          ],
        },
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("AMBIGUOUS_LEGACY_TITLE");
    expect(body.details.ambiguities).toHaveLength(3);

    expect(body.details.ambiguities[0].taskTitle).toBe(exact120);
    expect(body.details.ambiguities[0].taskTitle).toHaveLength(120);
    expect(body.error).toContain(exact120);

    const truncatedPreview = body.details.ambiguities[1].taskTitle as string;
    expect(truncatedPreview).toHaveLength(120);
    expect(truncatedPreview).toBe(`${"b".repeat(117)}...`);
    expect(body.error).toContain(truncatedPreview);
    expect(body.error).not.toContain(`${"b".repeat(118)}...`);

    expect(body.details.ambiguities[2].taskTitle).toBe("Alpha Beta Gamma Delta");
    expect(body.error).toContain("Alpha Beta Gamma Delta");
    expect(body.error).not.toMatch(/[\u0085\u2028\u2029]/);
    expect(JSON.stringify(body)).not.toMatch(/[\u0085\u2028\u2029]/);
  });

  it("preserves unambiguous import on both new and replacement entry points", async () => {
    const memberId = seedUser("editor");
    const token = signHumanToken(memberId, "editor");
    const org = orgRepo.createOrganization({ name: "Org", slug: randomUUID() });
    const team = teamRepo.createTeam({
      organizationId: org.id,
      name: "Team",
      slug: randomUUID(),
    });
    memberRepo.addMember({ teamId: team.id, userId: memberId, role: "member" });
    const existing = habitatRepo.createHabitat({ name: "Control Target", teamId: team.id });
    columnRepo.createColumn({ habitatId: existing.id, name: "Todo", order: 0 });

    const newRes = await app.inject({
      method: "POST",
      url: "/api/v1/habitats/import",
      headers: { authorization: `Bearer ${token}` },
      payload: buildUnambiguousV2Artifact("Control New", "2026-11-28T12:00:00.000Z"),
    });
    expect(newRes.statusCode).toBe(201);
    const newBody = newRes.json();
    expect(newBody.outcome).toBe("published");
    expect(newBody.importedCounts.comments).toBe(1);
    const importedMissions = missionRepo.getMissionsByHabitatId(newBody.habitatId).missions;
    expect(importedMissions).toHaveLength(1);
    const importedTasks = taskRepo.getTasksByMissionId(importedMissions[0]!.id);
    expect(importedTasks.map((t) => t.title).toSorted()).toEqual([
      "Unique Task Alpha",
      "Unique Task Beta",
    ]);
    const importedComments = getDb()
      .select()
      .from(missionComments)
      .where(eq(missionComments.missionId, importedMissions[0]!.id))
      .all();
    expect(importedComments).toHaveLength(1);
    expect(importedComments[0]!.content).toBe("Pinned to Task Alpha");

    // Unambiguous v2 replacement (without tasks, respecting existing replacement policy) -> 201
    const replaceV2Res = await app.inject({
      method: "POST",
      url: `/api/v1/habitats/${existing.id}/import`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        version: 2,
        exportedAt: "2026-11-28T12:01:00.000Z",
        habitat: {
          name: "Control V2 Replaced",
          description: "Updated via v2",
          columns: [],
          missions: [],
          comments: [],
          templates: [],
          webhooks: [],
        },
      },
    });
    expect(replaceV2Res.statusCode).toBe(201);
    expect(replaceV2Res.json().outcome).toBe("published");
    expect(habitatRepo.getHabitatById(existing.id)!.name).toBe("Control V2 Replaced");

    // Unambiguous v3 replacement (full exported manifest) -> 201
    const v3Replacement = exportHabitatManifest(newBody.habitatId, { mode: "replacement" })!;
    const replaceV3Res = await app.inject({
      method: "POST",
      url: `/api/v1/habitats/${existing.id}/import`,
      headers: { authorization: `Bearer ${token}` },
      payload: v3Replacement,
    });
    expect(replaceV3Res.statusCode).toBe(201);
    expect(replaceV3Res.json().outcome).toBe("published");
    expect(habitatRepo.getHabitatById(existing.id)!.name).toBe("Control New");
  });

  it("preserves route admission (401/403/404) and unrelated 500 infrastructure errors", async () => {
    const memberId = seedUser("editor");
    const outsiderId = seedUser("editor");
    const memberToken = signHumanToken(memberId, "editor");
    const outsiderToken = signHumanToken(outsiderId, "editor");

    const org = orgRepo.createOrganization({ name: "Org", slug: randomUUID() });
    const team = teamRepo.createTeam({
      organizationId: org.id,
      name: "Team",
      slug: randomUUID(),
    });
    memberRepo.addMember({ teamId: team.id, userId: memberId, role: "member" });
    const target = habitatRepo.createHabitat({ name: "Guarded", teamId: team.id });

    const payload = buildUnambiguousV2Artifact();

    // Unauthenticated new & replacement -> 401
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/habitats/import", payload })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/habitats/${target.id}/import`,
          payload,
        })
      ).statusCode,
    ).toBe(401);

    // Unauthorized non-member -> 403
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/habitats/${target.id}/import`,
          headers: { authorization: `Bearer ${outsiderToken}` },
          payload,
        })
      ).statusCode,
    ).toBe(403);

    // Non-existent habitat -> 404
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/habitats/non-existent-id/import",
          headers: { authorization: `Bearer ${memberToken}` },
          payload,
        })
      ).statusCode,
    ).toBe(404);

    // Unrelated infrastructure failure -> 500 INTERNAL_ERROR (not swallowed)
    preflightSeam.throwInfraError = true;
    const infraRes = await app.inject({
      method: "POST",
      url: "/api/v1/habitats/import",
      headers: { authorization: `Bearer ${memberToken}` },
      payload,
    });
    expect(infraRes.statusCode).toBe(500);
    expect(infraRes.json()).toEqual({
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });
  });
});
