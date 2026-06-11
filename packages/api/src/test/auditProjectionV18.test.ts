import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import {
  projectAutomationRunToAudit,
  projectNotificationEventToAudit,
  projectNotificationDeliveryToAudit,
} from "../services/automationAuditProjection.js";

function setupHabitat() {
  const h = boardRepo.createHabitat({ name: "Test Habitat" });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
}

describe("automationAuditProjection", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  describe("projectAutomationRunToAudit", () => {
    it("projects a succeeded run with rule metadata", () => {
      const habitat = setupHabitat();
      const rule = ruleRepo.createAutomationRule({
        habitatId: habitat.id,
        name: "Deploy Notifier",
        trigger: { type: "event", eventType: "task.rejected" } as any,
        actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "Deploy" }],
        createdBy: "user-1",
      });
      const run = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
        triggerEventId: "evt-1",
        targetType: "task",
        targetId: "task-1",
      });
      runRepo.finishRuleRun(run.id, {
        status: "succeeded",
        conditionResult: { matched: true, conditionType: "always", reason: "Always" },
        actionResults: [{ actionType: "notify", actionIndex: 0, status: "succeeded" }],
      });

      const fetched = runRepo.getRuleRunById(run.id)!;
      const audit = projectAutomationRunToAudit(fetched, rule);
      expect(audit.id).toBe(`automation_run:${run.id}`);
      expect(audit.source).toBe("automation");
      expect(audit.metadata.triggerType).toBe("task.rejected");
      expect(audit.metadata.status).toBe("succeeded");
      expect(audit.summary).toContain("Deploy Notifier");
    });

    it("projects a skipped run with skip reason", () => {
      const habitat = setupHabitat();
      const rule = ruleRepo.createAutomationRule({
        habitatId: habitat.id,
        name: "Test Rule",
        trigger: { type: "scan", scanType: "mission_blocked" } as any,
        actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "X" }],
        createdBy: "user-1",
      });
      const run = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "mission_blocked",
      });
      runRepo.skipRuleRun(run.id, "cooldown");

      const audit = projectAutomationRunToAudit(runRepo.getRuleRunById(run.id)!, rule);
      expect(audit.metadata.skipReason).toBe("cooldown");
      expect(audit.summary).toContain("skipped");
    });

    it("handles missing rule gracefully (null rule)", () => {
      const habitat = setupHabitat();
      const rule = ruleRepo.createAutomationRule({
        habitatId: habitat.id,
        name: "Ephemeral",
        trigger: { type: "event", eventType: "task.rejected" } as any,
        actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "X" }],
        createdBy: "user-1",
      });
      const run = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
      });
      const audit = projectAutomationRunToAudit(run, null);
      expect(audit.id).toBeDefined();
      expect(audit.entity.title).toContain("Automation Run");
    });
  });

  describe("projectNotificationEventToAudit", () => {
    it("projects event with deliveries", () => {
      const habitat = setupHabitat();
      const event = eventRepo.createNotificationEvent({
        habitatId: habitat.id,
        eventType: "task.assigned",
        sourceType: "task",
        sourceId: "task-1",
        severity: "info",
        title: "Task assigned",
        body: "Test body",
        createdByType: "system",
      });
      const d1 = deliveryRepo.createNotificationDelivery({
        eventId: event.id,
        habitatId: habitat.id,
        recipientType: "human",
        recipientId: "user-1",
        channels: ["in_app"],
      });
      const d2 = deliveryRepo.createNotificationDelivery({
        eventId: event.id,
        habitatId: habitat.id,
        recipientType: "agent",
        recipientId: "agent-1",
        channels: ["in_app"],
      });
      const audit = projectNotificationEventToAudit(event, [d1, d2]);
      expect(audit.id).toBe(`notification_event:${event.id}`);
      expect(audit.metadata.deliveryCount).toBe(2);
    });

    it("projects event without deliveries", () => {
      const habitat = setupHabitat();
      const event = eventRepo.createNotificationEvent({
        habitatId: habitat.id,
        eventType: "digest.ready",
        sourceType: "digest",
        severity: "info",
        title: "Digest",
        body: "Test",
        createdByType: "system",
      });
      const audit = projectNotificationEventToAudit(event);
      expect(audit.metadata.deliveryCount).toBe(0);
    });

    it("automation-created event gets automation source", () => {
      const habitat = setupHabitat();
      const event = eventRepo.createNotificationEvent({
        habitatId: habitat.id,
        eventType: "automation.action_failed",
        sourceType: "automation",
        severity: "warning",
        title: "Failed",
        body: "Failed",
        createdByType: "automation",
        createdById: "rule:r-1",
      });
      const audit = projectNotificationEventToAudit(event);
      expect(audit.source).toBe("automation");
    });
  });

  describe("projectNotificationDeliveryToAudit", () => {
    it("projects acknowledged delivery", () => {
      const habitat = setupHabitat();
      const event = eventRepo.createNotificationEvent({
        habitatId: habitat.id,
        eventType: "task.assigned",
        sourceType: "task",
        sourceId: "task-1",
        severity: "info",
        title: "Test",
        body: "Test",
        createdByType: "system",
      });
      const delivery = deliveryRepo.createNotificationDelivery({
        eventId: event.id,
        habitatId: habitat.id,
        recipientType: "human",
        recipientId: "user-1",
        channels: ["in_app"],
      });
      deliveryRepo.acknowledgeDelivery(delivery.id);
      const audit = projectNotificationDeliveryToAudit(
        deliveryRepo.getNotificationDeliveryById(delivery.id)!,
        event,
      );
      expect(audit.metadata.status).toBe("acknowledged");
      expect(audit.summary).toContain("acknowledged");
    });

    it("projects required delivery with [Required] prefix", () => {
      const habitat = setupHabitat();
      const event = eventRepo.createNotificationEvent({
        habitatId: habitat.id,
        eventType: "mission.risk_marked",
        sourceType: "mission",
        severity: "critical",
        title: "Risk",
        body: "Test",
        createdByType: "system",
      });
      const delivery = deliveryRepo.createNotificationDelivery({
        eventId: event.id,
        habitatId: habitat.id,
        recipientType: "human",
        recipientId: "user-1",
        required: true,
        channels: ["in_app"],
      });
      const audit = projectNotificationDeliveryToAudit(delivery, event);
      expect(audit.summary).toContain("[Required]");
    });

    it("handles null event with fallback title", () => {
      const habitat = setupHabitat();
      const event = eventRepo.createNotificationEvent({
        habitatId: habitat.id,
        eventType: "task.assigned",
        sourceType: "task",
        severity: "info",
        title: "Test",
        body: "Test",
        createdByType: "system",
      });
      const delivery = deliveryRepo.createNotificationDelivery({
        eventId: event.id,
        habitatId: habitat.id,
        recipientType: "human",
        recipientId: "user-1",
        channels: ["in_app"],
      });
      const audit = projectNotificationDeliveryToAudit(delivery, null);
      expect(audit.entity.title).toContain("Delivery");
    });
  });

  describe("audit event shape", () => {
    it("all projections return valid AuditEvent shape", () => {
      const habitat = setupHabitat();
      const event = eventRepo.createNotificationEvent({
        habitatId: habitat.id,
        eventType: "task.assigned",
        sourceType: "task",
        severity: "info",
        title: "T",
        body: "T",
        createdByType: "system",
      });
      const rule = ruleRepo.createAutomationRule({
        habitatId: habitat.id,
        name: "R",
        trigger: { type: "event", eventType: "task.rejected" } as any,
        actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "X" }],
        createdBy: "user-1",
      });
      const run = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
      });
      const delivery = deliveryRepo.createNotificationDelivery({
        eventId: event.id,
        habitatId: habitat.id,
        recipientType: "human",
        recipientId: "user-1",
        channels: ["in_app"],
      });

      const runAudit = projectAutomationRunToAudit(run, rule);
      const eventAudit = projectNotificationEventToAudit(event);
      const deliveryAudit = projectNotificationDeliveryToAudit(delivery, event);

      for (const a of [runAudit, eventAudit, deliveryAudit]) {
        expect(a.id).toBeDefined();
        expect(a.habitatId).toBeDefined();
        expect(a.occurredAt).toBeDefined();
        expect(a.entity).toBeDefined();
        expect(a.action).toBeDefined();
        expect(a.actor).toBeDefined();
        expect(a.source).toBeDefined();
        expect(a.summary).toBeDefined();
        expect(a.metadata).toBeDefined();
        expect(a.completeness).toBeDefined();
      }
    });
  });
});
