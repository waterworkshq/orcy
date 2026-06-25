import { describe, it, expect, beforeEach } from "vitest";
import { pulsePost, EXPERIENCE_CATEGORIES } from "../../tools/pulse.js";
import { PULSE_DISPATCH_TOOL, PULSE_ACTIONS } from "../../tools/pulse-dispatch.js";
import {
  PULSE_SKILL_TEXT,
  PULSE_SKILL_TOOL,
  orcyPulseInstructions,
} from "../../tools/pulse-skill.js";
import { createMockClient } from "../__fixtures__/mock-client.js";

describe("pulsePost — experience signalType", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
    client.postPulse.mockResolvedValue({ pulse: { id: "pulse-1" } });
    client.postHabitatPulse.mockResolvedValue({ pulse: { id: "pulse-h-1" } });
  });

  it("throws when signalType=experience but experience param missing", async () => {
    await expect(
      pulsePost(client, {
        missionId: "m-1",
        signalType: "experience",
        subject: "hit a wall",
      }),
    ).rejects.toThrow(/experience is required/i);
    expect(client.postPulse).not.toHaveBeenCalled();
  });

  it("posts experience signal with auto-stamped metadata (mission scope, mid_task)", async () => {
    await pulsePost(client, {
      missionId: "m-1",
      taskId: "t-1",
      signalType: "experience",
      experience: "stuck",
      subject: "Hit unexpected API rate limit after 5 retries",
    });

    expect(client.postPulse).toHaveBeenCalledTimes(1);
    const call = client.postPulse.mock.calls[0];
    expect(call[0]).toBe("m-1");
    expect(call[1].signalType).toBe("experience");
    expect(call[1].metadata).toMatchObject({
      implicit: true,
      experience: "stuck",
      timing: "mid_task",
    });
  });

  it("stamps timing=completion when task status is submitted", async () => {
    client.getTask.mockResolvedValue({ task: { id: "t-1", status: "submitted" } });

    await pulsePost(client, {
      missionId: "m-1",
      taskId: "t-1",
      signalType: "experience",
      experience: "smooth",
      subject: "Feature implemented in one pass",
    });

    expect(client.postPulse.mock.calls[0][1].metadata).toMatchObject({
      timing: "completion",
      experience: "smooth",
    });
    expect(client.getTask).toHaveBeenCalledWith("t-1");
  });

  it("stamps timing=mid_task when task status is in_progress", async () => {
    client.getTask.mockResolvedValue({ task: { id: "t-1", status: "in_progress" } });

    await pulsePost(client, {
      missionId: "m-1",
      taskId: "t-1",
      signalType: "experience",
      experience: "confused",
      subject: "Requirements mention deploy but no env configured",
    });

    expect(client.postPulse.mock.calls[0][1].metadata.timing).toBe("mid_task");
  });

  it("defaults timing to mid_task when no taskId provided", async () => {
    await pulsePost(client, {
      missionId: "m-1",
      signalType: "experience",
      experience: "surprised",
      subject: "Local tests passed, CI failed",
    });

    expect(client.getTask).not.toHaveBeenCalled();
    expect(client.postPulse.mock.calls[0][1].metadata.timing).toBe("mid_task");
  });

  it("defaults timing to mid_task when task lookup throws", async () => {
    client.getTask.mockRejectedValue(new Error("network failure"));

    await pulsePost(client, {
      missionId: "m-1",
      taskId: "t-missing",
      signalType: "experience",
      experience: "ambiguous",
      subject: "Task says improve performance, no metric",
    });

    expect(client.getTask).toHaveBeenCalledWith("t-missing");
    expect(client.postPulse.mock.calls[0][1].metadata.timing).toBe("mid_task");
  });

  it("stamps metadata on habitat-scoped experience signals", async () => {
    await pulsePost(client, {
      boardId: "b-1",
      scope: "habitat",
      signalType: "experience",
      experience: "backtrack",
      subject: "Restarted with GraphQL after REST attempt",
    });

    expect(client.postHabitatPulse).toHaveBeenCalledTimes(1);
    expect(client.postPulse).not.toHaveBeenCalled();
    const call = client.postHabitatPulse.mock.calls[0];
    expect(call[0]).toBe("b-1");
    expect(call[1].metadata).toMatchObject({
      implicit: true,
      experience: "backtrack",
      timing: "mid_task",
    });
  });

  it("preserves user-supplied metadata alongside auto-stamps", async () => {
    await pulsePost(client, {
      missionId: "m-1",
      signalType: "experience",
      experience: "sidetracked",
      subject: "Found unrelated bug, refocused",
      metadata: { customTag: "auth-module", note: "follow up later" },
    });

    const meta = client.postPulse.mock.calls[0][1].metadata;
    expect(meta).toMatchObject({
      customTag: "auth-module",
      note: "follow up later",
      implicit: true,
      experience: "sidetracked",
      timing: "mid_task",
    });
  });

  it("does not stamp metadata for non-experience signalTypes", async () => {
    await pulsePost(client, {
      missionId: "m-1",
      signalType: "finding",
      subject: "Token format changed to JWT v3",
      metadata: { kept: "as-is" },
    });

    expect(client.postPulse.mock.calls[0][1].metadata).toEqual({ kept: "as-is" });
  });

  it("accepts complete structured finding metadata", async () => {
    await pulsePost(client, {
      missionId: "m-1",
      signalType: "finding",
      subject: "Pre-existing auth bug",
      metadata: {
        findingKind: "pre_existing_bug",
        severity: "high",
        affectedFiles: ["packages/api/src/auth/token.ts"],
        blocksCurrentWork: false,
      },
    });

    expect(client.postPulse).toHaveBeenCalledTimes(1);
  });

  it("rejects partial structured finding metadata before posting", async () => {
    await expect(
      pulsePost(client, {
        missionId: "m-1",
        signalType: "finding",
        subject: "Partial finding",
        metadata: { findingKind: "pre_existing_bug" },
      }),
    ).rejects.toThrow(/severity.*affectedFiles.*blocksCurrentWork/);
    expect(client.postPulse).not.toHaveBeenCalled();
  });

  it("accepts free-form finding metadata", async () => {
    await pulsePost(client, {
      missionId: "m-1",
      signalType: "finding",
      subject: "Free-form finding",
      metadata: { kept: "as-is" },
    });

    expect(client.postPulse.mock.calls[0][1].metadata).toEqual({ kept: "as-is" });
  });

  it("rejects invalid structured finding enum values before posting", async () => {
    await expect(
      pulsePost(client, {
        missionId: "m-1",
        signalType: "finding",
        subject: "Invalid finding",
        metadata: {
          findingKind: "typo",
          severity: "high",
          affectedFiles: ["packages/api/src/auth/token.ts"],
          blocksCurrentWork: false,
        },
      }),
    ).rejects.toThrow(/findingKind must be one of/);
    expect(client.postPulse).not.toHaveBeenCalled();
  });

  it("existing non-experience signalTypes still post without metadata injection", async () => {
    await pulsePost(client, {
      missionId: "m-1",
      signalType: "blocker",
      subject: "Missing REDIS_URL",
      body: "session cache cannot initialize",
    });

    expect(client.postPulse).toHaveBeenCalledTimes(1);
    expect(client.postPulse.mock.calls[0][1].signalType).toBe("blocker");
    expect(client.postPulse.mock.calls[0][1].metadata).toBeUndefined();
  });

  it("EXPERIENCE_CATEGORIES const contains all 7 categories", () => {
    expect([...EXPERIENCE_CATEGORIES]).toEqual([
      "stuck",
      "confused",
      "backtrack",
      "surprised",
      "ambiguous",
      "sidetracked",
      "smooth",
    ]);
  });
});

describe("pulse-dispatch — experience wiring", () => {
  it("PULSE_DISPATCH_TOOL schema includes 'experience' in signalType enum", () => {
    const signalTypeParam = PULSE_DISPATCH_TOOL.inputSchema!.properties!.signalType as {
      enum?: string[];
    };
    expect(signalTypeParam.enum).toContain("experience");
  });

  it("PULSE_DISPATCH_TOOL exposes experience param with 7 categories", () => {
    const experienceParam = PULSE_DISPATCH_TOOL.inputSchema!.properties!.experience as {
      enum?: string[];
      type?: string;
    };
    expect(experienceParam.type).toBe("string");
    expect(experienceParam.enum).toEqual([
      "stuck",
      "confused",
      "backtrack",
      "surprised",
      "ambiguous",
      "sidetracked",
      "smooth",
    ]);
  });

  it("PULSE_DISPATCH_TOOL description mentions self-reporting", () => {
    expect(PULSE_DISPATCH_TOOL.description).toMatch(/experience/i);
    expect(PULSE_DISPATCH_TOOL.description).toMatch(/self-report/i);
  });

  it("PULSE_ACTIONS still maps the four base actions", () => {
    expect(Object.keys(PULSE_ACTIONS).toSorted()).toEqual(["check", "post", "promote", "react"]);
  });
});

describe("pulse-skill — Self-Reporting section", () => {
  it("PULSE_SKILL_TEXT contains a Self-Reporting section header", () => {
    expect(PULSE_SKILL_TEXT).toMatch(/## Self-Reporting/i);
  });

  it("PULSE_SKILL_TEXT lists all 7 experience categories", () => {
    for (const category of [
      "stuck",
      "confused",
      "backtrack",
      "surprised",
      "ambiguous",
      "sidetracked",
      "smooth",
    ]) {
      expect(PULSE_SKILL_TEXT).toContain(category);
    }
  });

  it("PULSE_SKILL_TEXT includes the signalType=experience post example", () => {
    expect(PULSE_SKILL_TEXT).toMatch(/signalType:\s*['"]experience['"]/);
    expect(PULSE_SKILL_TEXT).toMatch(/experience:\s*['"]stuck['"]/);
  });

  it("PULSE_SKILL_TEXT documents the auto-stamped metadata fields", () => {
    expect(PULSE_SKILL_TEXT).toMatch(/metadata\.implicit=true/i);
    expect(PULSE_SKILL_TEXT).toMatch(/metadata\.experience/i);
    expect(PULSE_SKILL_TEXT).toMatch(/metadata\.timing/i);
  });

  it("PULSE_SKILL_TEXT explains what NOT to post as experience signals", () => {
    expect(PULSE_SKILL_TEXT).toMatch(/lifecycle events that auto-emit/i);
    expect(PULSE_SKILL_TEXT).toMatch(/signalType='blocker'/i);
  });

  it("PULSE_SKILL_TOOL description mentions self-reporting", () => {
    expect(PULSE_SKILL_TOOL.description).toMatch(/self-report/i);
  });

  it("orcyPulseInstructions returns the rendered text including the new section", () => {
    const rendered = orcyPulseInstructions();
    expect(rendered).toMatch(/## Self-Reporting/i);
    expect(rendered).toBe(PULSE_SKILL_TEXT);
  });
});
