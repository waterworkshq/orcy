import { describe, it, expect } from "vitest";
import * as mission from "../../tools/mission.js";
import { MISSION_DISPATCH_TOOL, MISSION_ACTIONS } from "../../tools/mission-dispatch.js";

describe("MISSION_DISPATCH_TOOL", () => {
  it("has the correct name", () => {
    expect(MISSION_DISPATCH_TOOL.name).toBe("orcy_habitat_mission");
  });

  it("includes all 11 actions in the enum", () => {
    const actionProp = MISSION_DISPATCH_TOOL.inputSchema.properties.action as {
      enum?: string[];
    };
    expect(actionProp.enum).toEqual([
      "list",
      "create",
      "delete",
      "archive",
      "unarchive",
      "get-context",
      "get-comments",
      "add-comment",
      "link-code",
      "list-code-evidence",
      "correct-code-evidence-link",
    ]);
  });

  it("requires action", () => {
    expect(MISSION_DISPATCH_TOOL.inputSchema.required).toContain("action");
  });
});

describe("MISSION_ACTIONS", () => {
  it("routes list to habitatListMissions", () => {
    expect(MISSION_ACTIONS["list"]).toBe(mission.habitatListMissions);
  });

  it("routes create to habitatCreateMission", () => {
    expect(MISSION_ACTIONS["create"]).toBe(mission.habitatCreateMission);
  });

  it("routes delete to habitatDeleteMission", () => {
    expect(MISSION_ACTIONS["delete"]).toBe(mission.habitatDeleteMission);
  });

  it("routes archive to missionArchive", () => {
    expect(MISSION_ACTIONS["archive"]).toBe(mission.missionArchive);
  });

  it("routes unarchive to missionUnarchive", () => {
    expect(MISSION_ACTIONS["unarchive"]).toBe(mission.missionUnarchive);
  });

  it("routes get-context to missionGetContext", () => {
    expect(MISSION_ACTIONS["get-context"]).toBe(mission.missionGetContext);
  });

  it("has exactly 11 actions", () => {
    expect(Object.keys(MISSION_ACTIONS)).toHaveLength(11);
  });

  it("every action maps to a function", () => {
    for (const handler of Object.values(MISSION_ACTIONS)) {
      expect(typeof handler).toBe("function");
    }
  });
});
