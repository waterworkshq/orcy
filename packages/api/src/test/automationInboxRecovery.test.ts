/**
 * Production-path discriminators — stale-lease proof-aware recovery,
 * leases/fences, operator dispositions, and guard preservation on the
 * frozen-revision pipeline.
 *
 * Crash windows are simulated exactly as they would persist after process
 * loss: a lease is taken with the repo CAS, checkpoints are recorded through
 * the SAME fenced primitives a live worker uses, and then the "worker dies"
 * (nothing else happens) until the lease expires and `drainAutomationInbox`
 * classifies it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, initTestDb, getDb } from "../db/index.js";
import { notificationEvents } from "../db/schema/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as revisionRepo from "../repositories/automationRuleRevision.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as deliveryRepo from "../repositories/automationRuleDelivery.js";
import { createNotificationEvent } from "../repositories/notificationEvent.js";
import {
  admitReleaseShippedEventToInbox,
  drainAutomationInbox,
  waiveAutomationDelivery,
  createAutomationDeliverySuccessorGeneration,
  getInboxOverview,
} from "../services/automationInboxService.js";
import type { AutomationRule } from "@orcy/shared";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:10:00.000Z"; // T0 + 10min (all short leases expired)

function setupHabitat() {
  const h = boardRepo.createHabitat({ name: "Inbox Recovery Habitat" });
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
    name: "Recovery Rule",
    priority: 0,
    trigger: { type: "event", eventType: "release.shipped" } as never,
    condition: (overrides?.condition ?? { type: "always" }) as never,
    actions: (overrides?.templates ?? ["FIRST", "SECOND"]).map(notifyAction) as never,
    cooldownSeconds: overrides?.cooldownSeconds ?? 0,
    maxRunsPerHour: overrides?.maxRunsPerHour ?? 100,
    enabled: true,
    createdBy: "test",
  });
}

function renderedTemplates(habitatId: string): string[] {
  const db = getDb();
  return db
    .select({ payload: notificationEvents.payload })
    .from(notificationEvents)
    .where(eq(notificationEvents.habitatId, habitatId))
    .all()
    .map((r) => String((r.payload as { renderedTemplate?: unknown })?.renderedTemplate ?? ""));
}

/** Simulate the crashed worker's durable external effect (its notify landed). */
function simulateCrashedNotifyEffect(habitatId: string, template: string) {
  createNotificationEvent({
    habitatId,
    eventType: "automation.rule_matched",
    sourceType: "automation",
    severity: "info",
    title: "crashed-worker-effect",
    body: "crashed-worker-effect",
    payload: { renderedTemplate: template },
    createdByType: "automation",
  });
}

function firstDeliveryId(inboxId: string): string {
  return getInboxOverview(inboxId)!.deliveries[0].delivery.id;
}

/** Simulate a worker that leased the delivery and died (no checkpoints). */
function crashAfterLease(deliveryId: string, now = T0, ttlMs = 60_000) {
  return deliveryRepo.leaseDelivery({ deliveryId, leaseOwner: "crashed-worker", now, ttlMs });
}

/** Simulate a worker that proved action `index` (durable receipt) and died. */
function crashAfterProving(
  deliveryId: string,
  fence: string,
  actionIndex: number,
  receipt: Record<string, unknown>,
  now = T0,
) {
  const delivery = deliveryRepo.getDeliveryById(deliveryId)!;
  const revision = revisionRepo.getRuleRevisionById(delivery.ruleRevisionId)!;
  const checkpoint = deliveryRepo.ensureCheckpointRow({
    deliveryId,
    actionIndex,
    actionKey: deliveryRepo.computeActionKey(revision.actions[actionIndex]),
    actionType: String(revision.actions[actionIndex].type),
    now,
  });
  const ok = deliveryRepo.recordCheckpointOutcome({
    checkpointId: checkpoint.id,
    deliveryId,
    fence,
    state: "proved",
    receipt,
    now,
  });
  if (!ok) throw new Error("simulated checkpoint proof was rejected by the fence");
  return checkpoint;
}

describe("stale-lease proof-aware recovery + operator dispositions", () => {
  beforeEach(async () => {
    await initTestDb();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    closeDb();
  });

  it("a LIVE lease keeps the delivery pending — the drainer leaves it alone", async () => {
    const h = setupHabitat();
    createReleaseRule(h.id);
    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-live-lease",
      payload: { eventId: "rel-live-lease" },
    });
    const deliveryId = firstDeliveryId(deliveryRepo.listInboxEntriesForHabitat(h.id)[0].id);
    // A live worker holds the lease with a far-future expiry.
    crashAfterLease(deliveryId, T0, 3_600_000);

    const report = await drainAutomationInbox({ now: T0 });
    expect(report.considered).toBe(0); // not drainable at all
    expect(deliveryRepo.getDeliveryById(deliveryId)!.state).toBe("leased");
    expect(renderedTemplates(h.id)).toEqual([]); // nothing executed
  });

  it("DISCRIMINATOR: all proved checkpoints → resume the SAME generation under a new fence; proved actions never rerun", async () => {
    const h = setupHabitat();
    createReleaseRule(h.id, { templates: ["ONLY"] });
    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-resume",
      payload: { eventId: "rel-resume" },
    });
    const inboxId = deliveryRepo.listInboxEntriesForHabitat(h.id)[0].id;
    const deliveryId = firstDeliveryId(inboxId);

    // The crashed worker fully proved action 0 (its notification event is
    // durable), then died before terminalizing.
    const lease = crashAfterLease(deliveryId, T0, 60_000);
    crashAfterProving(deliveryId, lease.fence, 0, { eventId: "evt-crashed" }, T0);
    simulateCrashedNotifyEffect(h.id, "ONLY");
    expect(renderedTemplates(h.id)).toEqual(["ONLY"]); // crash happened after the effect

    const report = await drainAutomationInbox({ now: T1 });
    expect(report.outcomes["stale_resume"]).toBe(1);
    expect(report.outcomes["executed:succeeded"]).toBe(1);

    const delivery = deliveryRepo.getDeliveryById(deliveryId)!;
    expect(delivery.state).toBe("terminal");
    expect(delivery.generation).toBe(1); // SAME generation — proof-backed resume
    expect(delivery.leaseFence).not.toBe(lease.fence); // under a NEW fence
    // The proved action was NOT rerun: exactly one notification event.
    expect(renderedTemplates(h.id)).toEqual(["ONLY"]);
    expect(getInboxOverview(inboxId)!.inbox.state).toBe("terminal");
  });

  it("DISCRIMINATOR: unproved non-idempotent action → attention_required, NEVER auto-executed", async () => {
    const h = setupHabitat();
    const rule = ruleRepo.createAutomationRule({
      habitatId: h.id,
      name: "Webhook Rule",
      priority: 0,
      trigger: { type: "event", eventType: "release.shipped" } as never,
      condition: { type: "always" } as never,
      actions: [
        notifyAction("FIRST"),
        { type: "call_webhook", url: "https://example.test/hook" },
      ] as never,
      cooldownSeconds: 0,
      maxRunsPerHour: 100,
      enabled: true,
      createdBy: "test",
    });
    void rule;
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-attention",
      payload: { eventId: "rel-attention" },
    });
    const inboxId = deliveryRepo.listInboxEntriesForHabitat(h.id)[0].id;
    const deliveryId = firstDeliveryId(inboxId);

    // Worker crashed after proving the idempotent action 0, BEFORE the
    // non-idempotent webhook (the dangerous window: the webhook may or may
    // not have been called).
    const lease = crashAfterLease(deliveryId, T0, 60_000);
    crashAfterProving(deliveryId, lease.fence, 0, { eventId: "evt-first" }, T0);

    const report = await drainAutomationInbox({ now: T1 });
    expect(report.outcomes["attention_required"]).toBe(1);
    expect(report.leased).toBe(0); // attention is classified BEFORE leasing

    const delivery = deliveryRepo.getDeliveryById(deliveryId)!;
    expect(delivery.state).toBe("attention_required");
    expect(delivery.proofClassification).toBe("unprovable");
    expect(delivery.terminalDetail).toContain("call_webhook");
    // NEVER auto-executed: the webhook was not called by recovery.
    expect(fetchSpy).not.toHaveBeenCalled();
    // attention is visible and is NOT success — inbox stays pending.
    const overview = getInboxOverview(inboxId)!;
    expect(overview.inbox.state).toBe("pending");
    expect(overview.deliveries[0].delivery.state).toBe("attention_required");
  });

  it("DISCRIMINATOR: a stale fence cannot terminalize while a newer lease owns the delivery", async () => {
    const h = setupHabitat();
    createReleaseRule(h.id);
    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-fence-cas",
      payload: { eventId: "rel-fence-cas" },
    });
    const inboxId = deliveryRepo.listInboxEntriesForHabitat(h.id)[0].id;
    const deliveryId = firstDeliveryId(inboxId);

    // Worker 1 leases (short TTL) and dies; the lease expires.
    const stale = crashAfterLease(deliveryId, T0, 60_000);

    // Worker 2 re-leases under a NEW fence (the recovery path).
    const fresh = deliveryRepo.leaseDelivery({
      deliveryId,
      leaseOwner: "fresh-worker",
      now: T1,
      ttlMs: 60_000,
    });
    expect(fresh.acquired).toBe(true);
    expect(fresh.fence).not.toBe(stale.fence);

    // The stale worker terminalizes with its superseded fence → REJECTED
    // (row is leased under the fresh fence).
    expect(
      deliveryRepo.transitionLeasedDelivery({
        deliveryId,
        fence: stale.fence,
        targetState: "terminal",
        terminalDisposition: "succeeded",
        now: T1,
      }),
    ).toBe(false);
    expect(deliveryRepo.getDeliveryById(deliveryId)!.state).toBe("leased");

    // The fresh fence owns the transition.
    expect(
      deliveryRepo.transitionLeasedDelivery({
        deliveryId,
        fence: fresh.fence,
        targetState: "terminal",
        terminalDisposition: "succeeded",
        now: T1,
      }),
    ).toBe(true);
    expect(deliveryRepo.getDeliveryById(deliveryId)!.state).toBe("terminal");
  });

  it("operator waive is audited, resolves attention, and terminalizes the inbox; non-attention waive conflicts", async () => {
    const h = setupHabitat();
    createReleaseRule(h.id, { templates: ["FIRST", "SECOND"] });
    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-waive",
      payload: { eventId: "rel-waive" },
    });
    const inboxId = deliveryRepo.listInboxEntriesForHabitat(h.id)[0].id;
    const deliveryId = firstDeliveryId(inboxId);

    // Waive requires attention_required first (in-function source-state guard).
    const premature = waiveAutomationDelivery({
      deliveryId,
      actorType: "human",
      actorId: "user-1",
      reason: "premature",
    });
    expect(premature.outcome).toBe("conflict");

    // Produce a genuine attention state: crash mid-generation (action 1
    // unproved, notify declares no idempotency contract).
    const lease = crashAfterLease(deliveryId, T0, 60_000);
    crashAfterProving(deliveryId, lease.fence, 0, { eventId: "evt-0" }, T0);
    await drainAutomationInbox({ now: T1 });
    expect(deliveryRepo.getDeliveryById(deliveryId)!.state).toBe("attention_required");

    const waived = waiveAutomationDelivery({
      deliveryId,
      actorType: "human",
      actorId: "user-1",
      reason: "externally reconciled — provider confirmed single delivery",
    });
    expect(waived.outcome).toBe("waived");

    // Audited in the append-only ledger.
    const dispositions = deliveryRepo.listDispositionsForDelivery(deliveryId);
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0].kind).toBe("waive");
    expect(dispositions[0].actorId).toBe("user-1");
    expect(dispositions[0].reason).toContain("reconciled");

    // Waived counts toward inbox terminality.
    expect(getInboxOverview(inboxId)!.inbox.state).toBe("terminal");
    // Double waive conflicts (no longer attention_required).
    const again = waiveAutomationDelivery({
      deliveryId,
      actorType: "human",
      actorId: "user-1",
      reason: "again",
    });
    expect(again.outcome).toBe("conflict");
  });

  it("DISCRIMINATOR: risk-acknowledged successor generation reruns ONLY the unresolved actions; stale workers cannot complete it", async () => {
    const h = setupHabitat();
    createReleaseRule(h.id, { templates: ["FIRST", "SECOND"] });
    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-successor",
      payload: { eventId: "rel-successor" },
    });
    const inboxId = deliveryRepo.listInboxEntriesForHabitat(h.id)[0].id;
    const deliveryId = firstDeliveryId(inboxId);

    // Crash after proving action 0; action 1 unproved → attention.
    const lease = crashAfterLease(deliveryId, T0, 60_000);
    crashAfterProving(deliveryId, lease.fence, 0, { eventId: "evt-0" }, T0);
    simulateCrashedNotifyEffect(h.id, "FIRST");
    await drainAutomationInbox({ now: T1 });
    expect(deliveryRepo.getDeliveryById(deliveryId)!.state).toBe("attention_required");
    expect(renderedTemplates(h.id)).toEqual(["FIRST"]);

    // Risk acknowledgement is mandatory.
    const noAck = createAutomationDeliverySuccessorGeneration({
      deliveryId,
      actorType: "human",
      actorId: "user-1",
      reason: "retry",
      ackDuplicateRisk: false,
    });
    expect(noAck.outcome).toBe("risk_ack_required");

    const successor = createAutomationDeliverySuccessorGeneration({
      deliveryId,
      actorType: "human",
      actorId: "user-1",
      reason: "provider reconciliation confirmed action 1 never landed",
      ackDuplicateRisk: true,
    });
    expect(successor.outcome).toBe("created");
    if (successor.outcome !== "created") throw new Error("unreachable");
    expect(successor.generation).toBe(2);

    // Predecessor became terminal/superseded (its proved receipt immutable).
    const predecessor = deliveryRepo.getDeliveryById(deliveryId)!;
    expect(predecessor.state).toBe("terminal");
    expect(predecessor.terminalDisposition).toBe("superseded");
    expect(
      deliveryRepo.listCheckpointsForDelivery(deliveryId).find((c) => c.actionIndex === 0)!.receipt,
    ).toEqual({ eventId: "evt-0" });

    // The successor carried the proved checkpoint forward.
    const successorDelivery = deliveryRepo.getDeliveryById(
      successor.outcome === "created" ? successor.deliveryId : "",
    )!;
    expect(successorDelivery.predecessorDeliveryId).toBe(deliveryId);
    const carried = deliveryRepo
      .listCheckpointsForDelivery(successorDelivery.id)
      .find((c) => c.actionIndex === 0)!;
    expect(carried.state).toBe("proved");
    expect(carried.receipt).toEqual({ eventId: "evt-0" });
    expect(carried.predecessorCheckpointId).not.toBeNull();

    // STALE WORKER: the crashed worker's old fence can neither complete the
    // predecessor (no longer leased) nor forge proof into the successor.
    expect(
      deliveryRepo.transitionLeasedDelivery({
        deliveryId,
        fence: lease.fence,
        targetState: "terminal",
        terminalDisposition: "succeeded",
        now: T1,
      }),
    ).toBe(false);
    const forged = deliveryRepo.ensureCheckpointRow({
      deliveryId: successorDelivery.id,
      actionIndex: 1,
      actionKey: deliveryRepo.computeActionKey({ type: "notify" }),
      actionType: "notify",
      now: T1,
    });
    expect(
      deliveryRepo.recordCheckpointOutcome({
        checkpointId: forged.id,
        deliveryId: successorDelivery.id,
        fence: lease.fence, // stale fence from the crashed generation-1 worker
        state: "proved",
        receipt: { forged: true },
        now: T1,
      }),
    ).toBe(false);

    // Audited.
    const dispositions = deliveryRepo.listDispositionsForDelivery(deliveryId);
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0].kind).toBe("successor_generation");
    expect(dispositions[0].outcome).toBe("successor_generation_2");

    // Drain the successor: proved action 0 is NOT rerun; action 1 executes.
    const report = await drainAutomationInbox({ now: T1 });
    expect(report.outcomes["executed:succeeded"]).toBe(1);
    expect(renderedTemplates(h.id).sort()).toEqual(["FIRST", "SECOND"]);
    expect(deliveryRepo.getDeliveryById(successorDelivery.id)!.state).toBe("terminal");
    expect(getInboxOverview(inboxId)!.inbox.state).toBe("terminal");
  });

  // -------------------------------------------------------------------------
  // Guards preserved on the frozen pipeline (the adapter must not regress
  // cooldown / rate / condition / kill-switch ordering).
  // -------------------------------------------------------------------------

  it("kill switch: frozen delivery durably skips disabled (NOT success)", async () => {
    vi.stubEnv("ORCY_AUTOMATION_EXECUTE_ACTIONS", "false");
    const h = setupHabitat();
    createReleaseRule(h.id);
    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-kill",
      payload: { eventId: "rel-kill" },
    });
    const inboxId = deliveryRepo.listInboxEntriesForHabitat(h.id)[0].id;
    const deliveryId = firstDeliveryId(inboxId);

    const report = await drainAutomationInbox({ now: T0 });
    expect(report.outcomes["skipped"]).toBe(1);
    const delivery = deliveryRepo.getDeliveryById(deliveryId)!;
    expect(delivery.state).toBe("terminal");
    expect(delivery.terminalDisposition).toBe("skipped:disabled");
    expect(renderedTemplates(h.id)).toEqual([]);
    expect(getInboxOverview(inboxId)!.inbox.state).toBe("terminal");
  });

  it("condition gate: frozen revision's condition is evaluated (false → durable skip)", async () => {
    const h = setupHabitat();
    createReleaseRule(h.id, { condition: { type: "not", child: { type: "always" } } });
    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-cond",
      payload: { eventId: "rel-cond" },
    });
    const inboxId = deliveryRepo.listInboxEntriesForHabitat(h.id)[0].id;
    const deliveryId = firstDeliveryId(inboxId);

    const report = await drainAutomationInbox({ now: T0 });
    expect(report.outcomes["skipped"]).toBe(1);
    const delivery = deliveryRepo.getDeliveryById(deliveryId)!;
    expect(delivery.terminalDisposition).toBe("skipped:condition_false");
    expect(renderedTemplates(h.id)).toEqual([]);
  });

  it("cooldown: a recent successful run with the same fingerprint durably skips the delivery", async () => {
    const h = setupHabitat();
    const rule = createReleaseRule(h.id, { cooldownSeconds: 3600 });

    // A prior successful run with the SAME fingerprint the frozen trigger
    // will produce (triggerType release.shipped, triggerEventId, habitat target).
    const { run } = runRepo.startRuleRun({
      ruleId: rule.id,
      habitatId: h.id,
      triggerType: "release.shipped",
      triggerEventId: "rel-cool",
      targetType: "habitat",
      targetId: h.id,
      now: T0,
    });
    runRepo.finishRuleRun(run.id, { status: "succeeded", finishedAt: T0 });

    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-cool",
      payload: { eventId: "rel-cool" },
    });
    const inboxId = deliveryRepo.listInboxEntriesForHabitat(h.id)[0].id;
    const deliveryId = firstDeliveryId(inboxId);

    const report = await drainAutomationInbox({ now: T1 });
    expect(report.outcomes["skipped"]).toBe(1);
    expect(deliveryRepo.getDeliveryById(deliveryId)!.terminalDisposition).toBe("skipped:cooldown");
    expect(renderedTemplates(h.id)).toEqual([]);
  });

  it("rate cap: admitted-attempt hourly cap durably skips the delivery", async () => {
    const h = setupHabitat();
    const rule = createReleaseRule(h.id, { maxRunsPerHour: 1 });

    // One admitted run in the window (different triggerEventId → different
    // fingerprint, so cooldown does not fire; only the cap does).
    const { run } = runRepo.startRuleRun({
      ruleId: rule.id,
      habitatId: h.id,
      triggerType: "release.shipped",
      triggerEventId: "some-other-release",
      targetType: "habitat",
      targetId: h.id,
      now: T0,
    });
    runRepo.finishRuleRun(run.id, { status: "succeeded", finishedAt: T0 });

    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-rate",
      payload: { eventId: "rel-rate" },
    });
    const inboxId = deliveryRepo.listInboxEntriesForHabitat(h.id)[0].id;
    const deliveryId = firstDeliveryId(inboxId);

    const report = await drainAutomationInbox({ now: T1 });
    expect(report.outcomes["skipped"]).toBe(1);
    expect(deliveryRepo.getDeliveryById(deliveryId)!.terminalDisposition).toBe(
      "skipped:rate_limited",
    );
    expect(renderedTemplates(h.id)).toEqual([]);
  });

  it("DISCRIMINATOR: resume after partial proof ignores a later kill switch and finishes remaining actions", async () => {
    const h = setupHabitat();
    ruleRepo.createAutomationRule({
      habitatId: h.id,
      name: "Recovery Rule",
      priority: 0,
      trigger: { type: "event", eventType: "release.shipped" } as never,
      condition: { type: "always" } as never,
      actions: [
        notifyAction("FIRST"),
        { type: "mark_risk", level: "high", reason: "resume leftover" },
      ] as never,
      cooldownSeconds: 0,
      maxRunsPerHour: 100,
      enabled: true,
      createdBy: "test",
    });
    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-resume-kill",
      payload: { eventId: "rel-resume-kill" },
    });
    const inboxId = deliveryRepo.listInboxEntriesForHabitat(h.id)[0].id;
    const deliveryId = firstDeliveryId(inboxId);

    const lease = crashAfterLease(deliveryId, T0, 60_000);
    crashAfterProving(deliveryId, lease.fence, 0, { eventId: "evt-first" }, T0);
    simulateCrashedNotifyEffect(h.id, "FIRST");

    vi.stubEnv("ORCY_AUTOMATION_EXECUTE_ACTIONS", "false");
    const report = await drainAutomationInbox({ now: T1 });
    expect(report.outcomes["stale_resume"]).toBe(1);
    expect(report.outcomes["skipped"]).toBeUndefined();
    expect(deliveryRepo.getDeliveryById(deliveryId)!.terminalDisposition).not.toBe(
      "skipped:disabled",
    );
    expect(renderedTemplates(h.id)).toEqual(["FIRST"]);
  });

  it("DISCRIMINATOR: zero-proof stale lease NEVER resumes — admission guards are not provably passed", async () => {
    const h = setupHabitat();
    ruleRepo.createAutomationRule({
      habitatId: h.id,
      name: "Zero-Proof Rule",
      priority: 0,
      trigger: { type: "event", eventType: "release.shipped" } as never,
      condition: { type: "always" } as never,
      actions: [
        { type: "mark_risk", level: "high", reason: "first" },
        { type: "mark_risk", level: "low", reason: "second" },
      ] as never,
      cooldownSeconds: 0,
      maxRunsPerHour: 100,
      enabled: true,
      createdBy: "test",
    });
    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-zero-proof",
      payload: { eventId: "rel-zero-proof" },
    });
    const inboxId = deliveryRepo.listInboxEntriesForHabitat(h.id)[0].id;
    const deliveryId = firstDeliveryId(inboxId);

    // Worker crashed after leasing, BEFORE any guard evaluation or checkpoint
    // ran. Every action is resume-safe, but resume-safety alone must not
    // authorize bypassing the admission guards without durable proof.
    crashAfterLease(deliveryId, T0, 60_000);

    // Kill switch ON: a resume here would bypass it and execute the actions.
    vi.stubEnv("ORCY_AUTOMATION_EXECUTE_ACTIONS", "false");
    const report = await drainAutomationInbox({ now: T1 });
    expect(report.outcomes["attention_required"]).toBe(1);
    expect(report.outcomes["stale_resume"]).toBeUndefined();
    expect(report.leased).toBe(0);

    const delivery = deliveryRepo.getDeliveryById(deliveryId)!;
    expect(delivery.state).toBe("attention_required");
    expect(delivery.proofClassification).toBe("unprovable");
    expect(delivery.state).not.toBe("terminal");
  });

  it("recordCheckpointOutcome cannot prove or fail a checkpoint owned by another delivery", async () => {
    const h = setupHabitat();
    createReleaseRule(h.id, { templates: ["ONLY"] });
    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-ckpt-a",
      payload: { eventId: "rel-ckpt-a" },
    });
    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-ckpt-b",
      payload: { eventId: "rel-ckpt-b" },
    });
    const deliveries = deliveryRepo
      .listInboxEntriesForHabitat(h.id)
      .flatMap((e) => deliveryRepo.listDeliveriesForInbox(e.id));
    expect(deliveries).toHaveLength(2);
    const [a, b] = deliveries;
    const leaseA = crashAfterLease(a.id, T0, 60_000);
    const leaseB = crashAfterLease(b.id, T0, 60_000);
    const proved = crashAfterProving(a.id, leaseA.fence, 0, { eventId: "owned-by-a" }, T0);

    const hijack = deliveryRepo.recordCheckpointOutcome({
      checkpointId: proved.id,
      deliveryId: b.id,
      fence: leaseB.fence,
      state: "failed",
      now: T1,
    });
    expect(hijack).toBe(false);
    const still = deliveryRepo.listCheckpointsForDelivery(a.id);
    expect(still[0].state).toBe("proved");
    expect(still[0].receipt).toEqual({ eventId: "owned-by-a" });
  });

  it("refuses to prove a checkpoint without a receipt", async () => {
    const h = setupHabitat();
    createReleaseRule(h.id, { templates: ["ONLY"] });
    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-no-receipt",
      payload: { eventId: "rel-no-receipt" },
    });
    const deliveryId = firstDeliveryId(deliveryRepo.listInboxEntriesForHabitat(h.id)[0].id);
    const lease = crashAfterLease(deliveryId, T0, 60_000);
    const delivery = deliveryRepo.getDeliveryById(deliveryId)!;
    const revision = revisionRepo.getRuleRevisionById(delivery.ruleRevisionId)!;
    const checkpoint = deliveryRepo.ensureCheckpointRow({
      deliveryId,
      actionIndex: 0,
      actionKey: deliveryRepo.computeActionKey(revision.actions[0]),
      actionType: String(revision.actions[0].type),
      now: T0,
    });
    expect(
      deliveryRepo.recordCheckpointOutcome({
        checkpointId: checkpoint.id,
        deliveryId,
        fence: lease.fence,
        state: "proved",
        now: T0,
      }),
    ).toBe(false);
    expect(deliveryRepo.listCheckpointsForDelivery(deliveryId)[0].state).toBe("pending");
  });

  it("frozen inbox eventId is the trigger identity when the payload omits eventId", async () => {
    const h = setupHabitat();
    const rule = createReleaseRule(h.id, { cooldownSeconds: 3600, templates: ["ONLY"] });
    const { run } = runRepo.startRuleRun({
      ruleId: rule.id,
      habitatId: h.id,
      triggerType: "release.shipped",
      triggerEventId: "rel-frozen-id",
      targetType: "habitat",
      targetId: h.id,
      now: T0,
    });
    runRepo.finishRuleRun(run.id, { status: "succeeded", finishedAt: T0 });

    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-frozen-id",
      payload: { version: "1.0.0" },
    });
    const inboxId = deliveryRepo.listInboxEntriesForHabitat(h.id)[0].id;
    const deliveryId = firstDeliveryId(inboxId);
    const report = await drainAutomationInbox({ now: T1 });
    expect(report.outcomes["skipped"]).toBe(1);
    expect(deliveryRepo.getDeliveryById(deliveryId)!.terminalDisposition).toBe("skipped:cooldown");
    expect(renderedTemplates(h.id)).toEqual([]);
  });
});
