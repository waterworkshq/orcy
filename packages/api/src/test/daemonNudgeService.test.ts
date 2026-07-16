import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import * as daemonRepo from "../repositories/daemon.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as taskRepo from "../repositories/task.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import { habitats, columns, missions, tasks } from "../db/schema/index.js";
import {
  nudgeAllDaemons,
  resetDebounce,
  getLastNudgeTimes,
} from "../services/daemonNudgeService.js";

describe("daemonNudgeService", () => {
  beforeEach(async () => {
    await initTestDb();
    resetDebounce();
    const db = getDb();
    db.delete(tasks).run();
    db.delete(missions).run();
    db.delete(columns).run();
    db.delete(habitats).run();
  });

  afterEach(() => {
    closeDb();
  });

  it("returns empty when no online daemons exist", () => {
    const results = nudgeAllDaemons();
    expect(results).toEqual([]);
  });

  it("returns empty when daemons exist but no idle agents", () => {
    const daemon = daemonRepo.createDaemon({
      name: "test-daemon",
      hostname: "localhost",
      maxConcurrent: 4,
      daemonVersion: "1.0.0",
      plainToken: "daemon-test-token-000000000000000000000000000000000",
    });
    daemonRepo.setDaemonStatus(daemon.id, "online");

    const results = nudgeAllDaemons();
    expect(results).toEqual([]);
  });

  function setupHabitatWithPendingTask() {
    const habitat = habitatRepo.createHabitat({ name: "Test Habitat" });
    const col = columnRepo.createColumn({
      habitatId: habitat.id,
      name: "Todo",
      order: 0,
    });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: col.id,
      title: "Test Mission",
      createdBy: "test",
    });
    taskRepo.createTask({
      missionId: mission.id,
      title: "Pending task",
      priority: "high",
      createdBy: "test",
    });
    return { habitat, mission };
  }

  function setupDaemonWithIdleAgent(suffix: string) {
    const daemon = daemonRepo.createDaemon({
      name: `test-daemon-${suffix}`,
      hostname: "localhost",
      maxConcurrent: 4,
      daemonVersion: "1.0.0",
      plainToken: `daemon-test-token-${suffix}00000000000000000000000000`,
    });
    daemonRepo.setDaemonStatus(daemon.id, "online");

    const { agent } = agentRepo.createAgent({
      name: `daemon-test-${suffix}`,
      type: "claude-code",
      domain: "fullstack",
      capabilities: [],
    });

    daemonRepo.createDaemonAgent({
      daemonId: daemon.id,
      agentId: agent.id,
      cliType: "claude-code",
      cliVersion: null,
      cliPath: "/usr/bin/claude",
    });
    const da = daemonRepo.getDaemonAgentByAgentId(agent.id)!;
    daemonRepo.updateDaemonAgentStatus(da.id, "idle");

    return { daemon, agentId: agent.id };
  }

  it("emits a directive pulse when idle agents and pending tasks exist", () => {
    const { habitat } = setupHabitatWithPendingTask();
    setupDaemonWithIdleAgent("01");

    const results = nudgeAllDaemons();

    const hr = results.find((r: any) => r.habitatId === habitat.id);
    expect(hr).toBeDefined();
    expect(hr!.pulseId).toBeTruthy();
    expect(hr!.reason).toBe("nudged");
  });

  it("skips habitats with no pending tasks", () => {
    const habitat = habitatRepo.createHabitat({ name: "Empty Habitat" });
    setupDaemonWithIdleAgent("02");

    const results = nudgeAllDaemons();

    const hr = results.find((r: any) => r.habitatId === habitat.id);
    expect(hr).toBeDefined();
    expect(hr!.pulseId).toBeNull();
    expect(hr!.reason).toBe("no pending tasks");
  });

  it("debounces repeated nudges for the same habitat", () => {
    const { habitat } = setupHabitatWithPendingTask();
    setupDaemonWithIdleAgent("03");

    const first = nudgeAllDaemons();
    const hr1 = first.find((r: any) => r.habitatId === habitat.id);
    expect(hr1!.pulseId).toBeTruthy();

    const second = nudgeAllDaemons();
    const hr2 = second.find((r: any) => r.habitatId === habitat.id);
    expect(hr2!.pulseId).toBeNull();
    expect(hr2!.reason).toBe("debounced");
  });

  it("allows nudge after debounce window expires", () => {
    const { habitat } = setupHabitatWithPendingTask();
    setupDaemonWithIdleAgent("04");

    nudgeAllDaemons();
    const times = getLastNudgeTimes() as Map<string, number>;
    times.set(habitat.id, Date.now() - 6 * 60 * 1000);

    const second = nudgeAllDaemons();
    const hr = second.find((r: any) => r.habitatId === habitat.id);
    expect(hr!.pulseId).toBeTruthy();
    expect(hr!.reason).toBe("nudged");
  });

  it("created pulse has correct shape", () => {
    const { habitat } = setupHabitatWithPendingTask();
    setupDaemonWithIdleAgent("05");

    const results = nudgeAllDaemons();
    const hr = results.find((r: any) => r.habitatId === habitat.id);
    const pulse = pulseRepo.getPulseById(hr!.pulseId!);

    expect(pulse).toBeDefined();
    expect(pulse!.scope).toBe("habitat");
    expect(pulse!.subject).toContain("pending task");
    expect((pulse!.metadata as any).nudgeType).toBe("idle_check");
  });

  it("resetDebounce clears specific habitat", () => {
    const { habitat } = setupHabitatWithPendingTask();
    setupDaemonWithIdleAgent("06");

    nudgeAllDaemons();
    resetDebounce(habitat.id);

    const second = nudgeAllDaemons();
    const hr = second.find((r: any) => r.habitatId === habitat.id);
    expect(hr!.reason).toBe("nudged");
  });
});
