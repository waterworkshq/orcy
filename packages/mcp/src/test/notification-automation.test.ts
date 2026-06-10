import { describe, it, expect } from "vitest";
import {
  NOTIFICATION_ACTIONS,
  NOTIFICATION_DISPATCH_HANDLER,
} from "../tools/notification-dispatch.js";
import { AUTOMATION_ACTIONS, AUTOMATION_DISPATCH_HANDLER } from "../tools/automation-dispatch.js";
import { KanbanApiClient } from "../api.js";

function createMockClient(overrides?: Partial<KanbanApiClient>): KanbanApiClient {
  return {
    getInbox: async () => ({ deliveries: [], total: 0 }),
    getHistory: async () => ({ deliveries: [], total: 0 }),
    getDelivery: async () => ({ delivery: null }),
    acknowledgeDelivery: async () => ({ status: "acknowledged" }),
    snoozeDelivery: async () => ({ status: "snoozed" }),
    clearDelivery: async () => ({ status: "cleared" }),
    getSubscriptions: async () => ({ overrides: [], defaults: [] }),
    listAutomationRules: async () => [],
    getAutomationRule: async () => ({}),
    simulateAutomationRule: async () => ({ wouldExecute: false }),
    listAutomationRuns: async () => ({ runs: [], total: 0 }),
    getAutomationRuleRuns: async () => ({ runs: [], total: 0 }),
    ...overrides,
  } as unknown as KanbanApiClient;
}

describe("orcy_notification tool", () => {
  it("has all self-service actions", () => {
    expect(Object.keys(NOTIFICATION_ACTIONS)).toEqual([
      "get_inbox",
      "get_history",
      "get_delivery",
      "ack",
      "snooze",
      "clear",
      "get_subscriptions",
    ]);
  });

  it("no mutation actions exist (create/update/delete forbidden)", () => {
    const actions = Object.keys(NOTIFICATION_ACTIONS);
    expect(actions).not.toContain("create");
    expect(actions).not.toContain("update");
    expect(actions).not.toContain("delete");
    expect(actions).not.toContain("admin_clear");
    expect(actions).not.toContain("set_required");
  });

  it("get_inbox calls client.getInbox", async () => {
    const client = createMockClient();
    const result = await NOTIFICATION_ACTIONS.get_inbox(client as any, { boardId: "h1" });
    expect(result).toEqual({ deliveries: [], total: 0 });
  });

  it("ack calls client.acknowledgeDelivery", async () => {
    const client = createMockClient();
    const result = await NOTIFICATION_ACTIONS.ack(client as any, {
      boardId: "h1",
      deliveryId: "d1",
    });
    expect(result).toEqual({ status: "acknowledged" });
  });

  it("snooze calls client.snoozeDelivery", async () => {
    const client = createMockClient();
    const result = await NOTIFICATION_ACTIONS.snooze(client as any, {
      boardId: "h1",
      deliveryId: "d1",
      snoozedUntil: "2025-01-01T00:00:00Z",
    });
    expect(result).toEqual({ status: "snoozed" });
  });

  it("dispatch handler resolves unknown action as error", async () => {
    const result = await NOTIFICATION_DISPATCH_HANDLER(createMockClient() as any, {
      action: "unknown_action",
    });
    expect(result.isError).toBe(true);
  });

  it("dispatch handler processes get_inbox successfully", async () => {
    const result = await NOTIFICATION_DISPATCH_HANDLER(createMockClient() as any, {
      action: "get_inbox",
      boardId: "h1",
    });
    expect(result.isError).toBeFalsy();
  });
});

describe("orcy_automation tool", () => {
  it("has only read/simulate/history actions", () => {
    expect(Object.keys(AUTOMATION_ACTIONS)).toEqual([
      "list",
      "get",
      "simulate",
      "list_runs",
      "get_rule_runs",
    ]);
  });

  it("no mutation actions exposed", () => {
    const actions = Object.keys(AUTOMATION_ACTIONS);
    expect(actions).not.toContain("create");
    expect(actions).not.toContain("update");
    expect(actions).not.toContain("delete");
    expect(actions).not.toContain("enable");
    expect(actions).not.toContain("disable");
    expect(actions).not.toContain("run");
  });

  it("list calls client.listAutomationRules", async () => {
    const client = createMockClient();
    const result = await AUTOMATION_ACTIONS.list(client as any, { boardId: "h1" });
    expect(result).toEqual([]);
  });

  it("simulate calls client.simulateAutomationRule", async () => {
    const client = createMockClient();
    const result = await AUTOMATION_ACTIONS.simulate(client as any, {
      ruleId: "r1",
      triggerEventId: "evt-1",
    });
    expect(result).toEqual({ wouldExecute: false });
  });

  it("dispatch handler rejects unknown action", async () => {
    const result = await AUTOMATION_DISPATCH_HANDLER(createMockClient() as any, {
      action: "unknown",
    });
    expect(result.isError).toBe(true);
  });

  it("dispatch handler processes list successfully", async () => {
    const result = await AUTOMATION_DISPATCH_HANDLER(createMockClient() as any, {
      action: "list",
      boardId: "h1",
    });
    expect(result.isError).toBeFalsy();
  });
});
