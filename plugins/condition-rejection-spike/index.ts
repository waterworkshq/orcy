import type { PluginModule } from "../../packages/api/src/plugins/types.js";

/**
 * condition-rejection-spike reference plugin (ADR-0022).
 *
 * Demonstrates a plugin-defined automation condition: matches when a task
 * has been rejected at least N times (params.threshold, default 3). The
 * built-in conditions don't cover rejection-count logic — this shows how
 * a plugin extends the condition evaluator with domain-specific predicates.
 */
const conditionPlugin: PluginModule = {
  manifest: {
    id: "condition-rejection-spike",
    version: "1.0.0",
    description: "Automation condition — matches tasks with repeated rejections",
    contributions: [
      {
        kind: "automationCondition",
        scope: "system",
        conditionId: "rejection-spike",
        label: "Rejection Spike",
        description:
          "Matches when a task has been rejected at least N times (params.threshold, default 3)",
        requires: [],
      },
    ],
  },
  conditions: {
    "rejection-spike": (evaluationCtx, params) => {
      const threshold = (params.threshold as number) ?? 3;
      const rejectionCount = evaluationCtx.task?.rejectedCount ?? 0;
      const matched = rejectionCount >= threshold;
      return {
        matched,
        reason: matched
          ? `Task rejected ${rejectionCount} times (>= ${threshold})`
          : `Task rejected ${rejectionCount} times (< ${threshold})`,
      };
    },
  },
};

export default conditionPlugin;
