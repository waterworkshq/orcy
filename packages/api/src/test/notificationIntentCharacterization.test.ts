import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import {
  enqueueNotificationForRecipients,
} from "../services/notificationCommandService.js";

/**
 * GREEN characterization of CURRENT notification recipient behavior.
 *
 * These cells pin the pre-change baseline named by this ticket (N1 exact
 * audiences / N5 required precedence / N6 snapshot composition / N10 proof).
 * Each cell is intentionally expected to PASS on the current tree — a failure
 * here is a fixture or environment defect, never a confirmed product defect,
 * and must be investigated rather than "fixed" by weakening the expectation.
 *
 * Every cell names the successor test that flips or re-pins it after cutover.
 */
describe("characterization — current recipient resolution (intended-to-change cells)", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  // GROUND: TASKS T1 "current personal-override suppression" (N5 required
  // precedence, before-change baseline). Successor: T2/T3 required-default
  // precedence matrix — the disabled override stops suppressing the required
  // default path and this cell flips to expect a delivered row.
  it("disabled override suppresses even when a required default exists (T3 flips)", () => {
    const habitat = boardRepo.createHabitat({ name: "Char Habitat" });
    subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "habitat_default",
      eventType: "task.blocked",
      enabled: true,
      required: true,
      channels: ["in_app"],
      cadence: "immediate",
    });
    subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "recipient_override",
      recipientType: "human",
      recipientId: "user-1",
      eventType: "task.blocked",
      enabled: false,
      channels: ["in_app"],
      cadence: "immediate",
    });
    const r = enqueueNotificationForRecipients(habitat.id, "task.blocked", "task", "warning", [
      { recipientType: "human", recipientId: "user-1" },
    ]);
    expect(r.deliveries).toHaveLength(0);
    expect(r.suppressed[0]?.reason).toBe("disabled");
  });

  // GROUND: TASKS T6 6.5 — the T1 "agent-mail widen" cell is RETIRED: its
  // expectation moved to agentMessageNotification.test.ts as the closed
  // behavior ("active remote grant holder gains no delivery"). The legacy
  // wrapper itself is unchanged by T6 and the remaining cells stay GREEN.

  // GROUND: TASKS T1 "raw outer-transaction rollback composition" (N6
  // snapshot/atomicity, before-change baseline). Successor: T2/T4 atomicity
  // matrix — the intent command keeps this raw-transaction composition and the
  // same cell is re-pinned against the new enqueue scope.
  it("delivery creation composes inside an active raw BEGIN IMMEDIATE (tx composition precedent)", () => {
    const habitat = boardRepo.createHabitat({ name: "Tx Habitat" });
    subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "habitat_default",
      eventType: "task.blocked",
      enabled: true,
      required: false,
      channels: ["in_app"],
      cadence: "immediate",
    });
    const event = eventRepo.createNotificationEvent({
      habitatId: habitat.id,
      eventType: "task.blocked",
      sourceType: "task",
      severity: "warning",
      title: "t",
      body: "b",
      createdByType: "system",
    });
    const db = getDb();
    db.run(sql`BEGIN IMMEDIATE`);
    try {
      deliveryRepo.createNotificationDelivery({
        eventId: event.id,
        habitatId: habitat.id,
        recipientType: "human",
        recipientId: "user-1",
        required: false,
        channels: ["in_app"],
      });
    } finally {
      db.run(sql`ROLLBACK`);
    }
    expect(deliveryRepo.getDeliveriesByEvent(event.id)).toHaveLength(0);
  });
});
