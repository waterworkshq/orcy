import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import { generateDailyDigests, generateHourlyDigests, generateWeeklyDigests } from "../services/notificationDigestService.js";

// T2a — Cadence persistence substrate (migration 0087 + digest scheduling).
// GROUND: PRD N5 (required default's mandatory cadence must govern downstream
// delivery/digest scheduling end-to-end), DESIGN §4 (owner decision 2026-11-03:
// implement cadence end-to-end; digest grouping unions persisted cadence with
// legacy subscription grouping), TASKS T2a, CORE-TASKS §2b edits 1–5/fence.
// Scope: substrate only — no core-module (notificationIntentCommand) dependency.
describe("persisted delivery cadence drives digest scheduling (0087)", () => {
  beforeEach(async () => { await initTestDb(); });
  afterEach(() => closeDb());

  function seedDelivery(cadence?: "immediate" | "daily") {
    const habitat = habitatRepo.createHabitat({ name: "Cadence" });
    const event = eventRepo.createNotificationEvent({ habitatId: habitat.id, eventType: "task.blocked",
      sourceType: "task", severity: "warning", title: "t", body: "b", createdByType: "system" });
    const delivery = deliveryRepo.createNotificationDelivery({ eventId: event.id, habitatId: habitat.id,
      recipientType: "human", recipientId: "user-1", required: true, channels: ["in_app"], ...(cadence ? { cadence } : {}) });
    return { habitat, event, delivery };
  }
  const inDigestGroups = (results: ReturnType<typeof generateDailyDigests>, habitatId: string, recipientId: string) =>
    results.some((r) => r.habitatId === habitatId && r.recipientId === recipientId);

  it("persists the passed cadence; omitted cadence defaults to immediate", () => {
    // GROUND: TASKS T2a bullet 2 (mutation-proof the insert cadence default ⇒
    // test 1 RED); CORE-TASKS §2b edits 1/2/3/4 (column DEFAULT 'immediate',
    // shared `NotificationDelivery.cadence`, repo insert writes input cadence).
    // RED pre-0087: the insert never references the column, so .cadence reads
    // as undefined instead of "daily".
    expect(seedDelivery("daily").delivery.cadence).toBe("daily");
    expect(seedDelivery().delivery.cadence).toBe("immediate");
  });

  it("a required-default delivery with NO recipient subscription is digest-grouped on its persisted cadence", () => {
    // GROUND: PRD N5 end-to-end cadence; DESIGN §4 (required cadence must not
    // be calculated and discarded); CORE-TASKS §2b edit 5 (digest grouping
    // gains persisted-delivery-cadence source) + TASKS T2a bullet 2 (digest
    // union mutation ⇒ test 2 RED). Group membership is the scheduling
    // authority; shouldProcessAtThisTime's wall-clock gate still decides the
    // firing minute (not pinned by this file — no clock stubbing here).
    const { habitat } = seedDelivery("daily"); // recipient user-1 has NO subscription row
    expect(inDigestGroups(generateDailyDigests(), habitat.id, "user-1")).toBe(true);
  });

  it("an immediate-only recipient is never digest-grouped", () => {
    // GROUND: CORE-TASKS §2b fence test 3 — legacy/undeclared inserts keep
    // 'immediate' and never enter digest grouping (no digest replacement).
    // Ceiling (pre-existing digest semantics, unchanged by 0087): processDigestGroup
    // sweeps a group's whole active inbox via getActiveInbox with no per-delivery
    // cadence predicate, so a recipient holding BOTH an immediate and a digested
    // delivery has the immediate one folded into that digest. Filtering by persisted
    // cadence would change legacy subscription-digest behavior (a digest replacement,
    // excluded by PRD §7); the mixed case is a disclosed ceiling, not a guarantee.
    const { habitat } = seedDelivery("immediate");
    expect(inDigestGroups(generateHourlyDigests(), habitat.id, "user-1")).toBe(false);
    expect(inDigestGroups(generateDailyDigests(), habitat.id, "user-1")).toBe(false);
    expect(inDigestGroups(generateWeeklyDigests(), habitat.id, "user-1")).toBe(false);
  });

  it("legacy recipient-subscription grouping is preserved and deduplicated against delivery-cadence groups", () => {
    // GROUND: PRD N5 / DESIGN §2b edit 5 (existing subscription grouping
    // preserved verbatim; delivery-cadence groups deduplicated against it —
    // no double-digest). This is a regression cell, not a mutation-kill cell.
    const { habitat } = seedDelivery("daily");
    subscriptionRepo.createSubscription({ habitatId: habitat.id, scope: "recipient_override",
      recipientType: "human", recipientId: "user-1", eventType: "task.blocked",
      enabled: true, required: false, channels: ["in_app"], cadence: "daily" });
    const results = generateDailyDigests().filter((r) => r.habitatId === habitat.id && r.recipientId === "user-1");
    expect(results).toHaveLength(1); // one merged group, not two
  });

  it("migration 0087 declares the column-level default 'immediate' so populated upgrades and undeclared inserts keep legacy behavior", () => {
    const cols = getDb().all(sql`PRAGMA table_info(notification_deliveries)`) as Array<{ name: string; notnull: number; dflt_value: string | null }>;
    const cadence = cols.find((c) => c.name === "cadence");
    expect(cadence).toBeDefined();
    expect(cadence!.notnull).toBe(1);
    expect(cadence!.dflt_value).toBe("'immediate'");
  });
});
