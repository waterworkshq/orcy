import type { Artifact } from "./task.js";
import type { TaskTemplateEntry } from "./feature.js";
import type { SignalType } from "./signal.js";
import type { AutomationCondition } from "./automation.js";

export type { AutomationCondition };

/** The six typed dependency edges between tasks in a workflow DAG; `on_automation` is deferred to v0.20.x. */
export type GateType =
  | "on_complete"
  | "on_approve"
  | "on_signal"
  | "on_automation"
  | "on_manual"
  | "on_fail";

/** How multiple upstream gates combine for a single downstream task. */
export type JoinMode = "all_of" | "any_of" | "n_of";

/** Match configuration for `on_signal` gates, narrowing which pulses satisfy the gate. */
export type SignalMatch = {
  signalType: SignalType;
  experience?: ExperienceCategory;
  subjectContains?: string;
  matchScope?: "task" | "mission" | "either";
};

/** Match configuration for `on_automation` gates, narrowing which automation run outcomes satisfy the gate. */
export type AutomationMatch = {
  ruleId: string;
  outcome?: "succeeded" | "failed" | "skipped";
  matchScope?: "task" | "mission" | "either";
};

/** The seven self-reporting categories an agent uses to classify its experience on a task. */
export type ExperienceCategory =
  | "stuck"
  | "confused"
  | "backtrack"
  | "surprised"
  | "ambiguous"
  | "sidetracked"
  | "smooth";

/** Recovery handler config attached to a workflow or overridden per task, controlling how `on_fail` gates spawn recovery tasks. */
export type WorkflowFailureHandlerConfig = {
  recoveryTaskTemplate: TaskTemplateEntry;
  agentSelector?: {
    requiredCapabilities?: string[];
    requiredDomain?: string | null;
    assignedAgentId?: string;
  };
};

/** A typed dependency edge in a workflow template, resolved to task keys at authoring time and to task IDs at instantiation. */
export type WorkflowTemplateGate = {
  upstreamTaskKey: string;
  downstreamTaskKey: string;
  gateType: GateType;
  matchConfig?: SignalMatch | AutomationMatch;
  condition?: AutomationCondition | null;
};

/** A variable placeholder resolved at template instantiation time via simple `{{key}}` substitution. */
export type WorkflowTemplateVariable = {
  key: string;
  description: string;
  default?: string;
  required?: boolean;
};

/** Author-time definition of a workflow DAG, stored in `missionTemplates.workflowTemplate` and instantiated by `applyTemplate`. */
export type WorkflowTemplateDefinition = {
  gates: WorkflowTemplateGate[];
  joinSpecs?: Record<string, { mode: JoinMode; n?: number }>;
  failureHandler?: WorkflowFailureHandlerConfig;
  variables?: WorkflowTemplateVariable[];
};

/** Trimmed view of a `TaskEvent` captured in a `FailureBundle` for recovery consumption. */
export interface TaskEventSnapshot {
  action: string;
  actorType: string;
  actorId: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/** Trimmed view of an experience pulse captured in a `FailureBundle`, highlighting the diagnostic category. */
export interface ExperienceSignalSnapshot {
  experience: ExperienceCategory;
  subject: string;
  taskId: string | null;
  createdAt: string;
}

/** Summary of one prior retry attempt on a failed task, captured for recovery context. */
export interface RetryAttemptSnapshot {
  attemptNumber: number;
  scheduledAt: string;
  executedAt: string | null;
  result: "succeeded" | "failed" | "pending" | null;
}

/** Structured bundle persisted in `failureContexts.bundle`, assembled by `failureContextService` for recovery agents. */
export type FailureBundle = {
  artifacts: Artifact[];
  recentLifecycleEvents: TaskEventSnapshot[];
  experienceSignals: ExperienceSignalSnapshot[];
  retryHistory: RetryAttemptSnapshot[];
  experienceCategorySummary: Partial<Record<ExperienceCategory, number>>;
};
