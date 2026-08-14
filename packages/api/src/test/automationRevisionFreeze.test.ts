/**
 * Production-path discriminators — immutable rule revisions + inbox freeze.
 *
 * Proves the durable-handoff core: inbox admission freezes the immutable
 * event payload AND the full matched executable rule REVISIONS in one
 * transaction; a later live-rule EDIT or DELETE cannot change what executes.
 * Removing the frozen-revision lookup in the consumer (mutate/revert
 * evidence in the ticket report) must make the freeze tests fail.
 *
 * Success actions use `notify` (durable notification events) because the
 * `release.shipped` trigger normalizes to a HABITAT target and `create_signal`
 * requires mission scope (existing executor semantics — unchanged here).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, initTestDb, getDb } from "../db/index.js";
import { notificationEvents, automationRuleRevisions } from "../db/schema/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as revisionRepo from "../repositories/automationRuleRevision.js";
import {
  admitReleaseShippedEventToInbox,
  drainAutomationInbox,
  getInboxOverview,
} from "../services/automationInboxService.js";
import type { AutomationRule } from "@orcy/shared";

function setupHabitat() {
  const h = boardRepo.createHabitat({ name: "Inbox Freeze Habitat" });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
}

function notifyAction(template: string) {
  return {
    type: "notify",
    template,
    severity: "info",
    recipients: [{ type: "human", userId: "user-1" }],
  };
}

function createReleaseRule(
  habitatId: string,
  overrides?: Partial<{
    templates: string[];
    condition: Record<string, unknown>;
    cooldownSeconds: number;
    maxRunsPerHour: number;
  }>,
): AutomationRule {
  return ruleRepo.createAutomationRule({
    habitatId,
    name: "Release Rule",
    priority: 0,
    trigger: { type: "event", eventType: "release.shipped" } as never,
    condition: (overrides?.condition ?? { type: "always" }) as never,
    actions: (overrides?.templates ?? ["ORIGINAL"]).map(notifyAction) as never,
    cooldownSeconds: overrides?.cooldownSeconds ?? 0,
    maxRunsPerHour: overrides?.maxRunsPerHour ?? 100,
    enabled: true,
    createdBy: "test",
  });
}

/** Rendered templates of automation notification events for the habitat. */
function renderedTemplates(habitatId: string): string[] {
  const db = getDb();
  return db
    .select({ payload: notificationEvents.payload })
    .from(notificationEvents)
    .where(eq(notificationEvents.habitatId, habitatId))
    .all()
    .map((r) => String((r.payload as { renderedTemplate?: unknown })?.renderedTemplate ?? ""));
}

describe("immutable rule revisions + inbox freeze (discriminators)", () => {
  beforeEach(async () => {
    await initTestDb();
  });

  afterEach(() => {
    closeDb();
  });

  it("every rule create/update mints an immutable revision; delete keeps revisions", () => {
    const h = setupHabitat();
    const rule = createReleaseRule(h.id);

    let revisions = revisionRepo.listRuleRevisions(rule.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].revisionNumber).toBe(1);
    expect(revisions[0].enabled).toBe(true);
    expect(revisions[0].actions).toEqual([notifyAction("ORIGINAL")] as never);
    expect(revisions[0].digest).toMatch(/^v1:[0-9a-f]{64}$/);

    ruleRepo.updateAutomationRule(rule.id, {
      actions: [notifyAction("EDITED")] as never,
    });
    ruleRepo.setRuleEnabled(rule.id, false);

    revisions = revisionRepo.listRuleRevisions(rule.id);
    expect(revisions).toHaveLength(3);
    // Descending order; every mutation is a new immutable revision.
    expect(revisions.map((r) => r.revisionNumber)).toEqual([3, 2, 1]);
    expect(revisions[1].actions).toEqual([notifyAction("EDITED")] as never);
    expect(revisions[0].enabled).toBe(false);
    // Earlier revisions are immutable snapshots of their time.
    expect(revisions[2].actions).toEqual([notifyAction("ORIGINAL")] as never);

    // Delete the live rule: revisions survive (delivery history keeps them).
    expect(ruleRepo.deleteAutomationRule(rule.id)).toBe(true);
    expect(ruleRepo.getAutomationRuleById(rule.id)).toBeNull();
    expect(revisionRepo.listRuleRevisions(rule.id)).toHaveLength(3);
    expect(revisionRepo.getRuleRevisionById(revisions[0].id)).not.toBeNull();
  });

  it("admission freezes event payload + matched revisions in one transaction; replay is idempotent", () => {
    const h = setupHabitat();
    const rule = createReleaseRule(h.id);

    const first = admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-evt-1",
      payload: { eventId: "rel-evt-1", releaseId: "rel-1", version: "v1.2.3" },
    });
    expect(first.outcome).toBe("admitted");
    expect(first.deliveries).toBe(1);

    // The frozen delivery binds the FULL immutable revision, not the live id.
    const overview = getInboxOverview(first.inboxId)!;
    expect(overview.inbox.state).toBe("pending");
    expect(overview.inbox.payload).toEqual({
      eventId: "rel-evt-1",
      releaseId: "rel-1",
      version: "v1.2.3",
    });
    const revision = revisionRepo.getRuleRevisionById(
      overview.deliveries[0].delivery.ruleRevisionId,
    )!;
    expect(revision.ruleId).toBe(rule.id);
    expect(revision.actions).toEqual([notifyAction("ORIGINAL")] as never);

    // Replay: same (event_type, event_id) → replayed, original payload WINS,
    // and a rule edited after admission cannot inject a new delivery.
    ruleRepo.updateAutomationRule(rule.id, {
      actions: [notifyAction("POST_ADMIT_EDIT")] as never,
    });
    const replay = admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-evt-1",
      payload: { eventId: "rel-evt-1", releaseId: "rel-1", version: "MUTATED" },
    });
    expect(replay.outcome).toBe("replayed");
    expect(replay.inboxId).toBe(first.inboxId);
    const afterReplay = getInboxOverview(first.inboxId)!;
    expect(afterReplay.deliveries).toHaveLength(1);
    expect(afterReplay.inbox.payload).toEqual({
      eventId: "rel-evt-1",
      releaseId: "rel-1",
      version: "v1.2.3",
    });
  });

  it("DISCRIMINATOR: edit + delete the live rule before consumption → the ORIGINAL revision executes", async () => {
    const h = setupHabitat();
    const rule = createReleaseRule(h.id, { templates: ["ORIGINAL"] });

    const admitted = admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-evt-2",
      payload: { eventId: "rel-evt-2", releaseId: "rel-2" },
    });
    expect(admitted.outcome).toBe("admitted");

    // EDIT the live rule after the freeze…
    ruleRepo.updateAutomationRule(rule.id, {
      actions: [notifyAction("EDITED")] as never,
    });
    // …then DELETE it before consumption.
    ruleRepo.deleteAutomationRule(rule.id);

    const report = await drainAutomationInbox({ now: new Date().toISOString() });
    expect(report.errors).toEqual([]);
    expect(report.leased).toBe(1);
    expect(report.outcomes["executed:succeeded"]).toBe(1);

    // The ORIGINAL frozen action executed — not the edit.
    const templates = renderedTemplates(h.id);
    expect(templates).toContain("ORIGINAL");
    expect(templates).not.toContain("EDITED");

    // Delivery terminal with the run-less path (live rule deleted → no run
    // row can exist; the delivery + checkpoints are the durable history).
    const overview = getInboxOverview(admitted.inboxId)!;
    const delivery = overview.deliveries[0].delivery;
    expect(delivery.state).toBe("terminal");
    expect(delivery.terminalDisposition).toBe("succeeded");
    expect(delivery.automationRunId).toBeNull();
    // Checkpoint for the proved action exists with its durable receipt.
    const checkpoints = overview.deliveries[0].checkpoints;
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].state).toBe("proved");
    expect(checkpoints[0].receipt).toMatchObject({ eventId: expect.any(String) });
    // Inbox terminal when every frozen revision is terminal.
    expect(overview.inbox.state).toBe("terminal");
  });

  it("DISCRIMINATOR: edit the live rule (WITHOUT delete) before consumption → the ORIGINAL revision still executes", async () => {
    const h = setupHabitat();
    const rule = createReleaseRule(h.id, { templates: ["ORIGINAL"] });

    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-evt-2b",
      payload: { eventId: "rel-evt-2b", releaseId: "rel-2b" },
    });

    // EDIT only — the live rule still exists, so a consumer that (wrongly)
    // re-reads the live rule would execute the EDITED actions.
    ruleRepo.updateAutomationRule(rule.id, {
      actions: [notifyAction("EDITED")] as never,
    });

    const report = await drainAutomationInbox({ now: new Date().toISOString() });
    expect(report.errors).toEqual([]);
    expect(report.outcomes["executed:succeeded"]).toBe(1);

    const templates = renderedTemplates(h.id);
    expect(templates).toContain("ORIGINAL");
    expect(templates).not.toContain("EDITED");
  });

  it("inbox is terminal only when EVERY frozen revision delivery is terminal", async () => {
    const h = setupHabitat();
    createReleaseRule(h.id);
    createReleaseRule(h.id, { templates: ["SECOND_RULE"] });

    const admitted = admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-evt-3",
      payload: { eventId: "rel-evt-3" },
    });
    expect(admitted.deliveries).toBe(2);

    // Both deliveries are pending → inbox pending.
    expect(getInboxOverview(admitted.inboxId)!.inbox.state).toBe("pending");

    const report = await drainAutomationInbox({ now: new Date().toISOString() });
    expect(report.leased).toBe(2);
    expect(report.outcomes["executed:succeeded"]).toBe(2);
    expect(getInboxOverview(admitted.inboxId)!.inbox.state).toBe("terminal");
    expect(renderedTemplates(h.id).sort()).toEqual(["ORIGINAL", "SECOND_RULE"]);
  });

  it("legacy rule without revisions is backfilled inside the admission transaction", () => {
    const h = setupHabitat();
    const rule = createReleaseRule(h.id);

    // Simulate a pre-revision-feature rule: wipe its revisions.
    const db = getDb();
    db.delete(automationRuleRevisions).where(eq(automationRuleRevisions.ruleId, rule.id)).run();
    expect(revisionRepo.listRuleRevisions(rule.id)).toHaveLength(0);

    const admitted = admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-evt-4",
      payload: { eventId: "rel-evt-4" },
    });
    expect(admitted.outcome).toBe("admitted");
    expect(admitted.deliveries).toBe(1);

    // The delivery's frozen revision was minted from the live rule state
    // inside the same admission transaction.
    const overview = getInboxOverview(admitted.inboxId)!;
    const revision = revisionRepo.getRuleRevisionById(
      overview.deliveries[0].delivery.ruleRevisionId,
    )!;
    expect(revision.ruleId).toBe(rule.id);
    expect(revision.authorType).toBe("system");
    expect(revision.actions).toEqual([notifyAction("ORIGINAL")] as never);
  });

  it("disabled rules are not matched at admission (enabled/match inputs are frozen too)", () => {
    const h = setupHabitat();
    const rule = createReleaseRule(h.id);
    ruleRepo.setRuleEnabled(rule.id, false);

    const admitted = admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-evt-5",
      payload: { eventId: "rel-evt-5" },
    });
    expect(admitted.outcome).toBe("admitted");
    expect(admitted.deliveries).toBe(0);
    void rule;
  });
});
