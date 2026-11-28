import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as skillRepo from "../repositories/habitatSkill.js";
import { initSkillHooks, normalize, regenerateSkill } from "../services/habitatSkillService.js";
import { rejectTask } from "../services/tasks/task-lifecycle.js";

describe("cross-mission skill evidence", () => {
  beforeEach(async () => { await initTestDb(); });
  afterEach(() => { closeDb(); });

  it("uses current distinct same-habitat task evidence on the next refresh", () => {
    initSkillHooks();
    const habitat = habitatRepo.createHabitat({ name: "Skill habitat" });
    const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo" });
    const mission = () => missionRepo.createMission({ habitatId: habitat.id, columnId: column.id, title: "Mission", createdBy: "test" });
    const first = mission();
    const second = mission();
    const otherHabitat = habitatRepo.createHabitat({ name: "Other habitat" });
    const otherColumn = columnRepo.createColumn({ habitatId: otherHabitat.id, name: "Todo" });
    const otherMission = missionRepo.createMission({ habitatId: otherHabitat.id, columnId: otherColumn.id, title: "Other", createdBy: "test" });
    const { agent } = agentRepo.createAgent({ name: "Worker", type: "codex", domain: "general" });
    const reject = (missionId: string, title: string) => {
      const task = taskRepo.createTask({ missionId, title, createdBy: "test" });
      expect(taskRepo.claimTask(task.id, agent.id)).toBeTruthy();
      expect(taskRepo.startTask(task.id, agent.id)).toBeTruthy();
      expect(taskRepo.submitTask(task.id, agent.id, "done", [])).toBeTruthy();
      expect(rejectTask(task.id, "reviewer", "needs work", "human")).toBeTruthy();
      return task;
    };
    const cross = [reject(first.id, "Cross"), reject(first.id, "Cross"), reject(second.id, "Cross")];
    const single = [reject(first.id, "Single"), reject(first.id, "Single"), reject(first.id, "Single")];
    const foreign = taskRepo.createTask({ missionId: otherMission.id, title: "Foreign", createdBy: "test" });
    const signal = (title: string) => skillRepo.findSignalByClusterKey(habitat.id, normalize(`Rejection: ${title}`))!;
    expect(signal("Cross")).toMatchObject({ frequency: 3, failedTasks: 3, crossMissionCount: 0, skillCategory: "pitfall" });
    expect(signal("Single")).toMatchObject({ frequency: 3, failedTasks: 3 });
    skillRepo.updateSignal(signal("Single").id, { sourceTaskIds: JSON.stringify([...single.map(t => t.id), single[0].id, "missing", foreign.id]) });

    regenerateSkill(habitat.id);
    expect(signal("Cross")).toMatchObject({ crossMissionCount: 2, skillCategory: "pitfall", frequency: 3, failedTasks: 3 });
    expect(signal("Single")).toMatchObject({ crossMissionCount: 1, skillCategory: "pitfall", frequency: 3, failedTasks: 3 });
    regenerateSkill(habitat.id);
    expect(signal("Cross")).toMatchObject({ crossMissionCount: 2, skillCategory: "pattern" });
    expect(signal("Single").skillCategory).toBe("pitfall");
    skillRepo.updateSignal(signal("Cross").id, { sourceTaskIds: JSON.stringify([cross[0].id, cross[0].id, "missing", foreign.id]) });
    regenerateSkill(habitat.id);
    expect(signal("Cross").crossMissionCount).toBe(1);
  });
});
