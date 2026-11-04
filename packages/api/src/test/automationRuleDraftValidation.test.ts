import { describe, it, expect } from "vitest";
import {
  automationTriggerSchema,
  automationActionSchema,
  automationRecipientSchema,
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

// GROUND: TASKS T7 bullet 1 — "New authoring unsupported recipient/nonempty
// channel form rejects; legacy revision decoding/data remain unchanged."
// PRD N4 (reject newly authored unsupported forms with actionable errors,
// keep legacy revisions decodable) and N10 (immutable configuration controls).
describe("automation notify authoring guard (N4)", () => {
  const notifyAction = (recipients: unknown, channels?: string[]) => ({
    type: "notify", recipients, template: "T", ...(channels ? { channels } : {}),
  });
  const ruleBody = (actions: unknown) => ({
    name: "N", trigger: { type: "event", eventType: "task.rejected" }, actions,
  });

  // GROUND: PRD N4 — mission_owner rejected with named replacement.
  it("rejects mission_owner notify recipient with replacement guidance (N4)", () => {
    const res = automationRuleDraftSchema.safeParse(ruleBody([notifyAction([{ type: "mission_owner" }])]));
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) => i.path.join(".") === "actions.0.recipients.0.type");
      expect(issue?.message).toContain("mission_owner is not supported");
      expect(issue?.message).toContain("habitat_admins");
    }
  });

  // GROUND: PRD N4 — channel recipient form rejected at authoring time.
  it("rejects channel notify recipient with replacement guidance", () => {
    const res = automationRuleDraftSchema.safeParse(ruleBody([notifyAction([{ type: "channel", channelId: "c1" }])]));
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) => i.path.join(".") === "actions.0.recipients.0.type");
      expect(issue?.message).toContain("channel recipients are not supported");
      expect(issue?.message).toContain("address human/agent recipients explicitly");
    }
  });

  // GROUND: PRD N4 — nonempty per-notify channel override rejected; the
  // empty array stays a legal no-op form.
  it("rejects nonempty channels override, accepts empty channels array", () => {
    expect(automationRuleDraftSchema.safeParse(ruleBody([notifyAction([{ type: "habitat_admins" }], ["email"])])).success).toBe(false);
    expect(createAutomationRuleSchema.safeParse(ruleBody([notifyAction([{ type: "habitat_admins" }], [])])).success).toBe(true);
  });

  // GROUND: PRD N4 — "Support legitimate domain audiences" (parity cell;
  // must stay green across the migration).
  it("habitat_admins / human / agent / assignee / reporter / reviewers recipients still accepted", () => {
    const res = updateAutomationRuleSchema.safeParse(ruleBody([notifyAction([
      { type: "habitat_admins" }, { type: "human", userId: "u1" }, { type: "agent", agentId: "a1" },
      { type: "assignee" }, { type: "reporter" }, { type: "reviewers" },
    ])]));
    expect(res.success).toBe(true);
  });

  // GROUND: TASKS T7 bullet 2 — "Preserve PATCH derivation and unrelated
  // updates; no ZodEffects `.partial` break" (parity cell).
  it("enable-only PATCH (no actions) is unaffected", () => {
    expect(updateAutomationRuleSchema.safeParse({ enabled: true }).success).toBe(true);
  });

  // GROUND: PRD N4 — "Keep legacy revisions decodable and unchanged" (frozen
  // decode-union parity cell; the decode union must stay untouched).
  it("frozen decode union: all 8 stored recipient forms still parse (stored revisions stay decodable)", () => {
    const forms = [
      { type: "assignee" }, { type: "reporter" }, { type: "reviewers" }, { type: "mission_owner" },
      { type: "habitat_admins" }, { type: "agent", agentId: "a1" }, { type: "human", userId: "u1" },
      { type: "channel", channelId: "c1" },
    ];
    for (const f of forms) {
      expect(automationRecipientSchema.safeParse(f).success).toBe(true);
    }
  });
});
