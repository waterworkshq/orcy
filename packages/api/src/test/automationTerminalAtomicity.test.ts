/**
 * FU2 — crash-atomic terminal bundle, completion-outbox exactly-once, and
 * zero-delivery inbox terminality (stale-lease TOCTOU race lives in
 * `automationTerminalRace.test.ts`).
 *
 * # Terminal bundle atomicity
 * The frozen-revision terminalization (delivery fence CAS + run
 * terminalization + durable completion outbox row + inbox terminality) is ONE
 * `BEGIN IMMEDIATE` transaction. Crash-injection proof:
 *   - an injected mid-bundle failure ROLLS BACK the whole unit (delivery
 *     stays leased, run stays running, inbox stays pending, no outbox row) —
 *     this fails under the old separate-autocommit layout where the delivery
 *     transition had already committed;
 *   - driving the REAL durable API to each crash prefix (lease-only, partial
 *     proof, full proof) then replaying converges: no terminal-but-non-
 *     drainable delivery, no stuck-`running` run, inbox reaches the correct
 *     terminality, and the completion is emitted exactly once (proven by the
 *     outbox row count after repeated drains).
 *
 * # Zero-delivery inbox
 * An admitted inbox with ZERO matching rules terminalizes inside the
 * admission transaction; a stranded pre-fix pending row is swept by the
 * drain pass; replay returns the same.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, initTestDb, getDb } from "../db/index.js";
import {
  notificationEvents,
  automationRunCompletionOutbox,
  taskEvents,
} from "../db/schema/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as revisionRepo from "../repositories/automationRuleRevision.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as deliveryRepo from "../repositories/automationRuleDelivery.js";
import * as outboxRepo from "../repositories/automationRunCompletionOutbox.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import { createNotificationEvent } from "../repositories/notificationEvent.js";
import { attachWorkflow, initWorkflowService } from "../services/workflowService.js";
import type { WorkflowTemplateDefinition } from "../models/index.js";
import {
  admitReleaseShippedEventToInbox,
  drainAutomationInbox,
  getInboxOverview,
} from "../services/automationInboxService.js";
import { onAutomationRunCompleted } from "../services/automationExecutor.js";
import type { AutomationRule } from "@orcy/shared";

vi.mock("../repositories/automationRunCompletionOutbox.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../repositories/automationRunCompletionOutbox.js")>();
  return {
    ...actual,
    enqueueAutomationRunCompletion: vi.fn(((
      ...args: Parameters<typeof actual.enqueueAutomationRunCompletion>
    ) => actual.enqueueAutomationRunCompletion(...args)) as never),
  };
});

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:10:00.000Z"; // T0 + 10min (all short leases expired)

function setupHabitat() {
  const h = boardRepo.createHabitat({ name: "Terminal Atomicity Habitat" });
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
    enabled: boolean;
  }>,
): AutomationRule {
  return ruleRepo.createAutomationRule({
    habitatId,
    name: "Atomicity Rule",
    priority: 0,
    trigger: { type: "event", eventType: "release.shipped" } as never,
    condition: (overrides?.condition ?? { type: "always" }) as never,
    actions: (overrides?.templates ?? ["FIRST", "SECOND"]).map(notifyAction) as never,
    cooldownSeconds: 0,
    maxRunsPerHour: 100,
    enabled: overrides?.enabled ?? true,
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

function countOutboxRows(): number {
  return getDb().select().from(automationRunCompletionOutbox).all().length;
}

describe("FU2: crash-atomic terminal bundle + completion outbox", () => {
  beforeEach(async () => {
    await initTestDb();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    closeDb();
  });

  it("DISCRIMINATOR: a mid-bundle failure ROLLS BACK the whole unit (delivery stays leased), then replay converges", async () => {
    const h = setupHabitat();
    createReleaseRule(h.id, { templates: ["ONLY"] });
    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-atomic-rollback",
      payload: { eventId: "rel-atomic-rollback" },
    });
    const inboxId = deliveryRepo.listInboxEntriesForHabitat(h.id)[0].id;
    const deliveryId = getInboxOverview(inboxId)!.deliveries[0].delivery.id;

    // Crashed worker proved every action (durable receipt), then died right
    // before the terminal bundle.
    const lease = crashAfterLease(deliveryId, T0, 60_000);
    crashAfterProving(deliveryId, lease.fence, 0, { eventId: "evt-crashed" }, T0);
    simulateCrashedNotifyEffect(h.id, "ONLY");

    // Inject a crash INSIDE the terminal bundle (after the delivery
    // transition, before the outbox write). The whole unit must roll back.
    vi.mocked(outboxRepo.enqueueAutomationRunCompletion).mockImplementationOnce(() => {
      throw new Error("injected mid-bundle crash");
    });
    const report = await drainAutomationInbox({ now: T1 });
    expect(report.errors.length).toBeGreaterThan(0);

    // Atomic rollback: NOTHING of the four durable effects committed. The
    // recovery re-lease (its OWN committed tx) holds a fresh fence — the
    // delivery is still leased, NOT terminal.
    const afterCrash = deliveryRepo.getDeliveryById(deliveryId)!;
    expect(afterCrash.state).toBe("leased"); // delivery transition rolled back
    expect(afterCrash.leaseFence).not.toBe(lease.fence); // recovery re-leased
    const runRows = runRepo.listRunsByRule(
      revisionRepo.getRuleRevisionById(afterCrash.ruleRevisionId)!.ruleId,
    );
    // The run row exists (reserved before the bundle) but is NOT terminal.
    if (runRows.runs.length > 0) {
      expect(runRows.runs[0].status).toBe("running");
    }
    expect(getInboxOverview(inboxId)!.inbox.state).toBe("pending"); // inbox not terminal
    expect(countOutboxRows()).toBe(0); // no completion row

    // Replay (no crash, after the recovery re-lease expires) converges:
    // delivery terminal, run terminal, inbox terminal, exactly one outbox row.
    const replay = await drainAutomationInbox({ now: "2026-01-01T00:12:00.000Z" });
    expect(replay.errors).toEqual([]);
    const delivery = deliveryRepo.getDeliveryById(deliveryId)!;
    expect(delivery.state).toBe("terminal");
    expect(delivery.terminalDisposition).toBe("succeeded");
    const finalRuns = runRepo.listRunsByRule(
      revisionRepo.getRuleRevisionById(delivery.ruleRevisionId)!.ruleId,
    );
    expect(finalRuns.runs[0].status).toBe("succeeded");
    expect(getInboxOverview(inboxId)!.inbox.state).toBe("terminal");
    expect(countOutboxRows()).toBe(1);
    expect(renderedTemplates(h.id)).toEqual(["ONLY"]); // proved action NOT rerun
  });

  it("DISCRIMINATOR: completion is emitted EXACTLY once (outbox row count + hook calls stay 1 across repeated drains)", async () => {
    const h = setupHabitat();
    createReleaseRule(h.id, { templates: ["ONLY"] });
    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-atomic-once",
      payload: { eventId: "rel-atomic-once" },
    });
    const inboxId = deliveryRepo.listInboxEntriesForHabitat(h.id)[0].id;
    const deliveryId = getInboxOverview(inboxId)!.deliveries[0].delivery.id;

    // Crashed worker proved the action and died before terminalization.
    const lease = crashAfterLease(deliveryId, T0, 60_000);
    crashAfterProving(deliveryId, lease.fence, 0, { eventId: "evt-crashed" }, T0);
    simulateCrashedNotifyEffect(h.id, "ONLY");

    let hookCalls = 0;
    const unsub = onAutomationRunCompleted(() => {
      hookCalls++;
    });

    const first = await drainAutomationInbox({ now: T1 });
    expect(first.outcomes["stale_resume"]).toBe(1);
    expect(first.outcomes["executed:succeeded"]).toBe(1);
    expect(hookCalls).toBe(1); // delivered once by the outbox deliverer
    expect(countOutboxRows()).toBe(1);

    // Repeated drains: nothing to do, no re-emission.
    await drainAutomationInbox({ now: "2026-01-01T00:20:00.000Z" });
    await drainAutomationInbox({ now: "2026-01-01T00:30:00.000Z" });
    expect(hookCalls).toBe(1);
    expect(countOutboxRows()).toBe(1);

    const delivery = deliveryRepo.getDeliveryById(deliveryId)!;
    expect(delivery.state).toBe("terminal");
    expect(getInboxOverview(inboxId)!.inbox.state).toBe("terminal");
    expect(renderedTemplates(h.id)).toEqual(["ONLY"]); // no duplicate action effect

    unsub();
  });

  it("a lease-only crash (no checkpoints) with a resume-UNSAFE action → attention; a full-proof crash → resume", async () => {
    // Half 1: unproved notify (not resume-safe) → attention_required, never
    // auto-executed, NO completion row, inbox stays pending (visible).
    const h1 = setupHabitat();
    createReleaseRule(h1.id, { templates: ["NOTIFY"] });
    admitReleaseShippedEventToInbox({
      habitatId: h1.id,
      eventId: "rel-att-1",
      payload: { eventId: "rel-att-1" },
    });
    const inbox1 = deliveryRepo.listInboxEntriesForHabitat(h1.id)[0].id;
    const delivery1 = getInboxOverview(inbox1)!.deliveries[0].delivery.id;
    crashAfterLease(delivery1, T0, 60_000);
    const att = await drainAutomationInbox({ now: T1 });
    expect(att.outcomes["attention_required"]).toBe(1);
    expect(deliveryRepo.getDeliveryById(delivery1)!.state).toBe("attention_required");
    expect(countOutboxRows()).toBe(0);
    expect(getInboxOverview(inbox1)!.inbox.state).toBe("pending");

    // Half 2: full proof → resume → executed → terminal + completion row.
    const h2 = setupHabitat();
    createReleaseRule(h2.id, { templates: ["ONLY"] });
    admitReleaseShippedEventToInbox({
      habitatId: h2.id,
      eventId: "rel-res-1",
      payload: { eventId: "rel-res-1" },
    });
    const inbox2 = deliveryRepo.listInboxEntriesForHabitat(h2.id)[0].id;
    const delivery2 = getInboxOverview(inbox2)!.deliveries[0].delivery.id;
    const lease2 = crashAfterLease(delivery2, T0, 60_000);
    crashAfterProving(delivery2, lease2.fence, 0, { eventId: "evt-res" }, T0);
    simulateCrashedNotifyEffect(h2.id, "ONLY");
    const res = await drainAutomationInbox({ now: T1 });
    expect(res.outcomes["executed:succeeded"]).toBe(1);
    expect(deliveryRepo.getDeliveryById(delivery2)!.state).toBe("terminal");
    expect(getInboxOverview(inbox2)!.inbox.state).toBe("terminal");
    expect(countOutboxRows()).toBe(1);
  });

  it("skip and failure terminal paths write the completion outbox row too", async () => {
    // Kill-switch skip: durable terminal skip + skipped completion outbox.
    vi.stubEnv("ORCY_AUTOMATION_EXECUTE_ACTIONS", "false");
    const h = setupHabitat();
    createReleaseRule(h.id);
    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-skip-1",
      payload: { eventId: "rel-skip-1" },
    });
    const inboxId = deliveryRepo.listInboxEntriesForHabitat(h.id)[0].id;
    const deliveryId = getInboxOverview(inboxId)!.deliveries[0].delivery.id;

    let skippedHook = 0;
    const unsub = onAutomationRunCompleted((opts) => {
      if (opts.outcome === "skipped") skippedHook++;
    });

    const skip = await drainAutomationInbox({ now: T0 });
    expect(skip.outcomes["skipped"]).toBe(1);
    const delivery = deliveryRepo.getDeliveryById(deliveryId)!;
    expect(delivery.state).toBe("terminal");
    expect(delivery.terminalDisposition).toBe("skipped:disabled");
    expect(getInboxOverview(inboxId)!.inbox.state).toBe("terminal");
    expect(countOutboxRows()).toBe(1);
    const row = getDb().select().from(automationRunCompletionOutbox).get()!;
    expect(row.outcome).toBe("skipped");
    expect(skippedHook).toBe(1);
    unsub();

    // Condition-stage failure (invalid persisted condition) → failed completion.
    vi.unstubAllEnvs();
    const h2 = setupHabitat();
    createReleaseRule(h2.id, {
      condition: { type: "invalid_tree", child: { type: "always" } },
    });
    admitReleaseShippedEventToInbox({
      habitatId: h2.id,
      eventId: "rel-fail-1",
      payload: { eventId: "rel-fail-1" },
    });
    const inbox2 = deliveryRepo.listInboxEntriesForHabitat(h2.id)[0].id;
    const delivery2 = getInboxOverview(inbox2)!.deliveries[0].delivery.id;
    let failedHook = 0;
    const unsub2 = onAutomationRunCompleted((opts) => {
      if (opts.outcome === "failed") failedHook++;
    });
    const fail = await drainAutomationInbox({ now: T0 });
    expect(fail.outcomes["failed"]).toBe(1);
    const d2 = deliveryRepo.getDeliveryById(delivery2)!;
    expect(d2.state).toBe("terminal");
    expect(d2.terminalDisposition).toContain("failed:condition");
    expect(getInboxOverview(inbox2)!.inbox.state).toBe("terminal");
    expect(failedHook).toBe(1);
    unsub2();
  });
});

describe("FU2: stale-lease attention CAS is bound to the observed fence", () => {
  beforeEach(async () => {
    await initTestDb();
  });

  afterEach(() => closeDb());

  it("DISCRIMINATOR: attention is rejected when the delivery no longer carries the observed fence (re-leased by a newer worker)", () => {
    const h = setupHabitat();
    createReleaseRule(h.id);
    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-fence-att",
      payload: { eventId: "rel-fence-att" },
    });
    const inboxId = deliveryRepo.listInboxEntriesForHabitat(h.id)[0].id;
    const deliveryId = getInboxOverview(inboxId)!.deliveries[0].delivery.id;

    // Worker A leases (expires at T0 + 1s), then "dies".
    const stale = crashAfterLease(deliveryId, T0, 1_000);
    // Worker B re-leases under a NEW fence with an ALREADY-EXPIRED expiry
    // (ttl 0 → lease_expires_at === now). The OLD attention CAS
    // (`state='leased' AND lease_expires_at <= now`) would match B's row and
    // yank a freshly-re-leased delivery to attention; the fence-bound CAS
    // must reject it because B's fence ≠ the observed stale fence.
    const fresh = deliveryRepo.leaseDelivery({
      deliveryId,
      leaseOwner: "fresh-worker",
      now: T1,
      ttlMs: 0,
    });
    expect(fresh.acquired).toBe(true);

    const marked = deliveryRepo.markStaleDeliveryAttention({
      deliveryId,
      fence: stale.fence, // the OBSERVED (superseded) fence
      now: T1,
      reason: "unprovable action",
      proofClassification: "unprovable",
    });
    expect(marked).toBe(false);
    expect(deliveryRepo.getDeliveryById(deliveryId)!.state).toBe("leased");

    // A recovery that observed B's fence CAN mark attention (lease genuinely
    // expired, no newer owner).
    const markedFresh = deliveryRepo.markStaleDeliveryAttention({
      deliveryId,
      fence: fresh.fence,
      now: T1,
      reason: "unprovable action",
      proofClassification: "unprovable",
    });
    expect(markedFresh).toBe(true);
    expect(deliveryRepo.getDeliveryById(deliveryId)!.state).toBe("attention_required");
  });
});

describe("FU2: outbox-delivered completion advances a real workflow gate", () => {
  beforeEach(async () => {
    await initTestDb();
  });

  afterEach(() => closeDb());

  it("a frozen-path run completion delivered via the outbox satisfies an on_automation gate exactly once", async () => {
    const h = setupHabitat();
    const mission = missionRepo.createMission({
      habitatId: h.id,
      title: "Gate Mission",
      createdBy: "user-1",
    });
    const downstream = taskRepo.createTask({
      missionId: mission.id,
      title: "Downstream",
      priority: "low",
      createdBy: "user-1",
    });

    const rule = createReleaseRule(h.id, { templates: ["GATED"] });

    // The gate watches rule id + outcome; scope "either" matches any target.
    const definition: WorkflowTemplateDefinition = {
      gates: [
        {
          upstreamTaskKey: downstream.id,
          downstreamTaskKey: downstream.id,
          gateType: "on_automation",
          matchConfig: { ruleId: rule.id, outcome: "succeeded" },
        },
      ],
    };
    attachWorkflow(mission.id, h.id, definition, {}, "test-author");
    initWorkflowService();

    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-gated-1",
      payload: { eventId: "rel-gated-1" },
    });
    const report = await drainAutomationInbox({ now: T0 });
    expect(report.outcomes["executed:succeeded"]).toBe(1);

    // The completion was persisted in the terminal bundle and delivered by
    // the outbox at the END of the drain → the gate advanced.
    const satisfied = getDb()
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.taskId, downstream.id))
      .all()
      .filter((e) => e.action === "workflow_gate_satisfied");
    expect(satisfied).toHaveLength(1);

    // Repeated drains never re-emit → the gate is not double-satisfied.
    await drainAutomationInbox({ now: "2026-01-01T00:20:00.000Z" });
    await drainAutomationInbox({ now: "2026-01-01T00:30:00.000Z" });
    const afterReplay = getDb()
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.taskId, downstream.id))
      .all()
      .filter((e) => e.action === "workflow_gate_satisfied");
    expect(afterReplay).toHaveLength(1);
    expect(countOutboxRows()).toBe(1);
  });
});

describe("FU2: zero-delivery inbox terminality", () => {
  beforeEach(async () => {
    await initTestDb();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    closeDb();
  });

  it("zero-rule admission terminalizes the inbox IN the admission transaction; replay returns the same", () => {
    const h = setupHabitat();
    const rule = createReleaseRule(h.id);
    ruleRepo.setRuleEnabled(rule.id, false);

    const admitted = admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-zero-1",
      payload: { eventId: "rel-zero-1" },
    });
    expect(admitted.outcome).toBe("admitted");
    expect(admitted.deliveries).toBe(0);
    expect(getInboxOverview(admitted.inboxId)!.inbox.state).toBe("terminal");

    // Replay returns the SAME terminal state.
    const replay = admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-zero-1",
      payload: { eventId: "rel-zero-1" },
    });
    expect(replay.outcome).toBe("replayed");
    expect(replay.deliveries).toBe(0);
    expect(getInboxOverview(admitted.inboxId)!.inbox.state).toBe("terminal");
  });

  it("reconciles already-stranded pending zero-delivery inboxes (drain sweep)", async () => {
    const h = setupHabitat();
    // Simulate a PRE-FIX stranded admission: pending inbox with zero
    // deliveries (raw insert, bypassing the fixed admission path).
    const db = getDb();
    const { sql } = await import("drizzle-orm");
    db.run(sql`INSERT INTO automation_event_inbox (id, event_type, event_id, habitat_id, payload, state, admitted_at)
               VALUES ('stranded-inbox-1', 'release.shipped', 'rel-stranded-1', ${h.id}, '{}', 'pending', ${T0})`);

    const before = getInboxOverview("stranded-inbox-1")!;
    expect(before.inbox.state).toBe("pending");

    const report = await drainAutomationInbox({ now: T1 });
    expect(report.errors).toEqual([]);
    expect(getInboxOverview("stranded-inbox-1")!.inbox.state).toBe("terminal");
  });
});
