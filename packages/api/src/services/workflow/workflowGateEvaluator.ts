import type { Pulse } from "../../repositories/pulse.js";
import type { SignalMatch, AutomationMatch, AutomationCondition } from "../../models/index.js";
import type { WorkflowGateRecord } from "./workflowGateStore.js";

type LifecycleGateType = "on_complete" | "on_approve" | "on_fail";

export type ConditionTrigger = {
  habitatId: string;
  targetType: "task" | "mission" | "agent" | "sprint" | "habitat" | "none";
  targetId: string | null;
  eventId?: string | null;
  payload?: Record<string, unknown>;
};

export type GateConditionChecker = (
  condition: AutomationCondition,
  trigger: ConditionTrigger,
) => boolean;

export type GateEvaluationDecision =
  | { status: "satisfy"; gate: WorkflowGateRecord }
  | { status: "skip"; gate: WorkflowGateRecord; reason: string }
  | { status: "error"; gate: WorkflowGateRecord; error: unknown };

export function actionToGateType(action: string): LifecycleGateType | null {
  switch (action) {
    case "completed":
      return "on_complete";
    case "approved":
      return "on_approve";
    case "failed":
    case "rejected":
    case "released":
      return "on_fail";
    default:
      return null;
  }
}

function readSignalMatch(raw: Record<string, unknown> | null | undefined): SignalMatch | null {
  if (!raw) return null;
  if (typeof raw["signalType"] !== "string") return null;
  return {
    signalType: raw["signalType"] as SignalMatch["signalType"],
    experience: raw["experience"] as SignalMatch["experience"],
    subjectContains: raw["subjectContains"] as SignalMatch["subjectContains"],
    matchScope: raw["matchScope"] as SignalMatch["matchScope"],
  };
}

function signalMatchEqualsPulse(
  match: SignalMatch,
  pulse: Pulse,
  gate: { upstreamTaskId: string; missionId: string },
): boolean {
  if (match.signalType !== pulse.signalType) return false;

  if (match.experience !== undefined) {
    if (pulse.metadata?.["experience"] !== match.experience) return false;
  }

  if (match.subjectContains !== undefined) {
    const subject = pulse.subject.toLowerCase();
    const needle = match.subjectContains.toLowerCase();
    if (!subject.includes(needle)) return false;
  }

  const scope = match.matchScope ?? "task";
  return pulseMatchesScope(pulse, gate, scope);
}

function pulseMatchesScope(
  pulse: Pulse,
  gate: { upstreamTaskId: string; missionId: string },
  scope: "task" | "mission" | "either",
): boolean {
  switch (scope) {
    case "task":
      return pulse.taskId === gate.upstreamTaskId;
    case "mission":
      return pulse.missionId !== null && pulse.missionId === gate.missionId;
    case "either":
      return (
        pulse.taskId === gate.upstreamTaskId ||
        (pulse.missionId !== null && pulse.missionId === gate.missionId)
      );
  }
}

function readAutomationMatch(
  raw: Record<string, unknown> | null | undefined,
): AutomationMatch | null {
  if (!raw) return null;
  if (typeof raw["ruleId"] !== "string") return null;
  return {
    ruleId: raw["ruleId"],
    outcome: raw["outcome"] as AutomationMatch["outcome"],
    matchScope: raw["matchScope"] as AutomationMatch["matchScope"],
  };
}

function automationMatchEqualsRun(
  match: AutomationMatch,
  opts: {
    run: { targetType: string | null; targetId: string | null };
    rule: { id: string };
    outcome: string;
  },
  gate: { upstreamTaskId: string; missionId: string },
): boolean {
  if (match.ruleId !== opts.rule.id) return false;

  if (match.outcome !== undefined) {
    if (match.outcome === "skipped" && opts.outcome !== "skipped") return false;
    if (match.outcome === "succeeded" && opts.outcome !== "succeeded") return false;
    if (match.outcome === "failed" && opts.outcome !== "failed") return false;
  }

  const scope = match.matchScope ?? "either";
  const runTargetId = opts.run.targetId;
  if (scope === "task") {
    return runTargetId === gate.upstreamTaskId;
  }
  if (scope === "mission") {
    return runTargetId === gate.missionId;
  }
  return true;
}

export const workflowGateEvaluator = {
  actionToGateType,

  evaluateLifecycleTrigger(
    gates: WorkflowGateRecord[],
    trigger: {
      taskId: string;
      action: string;
      habitatId: string;
      actorType?: string;
      actorId?: string;
      oldStatus?: string;
      newStatus?: string;
      metadata?: Record<string, unknown>;
    },
    conditionChecker: GateConditionChecker,
  ): GateEvaluationDecision[] {
    const decisions: GateEvaluationDecision[] = [];
    for (const gate of gates) {
      if (gate.satisfied) {
        decisions.push({ status: "skip", gate, reason: "already_satisfied" });
        continue;
      }
      try {
        if (
          gate.condition &&
          !conditionChecker(gate.condition, {
            habitatId: trigger.habitatId,
            targetType: "task",
            targetId: trigger.taskId,
            payload: {
              action: trigger.action,
              actorType: trigger.actorType,
              actorId: trigger.actorId,
              oldStatus: trigger.oldStatus,
              newStatus: trigger.newStatus,
              metadata: trigger.metadata,
            },
          })
        ) {
          decisions.push({ status: "skip", gate, reason: "condition_false" });
          continue;
        }
        decisions.push({ status: "satisfy", gate });
      } catch (err) {
        decisions.push({ status: "error", gate, error: err });
      }
    }
    return decisions;
  },

  evaluatePulseTrigger(
    gates: WorkflowGateRecord[],
    pulse: Pulse,
    conditionChecker: GateConditionChecker,
  ): GateEvaluationDecision[] {
    const decisions: GateEvaluationDecision[] = [];
    for (const gate of gates) {
      if (gate.satisfied) {
        decisions.push({ status: "skip", gate, reason: "already_satisfied" });
        continue;
      }
      try {
        const match = readSignalMatch(gate.matchConfig);
        if (!match) {
          decisions.push({ status: "skip", gate, reason: "no_match_config" });
          continue;
        }
        if (!signalMatchEqualsPulse(match, pulse, gate)) {
          decisions.push({ status: "skip", gate, reason: "signal_mismatch" });
          continue;
        }
        if (
          gate.condition &&
          !conditionChecker(gate.condition, {
            habitatId: pulse.habitatId,
            targetType: pulse.taskId ? "task" : pulse.missionId ? "mission" : "none",
            targetId: pulse.taskId ?? pulse.missionId,
            eventId: pulse.id,
            payload: {
              signalType: pulse.signalType,
              subject: pulse.subject,
              metadata: pulse.metadata,
            },
          })
        ) {
          decisions.push({ status: "skip", gate, reason: "condition_false" });
          continue;
        }
        decisions.push({ status: "satisfy", gate });
      } catch (err) {
        decisions.push({ status: "error", gate, error: err });
      }
    }
    return decisions;
  },

  evaluateAutomationTrigger(
    gates: WorkflowGateRecord[],
    opts: {
      run: { id: string; targetType: string | null; targetId: string | null };
      rule: { id: string };
      outcome: string;
      habitatId: string;
    },
  ): GateEvaluationDecision[] {
    const decisions: GateEvaluationDecision[] = [];
    for (const gate of gates) {
      if (gate.satisfied) {
        decisions.push({ status: "skip", gate, reason: "already_satisfied" });
        continue;
      }
      try {
        const match = readAutomationMatch(gate.matchConfig);
        if (!match) {
          decisions.push({ status: "skip", gate, reason: "no_match_config" });
          continue;
        }
        if (!automationMatchEqualsRun(match, opts, gate)) {
          decisions.push({ status: "skip", gate, reason: "automation_mismatch" });
          continue;
        }
        decisions.push({ status: "satisfy", gate });
      } catch (err) {
        decisions.push({ status: "error", gate, error: err });
      }
    }
    return decisions;
  },
};
