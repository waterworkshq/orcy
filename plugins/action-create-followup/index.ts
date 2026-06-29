import type { PluginModule } from "../../packages/api/src/plugins/types.js";

/**
 * action-create-followup reference plugin (ADR-0023).
 *
 * Demonstrates a plugin-defined automation action: creates a follow-up task
 * in the same mission as the trigger task. Uses the `taskWriter` capability
 * (ADR-0020) with habitat-scoped writes, provenance stamping, and rate cap.
 *
 * When an automation rule includes `{ type: "plugin", actionId: "create-followup",
 * params: { titlePrefix: "Follow-up" } }`, this handler:
 * 1. Reads the trigger task from the evaluation context
 * 2. Creates a new task in the same mission
 * 3. Returns a succeeded result with the new task ID
 */
const actionPlugin: PluginModule = {
  manifest: {
    id: "action-create-followup",
    version: "1.0.0",
    description: "Automation action — creates a follow-up task in the trigger task's mission",
    contributions: [
      {
        kind: "automationAction",
        scope: "system",
        actionId: "create-followup",
        label: "Create Follow-up Task",
        description:
          "Creates a follow-up task in the same mission as the trigger task. Params: titlePrefix (default 'Follow-up'), priority (default 'medium').",
        timeoutMs: 5000,
        requires: ["taskWriter"],
      },
    ],
  },
  actions: {
    "create-followup": async (ctx, evaluationCtx, params) => {
      const mission = evaluationCtx.mission;
      if (!mission) {
        return {
          status: "failed" as const,
          error: "No mission in evaluation context — cannot create follow-up task",
        };
      }
      if (!ctx.taskWriter) {
        return {
          status: "failed" as const,
          error: "taskWriter capability not available",
        };
      }
      const titlePrefix = (params.titlePrefix as string) ?? "Follow-up";
      const priority = (params.priority as any) ?? "medium";
      const triggerTitle = evaluationCtx.task?.title ?? "unknown task";
      const task = await ctx.taskWriter.createTask({
        missionId: mission.id,
        title: `${titlePrefix}: ${triggerTitle}`,
        priority,
      });
      return {
        status: "succeeded" as const,
        result: { taskId: task.id, title: task.title },
      };
    },
  },
};

export default actionPlugin;
