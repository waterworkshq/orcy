/**
 * Mission dependency read-guard SEAM tests (review finding on the mission
 * boundary PR) — the mission analogue of `taskDependencyGuardSeams.test.ts`.
 *
 * The guarded behaviors live BETWEEN two synchronous reads of one handler,
 * so the raw-inventory read is partially mocked (vi.mock on the repository
 * module; everything else — service joins, authorizeMissionAccessById,
 * error mapping — is real code) and each request goes through the real
 * application via app.inject.
 *
 *  1. persistent inventory/projection mismatch fails closed: 503 after
 *     exactly two inventories.
 *  2. a dangling endpoint id in the inventory (mission row deleted —
 *     `mission_id` has no FK, reachable by normal API use unlike the task
 *     tables) is SKIPPED, not 404'd: the read succeeds on one inventory and
 *     the projection is returned without the dangling id.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as dependencyRepo from "../repositories/dependency.js";
import * as agentRepo from "../repositories/agent.js";
import * as pluginManager from "../plugins/pluginManager.js";

const seam = vi.hoisted(() => ({
  edgeIdsCalls: 0,
  overrideEdgeIds: null as null | ((call: number) => { outgoing: string[]; incoming: string[] }),
}));

vi.mock("../repositories/dependency.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/dependency.js")>();
  return {
    ...actual,
    getMissionDependencyEdgeIds: (missionId: string) => {
      seam.edgeIdsCalls += 1;
      if (seam.overrideEdgeIds) return seam.overrideEdgeIds(seam.edgeIdsCalls);
      return actual.getMissionDependencyEdgeIds(missionId);
    },
  };
});

let app: HttpRuntimeHandle;
let personalHabitatId: string;
let agentKey: string;

let columnOrder = 0;
function makeMission(habitatId: string, title: string): string {
  const column = columnRepo.createColumn({
    habitatId,
    name: `mds-col-${title}-${++columnOrder}`,
    order: columnOrder,
    requiresClaim: false,
  });
  return missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title,
    createdBy: "mds-seed",
  }).id;
}

beforeAll(async () => {
  await initTestDb();
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();

  personalHabitatId = habitatRepo.createHabitat({ name: "mds-personal-habitat" }).id;
  agentKey = agentRepo.createAgent({
    name: "mds-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  }).plainApiKey;
}, 120_000);

afterEach(() => {
  seam.edgeIdsCalls = 0;
  seam.overrideEdgeIds = null;
});

afterAll(async () => {
  await app.close();
  closeDb();
});

describe("mission dependency read guards (SEAM — interleaved synchronous reads)", () => {
  it("persistent inventory/projection mismatch fails closed with 503 after exactly two inventories", async () => {
    const root = makeMission(personalHabitatId, "mds-stale-root");
    const dep = makeMission(personalHabitatId, "mds-stale-dep");
    const phantom = makeMission(personalHabitatId, "mds-stale-phantom");
    dependencyRepo.addMissionDependency(root, dep);

    // The inventory persistently reports an extra EXISTING endpoint the
    // joined projection never returns — every revalidation disagrees.
    seam.overrideEdgeIds = () => ({ outgoing: [dep, phantom], incoming: [] });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/missions/${root}/dependencies`,
      headers: { "x-agent-api-key": agentKey },
    });
    expect(res.statusCode).toBe(503);
    expect(seam.edgeIdsCalls).toBe(2);
  }, 30_000);

  it("a dangling endpoint id in the inventory is skipped, not 404'd — one inventory, projection returned", async () => {
    const root = makeMission(personalHabitatId, "mds-dangle-root");
    const dep = makeMission(personalHabitatId, "mds-dangle-dep");
    const danglingId = "00000000-0000-4000-8000-0000000000dd";
    dependencyRepo.addMissionDependency(root, dep);

    // The inventory reports an outgoing endpoint whose mission row does not
    // exist (the state a real source-mission deletion leaves behind). The
    // pre-fix implementation authorized it and the read died 404.
    seam.overrideEdgeIds = () => ({ outgoing: [dep, danglingId], incoming: [] });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/missions/${root}/dependencies`,
      headers: { "x-agent-api-key": agentKey },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dependsOn.map((row: { missionId: string }) => row.missionId)).toEqual([dep]);
    expect(body.blocking).toEqual([]);
    expect(String(res.body)).not.toContain(danglingId);
    expect(seam.edgeIdsCalls).toBe(1);
  }, 30_000);
});
