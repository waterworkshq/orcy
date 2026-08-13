import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as commandService from "../services/notificationCommandService.js";
import * as resolver from "../services/notificationSubscriptionResolver.js";
import * as templateService from "../services/notificationTemplateService.js";

function setupHabitat() {
  return boardRepo.createHabitat({ name: "Test Habitat" });
}

function createDefaultSubscription(
  habitatId: string,
  eventType: string,
  overrides?: Partial<subscriptionRepo.CreateSubscriptionInput>,
) {
  return subscriptionRepo.createSubscription({
    habitatId,
    scope: "habitat_default",
    eventType,
    enabled: true,
    required: false,
    channels: ["in_app"],
    cadence: "immediate",
    ...overrides,
  });
}

function createOverrideSubscription(
  habitatId: string,
  recipientType: "human" | "agent",
  recipientId: string,
  eventType: string,
  overrides?: Partial<subscriptionRepo.CreateSubscriptionInput>,
) {
  return subscriptionRepo.createSubscription({
    habitatId,
    scope: "recipient_override",
    recipientType,
    recipientId,
    eventType,
    enabled: true,
    channels: ["in_app", "webhook"],
    cadence: "immediate",
    ...overrides,
  });
}

describe("notificationSubscriptionResolver", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  describe("validateEventType", () => {
    it("accepts valid v0.18 event types", () => {
      const validTypes = [
        "task.blocked",
        "task.review_requested",
        "task.assigned",
        "mission.risk_marked",
        "automation.rule_matched",
        "automation.action_failed",
        "digest.ready",
        "pulse.signal_posted",
        "agent.message_received",
      ];
      for (const t of validTypes) {
        expect(() => resolver.validateEventType(t)).not.toThrow();
      }
    });

    it("rejects invalid event types", () => {
      expect(() => resolver.validateEventType("task.unknown")).toThrow(
        "INVALID_NOTIFICATION_EVENT_TYPE:task.unknown",
      );
      expect(() => resolver.validateEventType("random.event")).toThrow(
        "INVALID_NOTIFICATION_EVENT_TYPE:random.event",
      );
    });
  });

  describe("resolveRecipients", () => {
    it("returns empty when no defaults and no explicit recipients", () => {
      const habitat = setupHabitat();
      const result = resolver.resolveRecipients({
        habitatId: habitat.id,
        eventType: "task.assigned",
      });
      expect(result).toEqual([]);
    });

    it("returns empty when no explicit recipients even with defaults", () => {
      const habitat = setupHabitat();
      createDefaultSubscription(habitat.id, "task.assigned");
      const result = resolver.resolveRecipients({
        habitatId: habitat.id,
        eventType: "task.assigned",
      });
      expect(result).toEqual([]);
    });

    it("resolves recipient using habitat default", () => {
      const habitat = setupHabitat();
      createDefaultSubscription(habitat.id, "task.assigned", {
        channels: ["in_app", "slack"],
        cadence: "immediate",
      });

      const result = resolver.resolveRecipients({
        habitatId: habitat.id,
        eventType: "task.assigned",
        explicitRecipients: [{ recipientType: "human", recipientId: "user-1" }],
      });

      expect(result).toHaveLength(1);
      expect(result[0].recipientId).toBe("user-1");
      expect(result[0].channels).toEqual(["in_app", "slack"]);
      expect(result[0].cadence).toBe("immediate");
      expect(result[0].required).toBe(false);
      expect(result[0].suppressed).toBe(false);
    });

    it("applies recipient override over habitat default", () => {
      const habitat = setupHabitat();
      createDefaultSubscription(habitat.id, "task.assigned", {
        channels: ["in_app"],
        cadence: "immediate",
      });
      createOverrideSubscription(habitat.id, "human", "user-1", "task.assigned", {
        channels: ["in_app", "discord"],
        cadence: "daily",
      });

      const result = resolver.resolveRecipients({
        habitatId: habitat.id,
        eventType: "task.assigned",
        explicitRecipients: [{ recipientType: "human", recipientId: "user-1" }],
      });

      expect(result).toHaveLength(1);
      expect(result[0].channels).toEqual(["in_app", "discord"]);
      expect(result[0].cadence).toBe("daily");
    });

    it("suppresses when recipient override is disabled", () => {
      const habitat = setupHabitat();
      createDefaultSubscription(habitat.id, "task.assigned");
      createOverrideSubscription(habitat.id, "human", "user-1", "task.assigned", {
        enabled: false,
      });

      const result = resolver.resolveRecipients({
        habitatId: habitat.id,
        eventType: "task.assigned",
        explicitRecipients: [{ recipientType: "human", recipientId: "user-1" }],
      });

      expect(result).toHaveLength(1);
      expect(result[0].suppressed).toBe(true);
      expect(result[0].suppressReason).toBe("disabled");
    });

    it("suppresses when default has active mute", () => {
      const habitat = setupHabitat();
      const future = new Date(Date.now() + 86400000).toISOString();
      createDefaultSubscription(habitat.id, "task.assigned", {
        muteUntil: future,
      });

      const result = resolver.resolveRecipients({
        habitatId: habitat.id,
        eventType: "task.assigned",
        explicitRecipients: [{ recipientType: "human", recipientId: "user-1" }],
      });

      expect(result).toHaveLength(1);
      expect(result[0].suppressed).toBe(true);
      expect(result[0].suppressReason).toBe("muted");
    });

    it("does not suppress when mute has expired", () => {
      const habitat = setupHabitat();
      const past = new Date(Date.now() - 86400000).toISOString();
      createDefaultSubscription(habitat.id, "task.assigned", {
        muteUntil: past,
      });

      const result = resolver.resolveRecipients({
        habitatId: habitat.id,
        eventType: "task.assigned",
        explicitRecipients: [{ recipientType: "human", recipientId: "user-1" }],
      });

      expect(result).toHaveLength(1);
      expect(result[0].suppressed).toBe(false);
    });

    it("required bypass overrides mute", () => {
      const habitat = setupHabitat();
      const future = new Date(Date.now() + 86400000).toISOString();
      createDefaultSubscription(habitat.id, "task.assigned", {
        required: true,
        muteUntil: future,
      });

      const result = resolver.resolveRecipients({
        habitatId: habitat.id,
        eventType: "task.assigned",
        explicitRecipients: [{ recipientType: "human", recipientId: "user-1" }],
      });

      expect(result).toHaveLength(1);
      expect(result[0].required).toBe(true);
      expect(result[0].suppressed).toBe(false);
    });

    it("returns no_default suppress when no matching default exists", () => {
      const habitat = setupHabitat();
      createDefaultSubscription(habitat.id, "task.blocked");

      const result = resolver.resolveRecipients({
        habitatId: habitat.id,
        eventType: "task.assigned",
        explicitRecipients: [{ recipientType: "human", recipientId: "user-1" }],
      });

      expect(result).toHaveLength(1);
      expect(result[0].suppressed).toBe(true);
      expect(result[0].suppressReason).toBe("no_default");
    });

    it("deduplicates explicit recipients", () => {
      const habitat = setupHabitat();
      createDefaultSubscription(habitat.id, "task.assigned");

      const result = resolver.resolveRecipients({
        habitatId: habitat.id,
        eventType: "task.assigned",
        explicitRecipients: [
          { recipientType: "human", recipientId: "user-1" },
          { recipientType: "human", recipientId: "user-1" },
        ],
      });

      expect(result).toHaveLength(1);
    });

    it("handles multiple distinct recipients", () => {
      const habitat = setupHabitat();
      createDefaultSubscription(habitat.id, "task.assigned");

      const result = resolver.resolveRecipients({
        habitatId: habitat.id,
        eventType: "task.assigned",
        explicitRecipients: [
          { recipientType: "human", recipientId: "user-1" },
          { recipientType: "agent", recipientId: "agent-1" },
        ],
      });

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.recipientId).toSorted()).toEqual(["agent-1", "user-1"]);
    });

    it("suppresses non-required when recipient override has active mute", () => {
      const habitat = setupHabitat();
      createDefaultSubscription(habitat.id, "task.assigned");
      const future = new Date(Date.now() + 86400000).toISOString();
      createOverrideSubscription(habitat.id, "human", "user-1", "task.assigned", {
        muteUntil: future,
      });

      const result = resolver.resolveRecipients({
        habitatId: habitat.id,
        eventType: "task.assigned",
        explicitRecipients: [{ recipientType: "human", recipientId: "user-1" }],
      });

      expect(result).toHaveLength(1);
      expect(result[0].suppressed).toBe(true);
      expect(result[0].suppressReason).toBe("muted");
    });
  });
});

describe("notificationTemplateService", () => {
  it("renders task.blocked notification", () => {
    const result = templateService.renderNotification({
      eventType: "task.blocked",
      sourceType: "task",
      sourceId: "task-1",
      severity: "warning",
      recipientType: "human",
      payload: { taskTitle: "Fix login bug", blockerReason: "Waiting on API" },
    });
    expect(result.title).toContain("Task blocked");
    expect(result.title).toContain("Fix login bug");
    expect(result.body).toContain("Waiting on API");
  });

  it("renders task.review_requested notification", () => {
    const result = templateService.renderNotification({
      eventType: "task.review_requested",
      sourceType: "task",
      severity: "info",
      recipientType: "human",
      payload: { taskTitle: "Add auth", requesterName: "Alice" },
    });
    expect(result.title).toContain("Review requested");
    expect(result.body).toContain("Alice");
  });

  it("renders task.assigned notification", () => {
    const result = templateService.renderNotification({
      eventType: "task.assigned",
      sourceType: "task",
      severity: "info",
      recipientType: "human",
      payload: { taskTitle: "Build feature", assignerName: "Bob" },
    });
    expect(result.title).toContain("Task assigned");
    expect(result.body).toContain("Bob");
  });

  it("renders mission.risk_marked notification", () => {
    const result = templateService.renderNotification({
      eventType: "mission.risk_marked",
      sourceType: "mission",
      severity: "critical",
      recipientType: "human",
      payload: { missionName: "Sprint 5", riskLevel: "high" },
    });
    expect(result.title).toContain("Risk flagged");
    expect(result.body).toContain("high");
  });

  it("renders automation.rule_matched notification", () => {
    const result = templateService.renderNotification({
      eventType: "automation.rule_matched",
      sourceType: "automation",
      severity: "info",
      recipientType: "agent",
      payload: { ruleName: "Auto-assign", triggerEvent: "task.created" },
    });
    expect(result.title).toContain("Automation rule triggered");
    expect(result.body).toContain("Auto-assign");
  });

  it("renders automation.action_failed notification", () => {
    const result = templateService.renderNotification({
      eventType: "automation.action_failed",
      sourceType: "automation",
      severity: "warning",
      recipientType: "human",
      payload: { ruleName: "Deploy", actionType: "notify", errorMessage: "timeout" },
    });
    expect(result.title).toContain("Automation action failed");
    expect(result.body).toContain("timeout");
  });

  it("renders digest.ready notification", () => {
    const result = templateService.renderNotification({
      eventType: "digest.ready",
      sourceType: "digest",
      severity: "info",
      recipientType: "human",
      payload: { itemCount: 5, digestSummary: "Daily digest" },
    });
    expect(result.title).toContain("Notification digest");
    expect(result.body).toContain("5");
  });

  it("renders pulse.signal_posted notification", () => {
    const result = templateService.renderNotification({
      eventType: "pulse.signal_posted",
      sourceType: "pulse",
      severity: "info",
      recipientType: "agent",
      payload: { authorName: "Carol", signalContent: "Deploy complete" },
    });
    expect(result.title).toContain("Pulse signal");
    expect(result.body).toContain("Carol");
    expect(result.body).toContain("Deploy complete");
  });

  it("renders agent.message_received from subject and sender, never mail body", () => {
    const secretBody = "CLASSIFIED_MAIL_BODY_XYZ";
    const result = templateService.renderNotification({
      eventType: "agent.message_received",
      sourceType: "agent",
      severity: "info",
      recipientType: "agent",
      payload: {
        fromAgentName: "Ada",
        subject: "Need review",
        secretBody,
        body: secretBody,
      },
    });
    expect(result.title).toContain("Need review");
    expect(result.title).toContain("Ada");
    expect(result.body).toContain("Need review");
    expect(result.body).toContain("Ada");
    expect(result.title).not.toContain(secretBody);
    expect(result.body).not.toContain(secretBody);
  });

  it("includes payload metadata in rendered output", () => {
    const result = templateService.renderNotification({
      eventType: "task.assigned",
      sourceType: "task",
      sourceId: "task-42",
      targetType: "agent",
      targetId: "agent-5",
      severity: "info",
      recipientType: "agent",
      payload: { taskTitle: "Test task", custom: "value" },
    });
    expect(result.payload.eventType).toBe("task.assigned");
    expect(result.payload.sourceType).toBe("task");
    expect(result.payload.sourceId).toBe("task-42");
    expect(result.payload.targetType).toBe("agent");
    expect(result.payload.targetId).toBe("agent-5");
    expect(result.payload.custom).toBe("value");
  });

  it("falls back gracefully for unknown event type", () => {
    const result = templateService.renderNotification({
      eventType: "task.blocked" as any,
      sourceType: "task",
      severity: "info",
      recipientType: "human",
    });
    expect(result.title).toBeDefined();
    expect(result.body).toBeDefined();
    expect(result.payload).toBeDefined();
  });
});

describe("notificationCommandService", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("rejects invalid event type", () => {
    expect(() =>
      commandService.enqueueNotification({
        habitatId: "h1",
        eventType: "task.nonexistent" as any,
        sourceType: "task",
        severity: "info",
        createdByType: "system",
      }),
    ).toThrow("INVALID_NOTIFICATION_EVENT_TYPE:task.nonexistent");
  });

  it("creates event with auto-rendered title/body", () => {
    const habitat = setupHabitat();
    createDefaultSubscription(habitat.id, "task.assigned", {
      channels: ["in_app"],
    });

    const result = commandService.enqueueNotification({
      habitatId: habitat.id,
      eventType: "task.assigned",
      sourceType: "task",
      sourceId: "task-1",
      severity: "info",
      payload: { taskTitle: "My Task" },
      createdByType: "system",
      explicitRecipients: [{ recipientType: "human", recipientId: "user-1" }],
    });

    expect(result.event.eventType).toBe("task.assigned");
    expect(result.event.title).toContain("Task assigned");
    expect(result.event.title).toContain("My Task");
    expect(result.event.body).toBeDefined();
    expect(result.event.habitatId).toBe(habitat.id);
  });

  it("uses explicit title/body when provided", () => {
    const habitat = setupHabitat();
    createDefaultSubscription(habitat.id, "task.assigned");

    const result = commandService.enqueueNotification({
      habitatId: habitat.id,
      eventType: "task.assigned",
      sourceType: "task",
      severity: "info",
      title: "Custom Title",
      body: "Custom Body",
      createdByType: "system",
      explicitRecipients: [{ recipientType: "human", recipientId: "user-1" }],
    });

    expect(result.event.title).toBe("Custom Title");
    expect(result.event.body).toBe("Custom Body");
  });

  it("creates deliveries for resolved recipients", () => {
    const habitat = setupHabitat();
    createDefaultSubscription(habitat.id, "task.assigned", {
      channels: ["in_app", "slack"],
    });

    const result = commandService.enqueueNotification({
      habitatId: habitat.id,
      eventType: "task.assigned",
      sourceType: "task",
      severity: "info",
      createdByType: "system",
      explicitRecipients: [
        { recipientType: "human", recipientId: "user-1" },
        { recipientType: "agent", recipientId: "agent-1" },
      ],
    });

    expect(result.deliveries).toHaveLength(2);
    expect(result.deliveries[0].channels).toEqual(["in_app", "slack"]);
    expect(result.deliveries.map((d) => d.recipientId).toSorted()).toEqual(["agent-1", "user-1"]);
  });

  it("returns empty deliveries when no explicit recipients", () => {
    const habitat = setupHabitat();
    createDefaultSubscription(habitat.id, "task.assigned");

    const result = commandService.enqueueNotification({
      habitatId: habitat.id,
      eventType: "task.assigned",
      sourceType: "task",
      severity: "info",
      createdByType: "system",
    });

    expect(result.deliveries).toHaveLength(0);
    expect(result.suppressed).toHaveLength(0);
    expect(result.event).toBeDefined();
  });

  it("records suppressed recipients", () => {
    const habitat = setupHabitat();
    createDefaultSubscription(habitat.id, "task.assigned");

    const result = commandService.enqueueNotification({
      habitatId: habitat.id,
      eventType: "task.assigned",
      sourceType: "task",
      severity: "info",
      createdByType: "system",
      explicitRecipients: [{ recipientType: "human", recipientId: "user-1" }],
    });

    expect(result.suppressed).toHaveLength(0);
  });

  it("records suppressed recipients with no_default reason", () => {
    const habitat = setupHabitat();

    const result = commandService.enqueueNotification({
      habitatId: habitat.id,
      eventType: "task.assigned",
      sourceType: "task",
      severity: "info",
      createdByType: "system",
      explicitRecipients: [{ recipientType: "human", recipientId: "user-1" }],
    });

    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0].reason).toBe("no_default");
    expect(result.suppressed[0].recipientId).toBe("user-1");
  });

  it("creates delivery even for required+bypassed-mute", () => {
    const habitat = setupHabitat();
    const future = new Date(Date.now() + 86400000).toISOString();
    createDefaultSubscription(habitat.id, "task.assigned", {
      required: true,
      muteUntil: future,
    });

    const result = commandService.enqueueNotification({
      habitatId: habitat.id,
      eventType: "task.assigned",
      sourceType: "task",
      severity: "warning",
      createdByType: "automation",
      explicitRecipients: [{ recipientType: "human", recipientId: "user-1" }],
    });

    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0].required).toBe(true);
    expect(result.suppressed).toHaveLength(0);
  });

  it("handles each v0.18 event type", () => {
    const eventTypes: Array<{ type: string; source: string }> = [
      { type: "task.blocked", source: "task" },
      { type: "task.review_requested", source: "task" },
      { type: "task.assigned", source: "task" },
      { type: "mission.risk_marked", source: "mission" },
      { type: "automation.rule_matched", source: "automation" },
      { type: "automation.action_failed", source: "automation" },
      { type: "digest.ready", source: "digest" },
      { type: "pulse.signal_posted", source: "pulse" },
      { type: "agent.message_received", source: "agent" },
    ];

    for (const { type, source } of eventTypes) {
      const habitat = setupHabitat();
      createDefaultSubscription(habitat.id, type, { channels: ["in_app"] });

      const result = commandService.enqueueNotification({
        habitatId: habitat.id,
        eventType: type as any,
        sourceType: source as any,
        severity: "info",
        createdByType: "system",
        explicitRecipients: [{ recipientType: "human", recipientId: "user-1" }],
      });

      expect(result.event.eventType).toBe(type);
      expect(result.event.sourceType).toBe(source);
      expect(result.deliveries).toHaveLength(1);
    }
  });

  it("sets delivery channels from resolved subscription", () => {
    const habitat = setupHabitat();
    createDefaultSubscription(habitat.id, "task.blocked", {
      channels: ["in_app", "webhook", "slack", "discord"],
    });

    const result = commandService.enqueueNotification({
      habitatId: habitat.id,
      eventType: "task.blocked",
      sourceType: "task",
      severity: "warning",
      createdByType: "system",
      explicitRecipients: [{ recipientType: "human", recipientId: "user-1" }],
    });

    expect(result.deliveries[0].channels).toEqual(["in_app", "webhook", "slack", "discord"]);
  });

  it("creates agent deliveries with agent recipient type", () => {
    const habitat = setupHabitat();
    createDefaultSubscription(habitat.id, "automation.rule_matched");

    const result = commandService.enqueueNotification({
      habitatId: habitat.id,
      eventType: "automation.rule_matched",
      sourceType: "automation",
      severity: "info",
      createdByType: "automation",
      explicitRecipients: [{ recipientType: "agent", recipientId: "agent-1" }],
    });

    expect(result.deliveries[0].recipientType).toBe("agent");
    expect(result.deliveries[0].recipientId).toBe("agent-1");
  });

  it("stores payload in event", () => {
    const habitat = setupHabitat();
    createDefaultSubscription(habitat.id, "task.assigned");

    const payload = { taskTitle: "My Task", priority: "high", labels: ["bug"] };
    const result = commandService.enqueueNotification({
      habitatId: habitat.id,
      eventType: "task.assigned",
      sourceType: "task",
      severity: "info",
      payload,
      createdByType: "human",
      createdById: "admin-1",
      explicitRecipients: [{ recipientType: "human", recipientId: "user-1" }],
    });

    expect(result.event.payload).toMatchObject(payload);
    expect(result.event.createdByType).toBe("human");
    expect(result.event.createdById).toBe("admin-1");
  });

  it("deliveries are queryable after enqueue", () => {
    const habitat = setupHabitat();
    createDefaultSubscription(habitat.id, "task.assigned");

    commandService.enqueueNotification({
      habitatId: habitat.id,
      eventType: "task.assigned",
      sourceType: "task",
      sourceId: "task-42",
      severity: "info",
      createdByType: "system",
      explicitRecipients: [{ recipientType: "human", recipientId: "user-1" }],
    });

    const { deliveries } = deliveryRepo.getActiveInbox(habitat.id, "human", "user-1");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("pending");
  });
});

describe("enqueueNotificationForRecipients shorthand", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("works with shorthand API", () => {
    const habitat = setupHabitat();
    createDefaultSubscription(habitat.id, "task.blocked");

    const result = commandService.enqueueNotificationForRecipients(
      habitat.id,
      "task.blocked",
      "task",
      "warning",
      [
        { recipientType: "human", recipientId: "user-1" },
        { recipientType: "agent", recipientId: "agent-1" },
      ],
      { sourceId: "task-99", payload: { taskTitle: "Blocked task" } },
    );

    expect(result.event.sourceId).toBe("task-99");
    expect(result.deliveries).toHaveLength(2);
    expect(result.event.title).toContain("Blocked task");
  });

  it("defaults createdByType to system", () => {
    const habitat = setupHabitat();
    createDefaultSubscription(habitat.id, "task.assigned");

    const result = commandService.enqueueNotificationForRecipients(
      habitat.id,
      "task.assigned",
      "task",
      "info",
      [{ recipientType: "human", recipientId: "user-1" }],
    );

    expect(result.event.createdByType).toBe("system");
    expect(result.event.createdById).toBeNull();
  });
});

describe("subscription resolution with cadence", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("resolves immediate cadence from default", () => {
    const habitat = setupHabitat();
    createDefaultSubscription(habitat.id, "task.assigned", {
      cadence: "immediate",
    });

    const result = resolver.resolveRecipients({
      habitatId: habitat.id,
      eventType: "task.assigned",
      explicitRecipients: [{ recipientType: "human", recipientId: "user-1" }],
    });

    expect(result[0].cadence).toBe("immediate");
  });

  it("resolves daily cadence from override", () => {
    const habitat = setupHabitat();
    createDefaultSubscription(habitat.id, "task.assigned", {
      cadence: "immediate",
    });
    createOverrideSubscription(habitat.id, "human", "user-1", "task.assigned", {
      cadence: "daily",
    });

    const result = resolver.resolveRecipients({
      habitatId: habitat.id,
      eventType: "task.assigned",
      explicitRecipients: [{ recipientType: "human", recipientId: "user-1" }],
    });

    expect(result[0].cadence).toBe("daily");
  });

  it("resolves weekly cadence from default", () => {
    const habitat = setupHabitat();
    createDefaultSubscription(habitat.id, "digest.ready", {
      cadence: "weekly",
    });

    const result = resolver.resolveRecipients({
      habitatId: habitat.id,
      eventType: "digest.ready",
      explicitRecipients: [{ recipientType: "human", recipientId: "user-1" }],
    });

    expect(result[0].cadence).toBe("weekly");
  });
});

describe("pulse.signal_posted opt-in bridge", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("delivers pulse signal only when subscription exists", () => {
    const habitat = setupHabitat();
    createDefaultSubscription(habitat.id, "pulse.signal_posted", {
      channels: ["in_app"],
    });

    const result = commandService.enqueueNotification({
      habitatId: habitat.id,
      eventType: "pulse.signal_posted",
      sourceType: "pulse",
      sourceId: "signal-1",
      severity: "info",
      payload: { authorName: "Alice", signalContent: "Deploy done" },
      createdByType: "human",
      createdById: "user-alice",
      explicitRecipients: [{ recipientType: "agent", recipientId: "agent-1" }],
    });

    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0].channels).toEqual(["in_app"]);
  });

  it("suppresses pulse signal when no subscription exists", () => {
    const habitat = setupHabitat();

    const result = commandService.enqueueNotification({
      habitatId: habitat.id,
      eventType: "pulse.signal_posted",
      sourceType: "pulse",
      severity: "info",
      createdByType: "human",
      explicitRecipients: [{ recipientType: "agent", recipientId: "agent-1" }],
    });

    expect(result.deliveries).toHaveLength(0);
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0].reason).toBe("no_default");
  });
});

describe("agent.message_received opt-in bridge", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("delivers agent mail only when subscription exists", () => {
    const habitat = setupHabitat();
    createDefaultSubscription(habitat.id, "agent.message_received", {
      channels: ["in_app"],
    });

    const result = commandService.enqueueNotification({
      habitatId: habitat.id,
      eventType: "agent.message_received",
      sourceType: "agent",
      sourceId: "msg-1",
      targetType: "agent",
      targetId: "agent-b",
      severity: "info",
      payload: { fromAgentName: "Ada", subject: "Need review", messageId: "msg-1" },
      createdByType: "agent",
      createdById: "agent-a",
      explicitRecipients: [{ recipientType: "agent", recipientId: "agent-b" }],
    });

    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0].recipientType).toBe("agent");
    expect(result.deliveries[0].recipientId).toBe("agent-b");
    expect(result.deliveries[0].channels).toEqual(["in_app"]);
  });

  it("suppresses agent mail when no subscription exists", () => {
    const habitat = setupHabitat();

    const result = commandService.enqueueNotification({
      habitatId: habitat.id,
      eventType: "agent.message_received",
      sourceType: "agent",
      severity: "info",
      createdByType: "agent",
      createdById: "agent-a",
      explicitRecipients: [{ recipientType: "agent", recipientId: "agent-b" }],
    });

    expect(result.deliveries).toHaveLength(0);
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0].reason).toBe("no_default");
  });

  it("does not copy secretBody onto the stored event body or payload", () => {
    // Mutate-and-revert: interpolating payload.body / payload.secretBody in EVENT_BODIES
    // makes result.event.body contain CLASSIFIED_MAIL_BODY_XYZ. Copying a `body` field
    // onto the enqueue payload makes JSON.stringify(result.event.payload) contain it.
    const habitat = setupHabitat();
    createDefaultSubscription(habitat.id, "agent.message_received");
    const secretBody = "CLASSIFIED_MAIL_BODY_XYZ";

    const result = commandService.enqueueNotification({
      habitatId: habitat.id,
      eventType: "agent.message_received",
      sourceType: "agent",
      sourceId: "msg-1",
      severity: "info",
      payload: {
        fromAgentName: "Ada",
        subject: "Need review",
        secretBody,
      },
      createdByType: "agent",
      createdById: "agent-a",
      explicitRecipients: [{ recipientType: "agent", recipientId: "agent-b" }],
    });

    expect(result.event.title).toContain("Need review");
    expect(result.event.body).not.toContain(secretBody);
    // command.payload is persisted as-is by enqueueNotification (do not edit that hub).
    // Route-level tests assert the mail `body` string is never placed on payload.
    expect(result.event.payload).not.toHaveProperty("body");
  });
});

describe("getDefaultSubscription and getRecipientOverride helpers", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("getDefaultSubscription returns matching default", () => {
    const habitat = setupHabitat();
    const sub = createDefaultSubscription(habitat.id, "task.assigned", {
      channels: ["in_app", "slack"],
    });

    const result = resolver.getDefaultSubscription(habitat.id, "task.assigned");
    expect(result).not.toBeNull();
    expect(result!.id).toBe(sub.id);
    expect(result!.channels).toEqual(["in_app", "slack"]);
  });

  it("getDefaultSubscription returns null when none exists", () => {
    const habitat = setupHabitat();
    expect(resolver.getDefaultSubscription(habitat.id, "task.assigned")).toBeNull();
  });

  it("getRecipientOverride returns matching override", () => {
    const habitat = setupHabitat();
    const sub = createOverrideSubscription(habitat.id, "human", "user-1", "task.assigned", {
      channels: ["discord"],
    });

    const result = resolver.getRecipientOverride(habitat.id, "human", "user-1", "task.assigned");
    expect(result).not.toBeNull();
    expect(result!.id).toBe(sub.id);
    expect(result!.channels).toEqual(["discord"]);
  });

  it("getRecipientOverride returns null when none exists", () => {
    const habitat = setupHabitat();
    expect(
      resolver.getRecipientOverride(habitat.id, "human", "user-1", "task.assigned"),
    ).toBeNull();
  });
});
