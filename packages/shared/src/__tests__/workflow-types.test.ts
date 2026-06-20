import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  GateType,
  JoinMode,
  SignalMatch,
  AutomationMatch,
  ExperienceCategory,
  WorkflowFailureHandlerConfig,
  WorkflowTemplateDefinition,
  FailureBundle,
  AutomationCondition,
} from "../types/workflow.js";
import type { SignalType } from "../types/signal.js";

describe("workflow type definitions", () => {
  it("GateType includes all 6 gate types (on_automation deferred but typed)", () => {
    const gates: GateType[] = [
      "on_complete",
      "on_approve",
      "on_signal",
      "on_automation",
      "on_manual",
      "on_fail",
    ];
    expect(gates).toHaveLength(6);
  });

  it("JoinMode has exactly 3 modes", () => {
    const modes: JoinMode[] = ["all_of", "any_of", "n_of"];
    expect(modes).toHaveLength(3);
  });

  it("ExperienceCategory has exactly 7 categories", () => {
    const cats: ExperienceCategory[] = [
      "stuck",
      "confused",
      "backtrack",
      "surprised",
      "ambiguous",
      "sidetracked",
      "smooth",
    ];
    expect(cats).toHaveLength(7);
  });

  it("SignalMatch requires signalType and allows optional narrowing fields", () => {
    const minimal: SignalMatch = { signalType: "experience" };
    const full: SignalMatch = {
      signalType: "warning",
      experience: "stuck",
      subjectContains: "deploy",
      matchScope: "mission",
    };
    expect(minimal.signalType).toBe("experience");
    expect(full.matchScope).toBe("mission");
  });

  it("AutomationMatch requires ruleId", () => {
    const m: AutomationMatch = { ruleId: "rule-1", outcome: "succeeded", matchScope: "task" };
    expect(m.ruleId).toBe("rule-1");
  });

  it("WorkflowFailureHandlerConfig does NOT include excludeFailedAgent (dropped in v0.20)", () => {
    const config: WorkflowFailureHandlerConfig = {
      recoveryTaskTemplate: { title: "Recovery task" },
      agentSelector: {
        requiredCapabilities: ["debugging"],
        requiredDomain: "backend",
        assignedAgentId: "agent-1",
      },
    };
    expect(config).not.toHaveProperty("excludeFailedAgent");
  });

  it("WorkflowTemplateDefinition holds gates, joinSpecs, failureHandler, and variables", () => {
    const def: WorkflowTemplateDefinition = {
      gates: [
        {
          upstreamTaskKey: "task_1",
          downstreamTaskKey: "task_2",
          gateType: "on_approve",
        },
      ],
      joinSpecs: {
        task_2: { mode: "all_of" },
        task_3: { mode: "n_of", n: 2 },
      },
      failureHandler: {
        recoveryTaskTemplate: { title: "Investigate failure" },
      },
      variables: [{ key: "service", description: "Service name", default: "api" }],
    };
    expect(def.gates).toHaveLength(1);
    expect(def.joinSpecs?.["task_3"]?.n).toBe(2);
  });

  it("FailureBundle captures all expected snapshot sections", () => {
    const bundle: FailureBundle = {
      artifacts: [{ type: "pr", url: "https://example.com/pr/1", description: "Fix" }],
      recentLifecycleEvents: [
        { action: "failed", actorType: "agent", actorId: "a-1", timestamp: "2026-06-20T00:00:00Z" },
      ],
      experienceSignals: [
        {
          experience: "stuck",
          subject: "Blocked on API",
          taskId: "t-1",
          createdAt: "2026-06-20T00:00:00Z",
        },
      ],
      retryHistory: [
        { attemptNumber: 1, scheduledAt: "2026-06-20T00:00:00Z", executedAt: null, result: null },
      ],
      experienceCategorySummary: { stuck: 2, confused: 1 },
    };
    expect(bundle.artifacts).toHaveLength(1);
    expect(bundle.experienceCategorySummary.stuck).toBe(2);
  });

  it("re-exports AutomationCondition from v0.18 automation types", () => {
    const condition: AutomationCondition = { type: "always" };
    expectTypeOf(condition).toExtend<AutomationCondition>();
  });

  it("SignalMatch.signalType is compatible with the widened SignalType (includes experience)", () => {
    const sm: SignalMatch = { signalType: "experience" as SignalType };
    expect(sm.signalType).toBe("experience");
  });
});
