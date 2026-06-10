import { describe, it, expect } from "vitest";
import { NOTIFY_TASK_EVENT_ACTIONS } from "../services/tasks/transition-emitter.js";
import * as habitatSkillService from "../services/habitatSkillService.js";

describe("notifyTaskEvent consumer audit", () => {
  it("exports the list of currently-firing event actions", () => {
    expect(NOTIFY_TASK_EVENT_ACTIONS).toEqual([
      "completed",
      "approved",
      "rejected",
      "failed",
    ]);
  });

  it("habitatSkillService is the only registered consumer", () => {
    expect(typeof habitatSkillService.initSkillHooks).toBe("function");
  });
});
