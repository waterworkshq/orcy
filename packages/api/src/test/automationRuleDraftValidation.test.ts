import { describe, it, expect } from "vitest";
import {
  automationTriggerSchema,
  automationActionSchema,
  createAutomationRuleSchema,
  updateAutomationRuleSchema,
  automationRuleDraftSchema,
} from "../models/automationRuleSchema.js";
import type { AutomationRuleDraft } from "@orcy/shared";

describe("LL-RM-1 Phase 1: Automation Rule Schema Validation", () => {
  describe("automationTriggerSchema", () => {
    it("accepts valid event trigger", () => {
      const res = automationTriggerSchema.safeParse({
        type: "event",
        eventType: "task.rejected",
      });
      expect(res.success).toBe(true);
    });

    it("accepts valid scan trigger", () => {
      const res = automationTriggerSchema.safeParse({
        type: "scan",
        scanType: "mission_blocked",
      });
      expect(res.success).toBe(true);
    });

    it("rejects unknown trigger type", () => {
      const res = automationTriggerSchema.safeParse({
        type: "webhook",
        endpoint: "/hook",
      });
      expect(res.success).toBe(false);
    });

    it("rejects unknown eventType in event trigger", () => {
      const res = automationTriggerSchema.safeParse({
        type: "event",
        eventType: "invalid.event.type",
      });
      expect(res.success).toBe(false);
    });

    it("rejects unknown scanType in scan trigger", () => {
      const res = automationTriggerSchema.safeParse({
        type: "scan",
        scanType: "non_existent_scan",
      });
      expect(res.success).toBe(false);
    });
  });

  describe("automationActionSchema", () => {
    it("accepts notify action with valid recipients", () => {
      const res = automationActionSchema.safeParse({
        type: "notify",
        recipients: [
          { type: "assignee" },
          { type: "agent", agentId: "agent-1" },
          { type: "human", userId: "user-1" },
        ],
        template: "Task {{task.id}} updated",
      });
      expect(res.success).toBe(true);
    });

    it("rejects notify action with empty recipients", () => {
      const res = automationActionSchema.safeParse({
        type: "notify",
        recipients: [],
        template: "No recipient",
      });
      expect(res.success).toBe(false);
    });

    it("accepts create_signal action", () => {
      const res = automationActionSchema.safeParse({
        type: "create_signal",
        content: "High failure rate detected",
      });
      expect(res.success).toBe(true);
    });

    it("accepts create_task action", () => {
      const res = automationActionSchema.safeParse({
        type: "create_task",
        title: "Investigate anomaly",
        description: "Auto-created by rule",
        missionId: "m-123",
      });
      expect(res.success).toBe(true);
    });

    it("accepts call_webhook action with valid url", () => {
      const res = automationActionSchema.safeParse({
        type: "call_webhook",
        url: "https://api.example.com/alerts",
        headers: { "X-Custom": "Header" },
      });
      expect(res.success).toBe(true);
    });

    it("rejects call_webhook action with invalid url", () => {
      const res = automationActionSchema.safeParse({
        type: "call_webhook",
        url: "not-a-valid-url",
      });
      expect(res.success).toBe(false);
    });

    it("accepts plugin action", () => {
      const res = automationActionSchema.safeParse({
        type: "plugin",
        actionId: "custom-plugin-action",
        params: { key: "value" },
      });
      expect(res.success).toBe(true);
    });
  });

  describe("createAutomationRuleSchema & automationRuleDraftSchema", () => {
    it("validates a complete rule draft", () => {
      const draft: AutomationRuleDraft = {
        name: "Auto-reassign failed tasks",
        description: "Reassigns rejected tasks to lead",
        enabled: true,
        priority: 5,
        trigger: {
          type: "event",
          eventType: "task.rejected",
        },
        condition: {
          type: "field",
          field: "task.priority",
          operator: "equals",
          value: "critical",
        },
        actions: [
          {
            type: "change_priority",
            priority: "critical",
          },
          {
            type: "notify",
            recipients: [{ type: "habitat_admins" }],
            template: "Critical task {{task.id}} was rejected",
          },
        ],
        cooldownSeconds: 60,
        maxRunsPerHour: 10,
      };

      const res = automationRuleDraftSchema.safeParse(draft);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.name).toBe("Auto-reassign failed tasks");
        expect(res.data.actions).toHaveLength(2);
      }
    });

    it("rejects rule with empty name or missing actions", () => {
      const res = createAutomationRuleSchema.safeParse({
        name: "",
        trigger: { type: "event", eventType: "task.created" },
        actions: [],
      });
      expect(res.success).toBe(false);
    });

    it("accepts valid partial update in updateAutomationRuleSchema", () => {
      const res = updateAutomationRuleSchema.safeParse({
        name: "Updated Name",
        enabled: false,
        cooldownSeconds: 120,
      });
      expect(res.success).toBe(true);
    });
  });
});
