import type { KanbanApiClient } from "../api.js";

export async function listRules(client: KanbanApiClient, args: { boardId: string }) {
  return client.listAutomationRules(args.boardId);
}

export async function getRule(client: KanbanApiClient, args: { ruleId: string }) {
  return client.getAutomationRule(args.ruleId);
}

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

export async function listRuns(
  client: KanbanApiClient,
  args: { boardId: string; limit?: number; offset?: number },
) {
  return client.listAutomationRuns(args.boardId, { limit: args.limit, offset: args.offset });
}

export async function getRuleRuns(
  client: KanbanApiClient,
  args: { ruleId: string; limit?: number; offset?: number },
) {
  return client.getAutomationRuleRuns(args.ruleId, { limit: args.limit, offset: args.offset });
}
