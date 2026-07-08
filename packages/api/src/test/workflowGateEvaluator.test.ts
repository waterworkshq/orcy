import { describe, it, expect } from "vitest";
import {
  workflowGateEvaluator,
  actionToGateType,
} from "../services/workflow/workflowGateEvaluator.js";
import type {
  GateConditionChecker,
  GateEvaluationDecision,
} from "../services/workflow/workflowGateEvaluator.js";
import type { WorkflowGateRecord } from "../services/workflow/workflowGateStore.js";
import type { Pulse } from "../repositories/pulse.js";

const alwaysTrue: GateConditionChecker = () => true;
const alwaysFalse: GateConditionChecker = () => false;

function makeGate(overrides: Partial<WorkflowGateRecord> = {}): WorkflowGateRecord {
  return {
    id: "gate-1",
    workflowId: "wf-1",
    missionId: "m1",
    habitatId: "h1",
    upstreamTaskId: "task-up",
    downstreamTaskId: "task-down",
    gateType: "on_complete",
    satisfied: false,
    matchConfig: null,
    condition: null,
    recoveryTaskId: null,
    recoveryDepth: 0,
    ...overrides,
  };
}

function makePulse(overrides: Partial<Pulse> = {}): Pulse {
  return {
    id: "pulse-1",
    missionId: "m1",
    habitatId: "h1",
    scope: "mission",
    fromType: "system",
    fromId: "sys",
    toType: null,
    toId: null,
    signalType: "blocker",
    subject: "",
    body: "",
    taskId: "task-up",
    replyToId: null,
    linkedTaskId: null,
    metadata: {},
    createdAt: "2025-01-01T00:00:00Z",
    pinned: 0,
    isAuto: false,
    ...overrides,
  };
}

function satisfyDecisions(decisions: GateEvaluationDecision[]): WorkflowGateRecord[] {
  return decisions
    .filter((d): d is { status: "satisfy"; gate: WorkflowGateRecord } => d.status === "satisfy")
    .map((d) => d.gate);
}

function skipReasons(decisions: GateEvaluationDecision[]): string[] {
  return decisions
    .filter(
      (d): d is { status: "skip"; gate: WorkflowGateRecord; reason: string } => d.status === "skip",
    )
    .map((d) => d.reason);
}

describe("actionToGateType", () => {
  it("maps completed to on_complete", () => {
    expect(actionToGateType("completed")).toBe("on_complete");
  });

  it("maps approved to on_approve", () => {
    expect(actionToGateType("approved")).toBe("on_approve");
  });

  it("maps failed, rejected, released to on_fail", () => {
    expect(actionToGateType("failed")).toBe("on_fail");
    expect(actionToGateType("rejected")).toBe("on_fail");
    expect(actionToGateType("released")).toBe("on_fail");
  });

  it("returns null for mid-lifecycle actions", () => {
    for (const action of ["started", "submitted", "claimed", "created", "updated", "delegated"]) {
      expect(actionToGateType(action)).toBeNull();
    }
  });
});

describe("evaluateLifecycleTrigger", () => {
  const trigger = {
    taskId: "task-up",
    action: "completed",
    habitatId: "h1",
  };

  it("returns satisfy for matching unsatisfied gate", () => {
    const gates = [makeGate({ id: "g1", satisfied: false })];
    const decisions = workflowGateEvaluator.evaluateLifecycleTrigger(gates, trigger, alwaysTrue);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].status).toBe("satisfy");
  });

  it("returns skip(already_satisfied) for satisfied gate before condition evaluation", () => {
    const gates = [makeGate({ id: "g1", satisfied: true, condition: { type: "always" as const } })];
    const decisions = workflowGateEvaluator.evaluateLifecycleTrigger(gates, trigger, alwaysFalse);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].status).toBe("skip");
    if (decisions[0].status === "skip") expect(decisions[0].reason).toBe("already_satisfied");
  });

  it("returns skip(condition_false) when condition checker returns false", () => {
    const gates = [makeGate({ id: "g1", condition: { type: "always" as const } })];
    const decisions = workflowGateEvaluator.evaluateLifecycleTrigger(gates, trigger, alwaysFalse);
    expect(skipReasons(decisions)).toEqual(["condition_false"]);
  });

  it("returns satisfy when condition is null", () => {
    const gates = [makeGate({ id: "g1", condition: null })];
    const decisions = workflowGateEvaluator.evaluateLifecycleTrigger(gates, trigger, alwaysTrue);
    expect(satisfyDecisions(decisions)).toHaveLength(1);
  });

  it("catches condition checker errors as error decisions (per-gate isolation)", () => {
    const throwing: GateConditionChecker = () => {
      throw new Error("boom");
    };
    const gates = [
      makeGate({ id: "g1", condition: { type: "always" as const } }),
      makeGate({ id: "g2", condition: null }),
    ];
    const decisions = workflowGateEvaluator.evaluateLifecycleTrigger(gates, trigger, throwing);
    expect(decisions).toHaveLength(2);
    expect(decisions[0].status).toBe("error");
    expect(decisions[1].status).toBe("satisfy");
  });

  it("evaluates multiple gates independently", () => {
    const gates = [
      makeGate({ id: "g1", satisfied: true }),
      makeGate({ id: "g2", satisfied: false, condition: null }),
      makeGate({ id: "g3", satisfied: false, condition: { type: "always" as const } }),
    ];
    const decisions = workflowGateEvaluator.evaluateLifecycleTrigger(gates, trigger, alwaysFalse);
    expect(decisions.map((d) => d.status)).toEqual(["skip", "satisfy", "skip"]);
  });
});

describe("evaluatePulseTrigger", () => {
  it("returns satisfy when signalType matches", () => {
    const gates = [
      makeGate({
        id: "g1",
        gateType: "on_signal",
        matchConfig: { signalType: "blocker", matchScope: "task" },
      }),
    ];
    const pulse = makePulse({ signalType: "blocker", taskId: "task-up" });
    const decisions = workflowGateEvaluator.evaluatePulseTrigger(gates, pulse, alwaysTrue);
    expect(satisfyDecisions(decisions)).toHaveLength(1);
  });

  it("returns skip(signal_mismatch) when signalType does not match", () => {
    const gates = [
      makeGate({
        id: "g1",
        gateType: "on_signal",
        matchConfig: { signalType: "blocker", matchScope: "task" },
      }),
    ];
    const pulse = makePulse({ signalType: "finding", taskId: "task-up" });
    const decisions = workflowGateEvaluator.evaluatePulseTrigger(gates, pulse, alwaysTrue);
    expect(skipReasons(decisions)).toEqual(["signal_mismatch"]);
  });

  it("respects experience filter", () => {
    const gates = [
      makeGate({
        id: "g1",
        gateType: "on_signal",
        matchConfig: { signalType: "experience", experience: "stuck", matchScope: "task" },
      }),
    ];

    const decisionsNoMatch = workflowGateEvaluator.evaluatePulseTrigger(
      gates,
      makePulse({ signalType: "experience", metadata: { experience: "smooth" } }),
      alwaysTrue,
    );
    expect(satisfyDecisions(decisionsNoMatch)).toHaveLength(0);

    const decisionsMatch = workflowGateEvaluator.evaluatePulseTrigger(
      gates,
      makePulse({ signalType: "experience", metadata: { experience: "stuck" } }),
      alwaysTrue,
    );
    expect(satisfyDecisions(decisionsMatch)).toHaveLength(1);
  });

  it("subjectContains is case-insensitive", () => {
    const gates = [
      makeGate({
        id: "g1",
        gateType: "on_signal",
        matchConfig: {
          signalType: "warning",
          subjectContains: "DEPLOY FAILED",
          matchScope: "task",
        },
      }),
    ];
    const pulse = makePulse({ signalType: "warning", subject: "The deploy failed at step 3" });
    const decisions = workflowGateEvaluator.evaluatePulseTrigger(gates, pulse, alwaysTrue);
    expect(satisfyDecisions(decisions)).toHaveLength(1);
  });

  it("matchScope task requires pulse on upstream task", () => {
    const gates = [
      makeGate({
        id: "g1",
        gateType: "on_signal",
        matchConfig: { signalType: "blocker", matchScope: "task" },
      }),
    ];
    const sameTask = workflowGateEvaluator.evaluatePulseTrigger(
      gates,
      makePulse({ taskId: "task-up" }),
      alwaysTrue,
    );
    expect(satisfyDecisions(sameTask)).toHaveLength(1);

    const otherTask = workflowGateEvaluator.evaluatePulseTrigger(
      gates,
      makePulse({ taskId: "task-other" }),
      alwaysTrue,
    );
    expect(satisfyDecisions(otherTask)).toHaveLength(0);
  });

  it("matchScope mission accepts any pulse in same mission", () => {
    const gates = [
      makeGate({
        id: "g1",
        gateType: "on_signal",
        missionId: "m1",
        matchConfig: { signalType: "blocker", matchScope: "mission" },
      }),
    ];
    const pulse = makePulse({ taskId: "task-other", missionId: "m1" });
    const decisions = workflowGateEvaluator.evaluatePulseTrigger(gates, pulse, alwaysTrue);
    expect(satisfyDecisions(decisions)).toHaveLength(1);
  });

  it("matchScope either accepts upstream task or same mission", () => {
    const gates = [
      makeGate({
        id: "g1",
        gateType: "on_signal",
        missionId: "m1",
        matchConfig: { signalType: "blocker", matchScope: "either" },
      }),
    ];

    const onTask = workflowGateEvaluator.evaluatePulseTrigger(
      gates,
      makePulse({ taskId: "task-up", missionId: "m1" }),
      alwaysTrue,
    );
    expect(satisfyDecisions(onTask)).toHaveLength(1);

    const onMission = workflowGateEvaluator.evaluatePulseTrigger(
      gates,
      makePulse({ taskId: null, missionId: "m1" }),
      alwaysTrue,
    );
    expect(satisfyDecisions(onMission)).toHaveLength(1);

    const otherMission = workflowGateEvaluator.evaluatePulseTrigger(
      gates,
      makePulse({ taskId: null, missionId: "m-other" }),
      alwaysTrue,
    );
    expect(satisfyDecisions(otherMission)).toHaveLength(0);
  });

  it("returns skip(condition_false) when condition checker returns false", () => {
    const gates = [
      makeGate({
        id: "g1",
        gateType: "on_signal",
        matchConfig: { signalType: "blocker", matchScope: "task" },
        condition: { type: "always" as const },
      }),
    ];
    const pulse = makePulse({ signalType: "blocker", taskId: "task-up" });
    const decisions = workflowGateEvaluator.evaluatePulseTrigger(gates, pulse, alwaysFalse);
    expect(skipReasons(decisions)).toEqual(["condition_false"]);
  });

  it("returns skip(already_satisfied) for satisfied gate", () => {
    const gates = [
      makeGate({
        id: "g1",
        satisfied: true,
        gateType: "on_signal",
        matchConfig: { signalType: "blocker", matchScope: "task" },
      }),
    ];
    const pulse = makePulse({ signalType: "blocker", taskId: "task-up" });
    const decisions = workflowGateEvaluator.evaluatePulseTrigger(gates, pulse, alwaysFalse);
    expect(skipReasons(decisions)).toEqual(["already_satisfied"]);
  });

  it("returns skip(no_match_config) for null matchConfig", () => {
    const gates = [makeGate({ id: "g1", gateType: "on_signal", matchConfig: null })];
    const pulse = makePulse({ signalType: "blocker", taskId: "task-up" });
    const decisions = workflowGateEvaluator.evaluatePulseTrigger(gates, pulse, alwaysTrue);
    expect(skipReasons(decisions)).toEqual(["no_match_config"]);
  });
});

describe("evaluateAutomationTrigger", () => {
  const opts = {
    run: { id: "run-1", targetType: "task" as const, targetId: "task-up" },
    rule: { id: "rule-1" },
    outcome: "succeeded",
    habitatId: "h1",
  };

  it("has no condition checker parameter (2-parameter signature)", () => {
    expect(workflowGateEvaluator.evaluateAutomationTrigger.length).toBe(2);
  });

  it("returns satisfy when ruleId matches", () => {
    const gates = [
      makeGate({
        id: "g1",
        gateType: "on_automation",
        matchConfig: { ruleId: "rule-1", matchScope: "either" },
      }),
    ];
    const decisions = workflowGateEvaluator.evaluateAutomationTrigger(gates, opts);
    expect(satisfyDecisions(decisions)).toHaveLength(1);
  });

  it("returns skip(automation_mismatch) when ruleId does not match", () => {
    const gates = [
      makeGate({
        id: "g1",
        gateType: "on_automation",
        matchConfig: { ruleId: "rule-1", matchScope: "either" },
      }),
    ];
    const decisions = workflowGateEvaluator.evaluateAutomationTrigger(gates, {
      ...opts,
      rule: { id: "rule-different" },
    });
    expect(skipReasons(decisions)).toEqual(["automation_mismatch"]);
  });

  it("respects outcome filter", () => {
    const gates = [
      makeGate({
        id: "g1",
        gateType: "on_automation",
        matchConfig: { ruleId: "rule-1", outcome: "failed", matchScope: "either" },
      }),
    ];
    const decisions = workflowGateEvaluator.evaluateAutomationTrigger(gates, {
      ...opts,
      outcome: "succeeded",
    });
    expect(satisfyDecisions(decisions)).toHaveLength(0);
  });

  it("matchScope task requires run target to be upstream task", () => {
    const gates = [
      makeGate({
        id: "g1",
        gateType: "on_automation",
        matchConfig: { ruleId: "rule-1", matchScope: "task" },
      }),
    ];
    const match = workflowGateEvaluator.evaluateAutomationTrigger(gates, {
      ...opts,
      run: { id: "run-1", targetType: "task", targetId: "task-up" },
    });
    expect(satisfyDecisions(match)).toHaveLength(1);

    const noMatch = workflowGateEvaluator.evaluateAutomationTrigger(gates, {
      ...opts,
      run: { id: "run-1", targetType: "task", targetId: "task-other" },
    });
    expect(satisfyDecisions(noMatch)).toHaveLength(0);
  });

  it("matchScope mission requires run target to be gate's mission", () => {
    const gates = [
      makeGate({
        id: "g1",
        gateType: "on_automation",
        missionId: "m1",
        matchConfig: { ruleId: "rule-1", matchScope: "mission" },
      }),
    ];
    const match = workflowGateEvaluator.evaluateAutomationTrigger(gates, {
      ...opts,
      run: { id: "run-1", targetType: "mission", targetId: "m1" },
    });
    expect(satisfyDecisions(match)).toHaveLength(1);

    const noMatch = workflowGateEvaluator.evaluateAutomationTrigger(gates, {
      ...opts,
      run: { id: "run-1", targetType: "task", targetId: "task-up" },
    });
    expect(satisfyDecisions(noMatch)).toHaveLength(0);
  });

  it("returns skip(already_satisfied) for satisfied gate", () => {
    const gates = [
      makeGate({
        id: "g1",
        satisfied: true,
        gateType: "on_automation",
        matchConfig: { ruleId: "rule-1", matchScope: "either" },
      }),
    ];
    const decisions = workflowGateEvaluator.evaluateAutomationTrigger(gates, opts);
    expect(skipReasons(decisions)).toEqual(["already_satisfied"]);
  });

  it("returns skip(no_match_config) for null matchConfig", () => {
    const gates = [makeGate({ id: "g1", gateType: "on_automation", matchConfig: null })];
    const decisions = workflowGateEvaluator.evaluateAutomationTrigger(gates, opts);
    expect(skipReasons(decisions)).toEqual(["no_match_config"]);
  });
});
