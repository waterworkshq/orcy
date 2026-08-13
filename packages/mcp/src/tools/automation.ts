import type { KanbanApiClient } from "../api.js";

/** Lists {@link AutomationRule} definitions registered for a board. */
export async function listRules(
  client: KanbanApiClient,
  args: { habitatId?: string; boardId?: string },
) {
  const habitatId = args.habitatId ?? args.boardId ?? "";
  return client.listAutomationRules(habitatId);
}

/** Fetches a single {@link AutomationRule} by its ID. */
export async function getRule(client: KanbanApiClient, args: { ruleId: string }) {
  return client.getAutomationRule(args.ruleId);
}

/** Dry-runs an {@link AutomationRule} against a synthetic trigger and returns an {@link AutomationSimulationResult} describing which actions would execute. */
export async function simulateRule(
  client: KanbanApiClient,
  args: {
    ruleId: string;
    triggerEventId?: string;
    targetType?: string;
    targetId?: string;
    payload?: Record<string, unknown>;
  },
) {
  return client.simulateAutomationRule(args.ruleId, {
    triggerEventId: args.triggerEventId,
    targetType: args.targetType,
    targetId: args.targetId,
    payload: args.payload,
  });
}

/** Lists recent {@link AutomationRuleRun} executions for a board, paginated by limit/offset. */
export async function listRuns(
  client: KanbanApiClient,
  args: { habitatId?: string; boardId?: string; limit?: number; offset?: number },
) {
  const habitatId = args.habitatId ?? args.boardId ?? "";
  return client.listAutomationRuns(habitatId, { limit: args.limit, offset: args.offset });
}

/** Lists {@link AutomationRuleRun} executions for a single rule, paginated by limit/offset. */
export async function getRuleRuns(
  client: KanbanApiClient,
  args: { ruleId: string; limit?: number; offset?: number },
) {
  return client.getAutomationRuleRuns(args.ruleId, { limit: args.limit, offset: args.offset });
}
