import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { habitatsApi } from "./habitats.js";
import { missionsApi } from "./missions.js";
import { columnsApi } from "./columns.js";
import type {
  HabitatExport,
  MissionWithProgress,
  Mission,
  Column,
  Task,
  MissionEvent,
} from "../../types/index.js";

// Contract proof: feed raw canonical server JSON through the real fetch-mocked
// transport and assert that the domain methods surface canonical
// { habitat, missions, mission, columns } vocabulary at every named boundary.
// Generic type assertions are deliberately avoided — the assertions exercise
// runtime values produced by the actual domain method, not the type system.

const TOKEN = "contract-jwt";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.setItem("orcy_token", TOKEN);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function jsonOk(body: unknown, status = 200) {
  return Promise.resolve({
    ok: true,
    status,
    statusText: "OK",
    json: () => Promise.resolve(body),
  });
}

const habitatDetailFixture = {
  habitat: {
    id: "h-1",
    name: "Canonical Habitat",
    description: "",
    teamId: null,
    retrySettings: null,
    anomalySettings: null,
    autoAssignSettings: null,
    codeReviewSettings: {
      hasGithubSecret: false,
      hasGitlabSecret: false,
      taskPattern: "",
      autoApproveOnMerge: false,
    },
    ciCdSettings: { hasGithubSecret: false, hasGitlabSecret: false, taskPattern: "" },
    gitWorktreeSettings: null,
    prioritizationSettings: null,
    automationSettings: null,
    wikiSettings: null,
    triageSettings: null,
    releaseSettings: null,
    roadmapSettings: null,
    eventRetentionDays: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  columns: [
    {
      id: "col-1",
      habitatId: "h-1",
      name: "Todo",
      order: 0,
      wipLimit: null,
      autoAdvance: false,
      requiresClaim: true,
      nextColumnId: "col-2",
      isTerminal: false,
    },
  ],
  missions: [
    {
      id: "m-1",
      habitatId: "h-1",
      columnId: "col-1",
      title: "Mission One",
      description: "",
      acceptanceCriteria: "",
      priority: "medium",
      labels: [],
      status: "not_started",
      displayOrder: 0,
      dependsOn: [],
      blocks: [],
      dueAt: null,
      slaMinutes: null,
      slaDeadlineAt: null,
      createdBy: "import",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      version: 1,
      actualMinutes: null,
      plannedMinutes: null,
      planningAccuracy: null,
      completedAt: null,
      isArchived: false,
      sprintId: null,
      releaseGateType: null,
      releaseGateVersion: null,
      releaseDeadlineType: null,
      releaseDeadlineVersion: null,
      progress: {
        total: 0,
        pending: 0,
        claimed: 0,
        inProgress: 0,
        submitted: 0,
        approved: 0,
        done: 0,
        failed: 0,
        rejected: 0,
        percentage: 0,
      },
    },
  ],
};

describe("Habitat domain contract — canonical JSON through real transport", () => {
  it("list() unwraps { habitats } and rejects legacy { boards }", async () => {
    fetchMock.mockReturnValue(jsonOk({ habitats: [habitatDetailFixture.habitat] }));
    const result = await habitatsApi.list();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("h-1");
    expect((result[0] as Record<string, unknown>).codeReviewSettings).toMatchObject({
      hasGithubSecret: false,
    });
  });

  it("get() returns { habitat, columns, missions } and exposes PublicHabitat masking", async () => {
    fetchMock.mockReturnValue(jsonOk(habitatDetailFixture));
    const result = await habitatsApi.get("h-1");
    expect(result.habitat.id).toBe("h-1");
    expect(result.columns).toHaveLength(1);
    expect(result.missions).toHaveLength(1);
    expect((result.missions[0] as MissionWithProgress).progress.total).toBe(0);
    expect((result.habitat as Record<string, unknown>).codeReviewSettings).toMatchObject({
      hasGithubSecret: false,
      hasGitlabSecret: false,
    });
    expect(
      (result.habitat as Record<string, unknown>).codeReviewSettings as Record<string, unknown>,
    ).not.toHaveProperty("githubSecret");
  });

  it("create() returns canonical { habitat, columns }", async () => {
    fetchMock.mockReturnValue(
      jsonOk({ habitat: habitatDetailFixture.habitat, columns: habitatDetailFixture.columns }),
    );
    const result = await habitatsApi.create({ name: "New" });
    expect(result.habitat.id).toBe("h-1");
    expect(result.columns).toHaveLength(1);
  });

  it("update() returns canonical { habitat }", async () => {
    fetchMock.mockReturnValue(jsonOk({ habitat: habitatDetailFixture.habitat }));
    const result = await habitatsApi.update("h-1", { name: "Renamed" });
    expect(result.habitat.id).toBe("h-1");
  });

  it("export() returns canonical portable { habitat: { missions, columns, ... } }", async () => {
    const exportFixture: HabitatExport = {
      version: 2,
      exportedAt: "2024-01-01T00:00:00.000Z",
      habitat: {
        name: "Portable",
        description: "",
        columns: [],
        missions: [],
        comments: [],
        templates: [],
        webhooks: [],
      },
    };
    fetchMock.mockReturnValue(jsonOk(exportFixture));
    const result = await habitatsApi.export("h-1");
    expect(result.version).toBe(2);
    expect(result.habitat.missions).toEqual([]);
    expect((result as unknown as Record<string, unknown>).board).toBeUndefined();
  });

  it("import() posts to canonical /habitats/import and returns { habitat, columns, imported.missions, warnings }", async () => {
    fetchMock.mockReturnValue(
      jsonOk({
        habitat: habitatDetailFixture.habitat,
        columns: habitatDetailFixture.columns,
        imported: { missions: 1, tasks: 0, comments: 0, templates: 0, webhooks: 0 },
        warnings: [],
      }),
    );
    const result = await habitatsApi.import({
      version: 2,
      exportedAt: "2024-01-01T00:00:00.000Z",
      habitat: {
        name: "X",
        description: "",
        columns: [],
        missions: [],
        comments: [],
        templates: [],
        webhooks: [],
      },
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/habitats/import");
    expect(result.habitat.id).toBe("h-1");
    expect(result.imported.missions).toBe(1);
    expect((result as unknown as Record<string, unknown>).board).toBeUndefined();
  });

  it("importInto() hits canonical route and returns canonical counters", async () => {
    fetchMock.mockReturnValue(
      jsonOk({
        habitat: habitatDetailFixture.habitat,
        columns: [],
        imported: { missions: 0, tasks: 0, comments: 0, templates: 0, webhooks: 0 },
        warnings: [],
      }),
    );
    const result = await habitatsApi.importInto("h-1", {
      version: 2,
      exportedAt: "2024-01-01T00:00:00.000Z",
      habitat: {
        name: "X",
        description: "",
        columns: [],
        missions: [],
        comments: [],
        templates: [],
        webhooks: [],
      },
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/habitats/h-1/import");
    expect(result.imported.missions).toBe(0);
  });
});

describe("Mission domain contract — canonical JSON through real transport", () => {
  it("list() unwraps { missions, total } (no legacy { features })", async () => {
    fetchMock.mockReturnValue(jsonOk({ missions: habitatDetailFixture.missions, total: 1 }));
    const result = await missionsApi.list("h-1");
    expect(result.missions).toHaveLength(1);
    expect(result.total).toBe(1);
    expect((result as Record<string, unknown>).features).toBeUndefined();
  });

  it("list() threads AbortSignal through to fetch", async () => {
    fetchMock.mockReturnValue(jsonOk({ missions: [], total: 0 }));
    const controller = new AbortController();
    await missionsApi.list("h-1", undefined, controller.signal);
    const opts = fetchMock.mock.calls[0][1] as RequestInit;
    expect(opts.signal).toBe(controller.signal);
  });

  it("get() returns canonical { mission }", async () => {
    fetchMock.mockReturnValue(jsonOk({ mission: habitatDetailFixture.missions[0] }));
    const result = await missionsApi.get("m-1");
    expect(result.mission.id).toBe("m-1");
    expect((result as Record<string, unknown>).feature).toBeUndefined();
  });

  it("details() returns canonical { mission, tasks, events, progress, dependencies }", async () => {
    const detailsFixture = {
      mission: habitatDetailFixture.missions[0],
      tasks: [] as Task[],
      events: [] as MissionEvent[],
      progress: { completed: 0, total: 0, percentage: 0, byStatus: {} },
      dependencies: { dependsOn: [] as string[], blocks: [] as string[] },
    };
    fetchMock.mockReturnValue(jsonOk(detailsFixture));
    const result = await missionsApi.details("m-1");
    expect(result.mission.id).toBe("m-1");
    expect((result as Record<string, unknown>).feature).toBeUndefined();
  });

  it("create() / update() / archive() / unarchive() return canonical { mission }", async () => {
    fetchMock.mockReturnValue(jsonOk({ mission: habitatDetailFixture.missions[0] }));
    const created = await missionsApi.create("h-1", {
      columnId: "col-1",
      title: "M",
    });
    expect((created as { mission: Mission }).mission.id).toBe("m-1");

    const updated = await missionsApi.update("m-1", { title: "M2" });
    expect((updated as { mission: Mission }).mission.id).toBe("m-1");

    const archived = await missionsApi.archive("m-1");
    expect((archived as { mission: Mission }).mission.id).toBe("m-1");

    const unarchived = await missionsApi.unarchive("m-1");
    expect((unarchived as { mission: Mission }).mission.id).toBe("m-1");
  });

  it("move() requires expectedVersion in the request body", async () => {
    fetchMock.mockReturnValue(jsonOk({ mission: habitatDetailFixture.missions[0] }));
    await missionsApi.move("m-1", { columnId: "col-2", expectedVersion: 3 });
    const opts = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({ columnId: "col-2", expectedVersion: 3 });
  });
});

describe("Column domain contract — atomic reorder", () => {
  it("reorder() posts expectedOrder/desiredOrder and unwraps { columns }", async () => {
    fetchMock.mockReturnValue(jsonOk({ columns: habitatDetailFixture.columns as Column[] }));
    const result = await columnsApi.reorder("h-1", {
      expectedOrder: ["col-1"],
      desiredOrder: ["col-1"],
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/habitats/h-1/columns/reorder");
    const opts = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(opts.body as string)).toEqual({
      expectedOrder: ["col-1"],
      desiredOrder: ["col-1"],
    });
    expect(result.columns).toHaveLength(1);
  });
});
