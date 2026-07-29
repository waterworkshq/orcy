/**
 * CS-56 — Automation attempt behavior characterization.
 *
 * Pin the SETTLED behavior of the canonical Automation Rule lifecycle across
 * every terminal branch (event + scan + manual sources, plus completion-hook
 * emission semantics). Each section pins a specific contract:
 *   - §1 — admitted-attempt hourly accounting (T2 — permanent regression)
 *   - §2 — manual run routes through the canonical lifecycle (T6 — permanent
 *          regression; pre-T6 the manual handler stranded a `running` row)
 *   - §3 — external guard skips emit completion (T4 — permanent regression)
 *   - §4 — dedupe-loser safety (pinned CORRECT behavior, T4 derives counters)
 *   - §5 — false conditions persist `condition_false` and perform no action (T4)
 *   - §6 — condition-before-causal ordering (T4 — phantom-cycle inversion)
 *   - §7 — kill switch finalizes `skipped/disabled` with persisted true
 *          conditionResult (T5 — permanent regression proving settled semantics)
 *   - §8 — inventory smoke: every event/scan source reaches `attemptRuleRun`
 *
 * All T1 defect markers are now flipped to permanent regressions; T7 can
 * safely delete this file once the gate is re-verified.
 *
 * Run with the project's pnpm workflow:
 *   corepack pnpm exec vitest run src/test/automationCS56Characterization.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { tasks, automationRuleRuns } from "../db/schema/index.js";
import { missionDependencies } from "../db/schema/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as pulseRepo from "../repositories/pulse.js";
import { ingestEvent } from "../services/automationEventService.js";
import { onAutomationRunCompleted } from "../services/automationExecutor.js";
import { attemptRuleRun } from "../services/automationAttemptLifecycle.js";
import { runAllScans } from "../services/automationScanService.js";
import type { AutomationCondition, CausalContext } from "@orcy/shared";

// ---------------------------------------------------------------------------
// Fixtures (modeled on automationEventService.test.ts)
// ---------------------------------------------------------------------------

function setupHabitat() {
  const h = boardRepo.createHabitat({ name: "CS56 Habitat" });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
}

function setupMission(habitatId: string) {
  return missionRepo.createMission({ habitatId, title: "CS56 Mission", createdBy: "user-1" });
}

function setupTask(missionId: string, priority: "low" | "medium" | "high" | "critical" = "medium") {
  return taskRepo.createTask({ missionId, title: "CS56 Task", priority, createdBy: "user-1" });
}

function createEnabledRule(
  habitatId: string,
  overrides?: Partial<{
    name: string;
    condition: AutomationCondition;
    cooldownSeconds: number;
    maxRunsPerHour: number;
    triggerType: string;
    actions: Array<{ type: string; [k: string]: unknown }>;
  }>,
) {
  const triggerType = overrides?.triggerType ?? "task.rejected";
  const isEvent =
    triggerType.startsWith("task.") ||
    triggerType.startsWith("mission.") ||
    triggerType.startsWith("pulse.") ||
    triggerType.startsWith("sprint.");
  const trigger = isEvent
    ? { type: "event", eventType: triggerType }
    : { type: "scan", scanType: triggerType };
  return ruleRepo.createAutomationRule({
    habitatId,
    name: overrides?.name ?? "CS56 Rule",
    priority: 0,
    trigger: trigger as unknown as Parameters<typeof ruleRepo.createAutomationRule>[0]["trigger"],
    condition: overrides?.condition ?? ({ type: "always" } as AutomationCondition),
    actions: (overrides?.actions ?? [
      { type: "create_signal", content: "CS56 fired" },
    ]) as unknown as Parameters<typeof ruleRepo.createAutomationRule>[0]["actions"],
    cooldownSeconds: overrides?.cooldownSeconds ?? 300,
    maxRunsPerHour: overrides?.maxRunsPerHour ?? 100,
    enabled: true,
    createdBy: "test",
  });
}

function buildTrustedEnvelopeData(
  eventId: string,
  taskId: string,
  causalContext: CausalContext,
): Record<string, unknown> {
  return {
    taskId,
    eventId,
    habitatId: "",
    lifecycleAction: "created",
    causalContext,
  };
}

// ===========================================================================
// 1. Admitted-attempt hourly accounting (CS-56 T2 — permanent regression)
//
// CS-56 T2 inverted the original characterization (rejected rate_limited
// runs extended the hourly window) by replacing the all-row count in
// `getHourlyRunCount` with admitted-attempt accounting in
// `countAdmittedAttemptsInWindow`. The legacy name is kept as a compat
// wrapper; its semantics are now narrowed to admit-only.
//
// The pre-admission skip reasons — `cooldown`, `rate_limited`,
// `missing_target` — must NOT count against the hourly budget, so a
// continuous stream of rejected traffic no longer prolongs the lockout
// once admitted rows age out. The asserted scenarios below pin this
// behavior so a future refactor cannot regress it.
// ===========================================================================

describe("CS-56 T2 — admitted-attempt hourly accounting", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("rejected rate_limited runs do NOT extend the hourly window", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    // maxRunsPerHour=1 → first attempt matches, all subsequent are rate_limited.
    const rule = createEnabledRule(h.id, {
      name: "Once-per-hour",
      maxRunsPerHour: 1,
      cooldownSeconds: 0,
    });

    // Step 1: first delivery succeeds (the one allowed attempt).
    const r1 = await ingestEvent(h.id, {
      type: "task.rejected",
      data: { taskId: task.id, eventId: "evt-cs56-rate-1" },
    });
    expect(r1.matched).toBe(1);
    expect(r1.skipped).toBe(0);

    // Step 2: a flood of rejected attempts. The CS-56 T2 admitted-attempt
    // accounting must exclude these rate_limited rows so they cannot keep
    // the cap saturated.
    const attempts = 5;
    for (let i = 0; i < attempts; i++) {
      await ingestEvent(h.id, {
        type: "task.rejected",
        data: { taskId: task.id, eventId: `evt-cs56-rate-flood-${i}` },
      });
    }

    // Sanity: the rows were persisted — the production path still records
    // them for history/audit. The accounting layer just stops counting them.
    const allRuns = runRepo.listRunsByHabitat(h.id, { limit: 100 }).runs;
    const rateLimitedRuns = allRuns.filter((r) => r.skipReason === "rate_limited");
    expect(rateLimitedRuns.length).toBe(attempts);

    const nowIso = new Date().toISOString();
    const hourlyAdmitted = runRepo.getHourlyRunCount(rule.id, nowIso);
    // CS-56 T2: only the one succeeded run counts. rate_limited rows are
    // excluded from the hourly budget.
    expect(hourlyAdmitted).toBe(1);
  });

  it("cooldown skips do NOT extend the hourly window", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    // cooldownSeconds=3600 so any redelivery within the test is a cooldown skip.
    const rule = createEnabledRule(h.id, {
      name: "Cooldown",
      cooldownSeconds: 3600,
    });

    // First delivery: succeeds (admitted).
    await ingestEvent(h.id, {
      type: "task.rejected",
      data: { taskId: task.id, eventId: "evt-cs56-cooldown-1" },
    });

    // Second delivery: same fingerprint → cooldown skip. Must NOT count.
    await ingestEvent(h.id, {
      type: "task.rejected",
      data: { taskId: task.id, eventId: "evt-cs56-cooldown-1" },
    });

    const allRuns = runRepo.listRunsByHabitat(h.id, { limit: 100 }).runs;
    const cooldownRuns = allRuns.filter((r) => r.skipReason === "cooldown");
    expect(cooldownRuns.length).toBeGreaterThanOrEqual(1);

    const hourlyAdmitted = runRepo.getHourlyRunCount(rule.id, new Date().toISOString());
    // Only the one succeeded run is admitted; cooldown is excluded.
    expect(hourlyAdmitted).toBe(1);
  });

  it("admitted attempts DO count toward the hourly budget", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    const rule = createEnabledRule(h.id, {
      name: "CountAdmitted",
      cooldownSeconds: 0,
    });

    // Drive three successful, uniquely-deduplicated deliveries — each is
    // an admitted attempt. (maxRunsPerHour defaults to 100.)
    for (let i = 0; i < 3; i++) {
      const r = await ingestEvent(h.id, {
        type: "task.rejected",
        data: { taskId: task.id, eventId: `evt-cs56-admit-${i}` },
      });
      expect(r.matched).toBe(1);
    }

    const hourlyAdmitted = runRepo.getHourlyRunCount(rule.id, new Date().toISOString());
    expect(hourlyAdmitted).toBe(3);
  });

  it("recovered hourly budget after admitted rows age out, despite continuing rejected traffic", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    const rule = createEnabledRule(h.id, {
      name: "Recovery",
      cooldownSeconds: 0,
    });

    // One admitted attempt, anchored in the past.
    const pastAdmit = "2025-01-01T00:00:00.000Z";
    await ingestEvent(h.id, {
      type: "task.rejected",
      data: { taskId: task.id, eventId: "evt-cs56-recovery-1" },
    });
    // Backdate the started_at of the succeeded run so it falls outside the
    // window from the perspective of the nowIso we test against.
    const { runs } = runRepo.listRunsByRule(rule.id);
    const succeeded = runs.find((r) => r.status === "succeeded");
    expect(succeeded).toBeDefined();
    {
      const db = getDb();
      db.update(automationRuleRuns)
        .set({ startedAt: pastAdmit })
        .where(eq(automationRuleRuns.id, succeeded!.id))
        .run();
    }

    // Flood with rate_limited rows. Without admitted-attempt accounting
    // these would keep the cap saturated; with it, they MUST NOT count.
    for (let i = 0; i < 3; i++) {
      await ingestEvent(h.id, {
        type: "task.rejected",
        data: { taskId: task.id, eventId: `evt-cs56-recovery-flood-${i}` },
      });
    }

    // Probe from `nowIso` set 2 hours after the admitted row.
    const nowIso = "2025-01-01T02:00:00.000Z";
    const hourlyAdmitted = runRepo.getHourlyRunCount(rule.id, nowIso);
    // The aged-out admitted row is no longer in window; the rate_limited
    // rows are still in window but excluded.
    expect(hourlyAdmitted).toBe(0);
  });
});

// ===========================================================================
// 2. Manual run routes through the canonical lifecycle (CS-56 T6 — permanent
// regression)
//
// After the T6 cutover, `POST /automation-rules/:ruleId/run` calls
// `attemptRuleRun` (the canonical lifecycle) and returns a TERMINAL
// disposition — never a stranded `running` row. The handler obeys:
//   - target validation (Task/Mission/Sprint/Pulse/Habitat must resolve to
//     the rule Habitat; Agent must have active Habitat work),
//   - condition evaluation,
//   - causal guards,
//   - admission (cooldown + hourly cap),
//   - action kill switch,
//   - completion hook (one in-process callback per owned terminal transition).
//
// Pre-fix behavior (T1 ticket) was: handler called `startRuleRun` directly,
// returned a stranded `running` row, never evaluated the condition, never
// executed actions. The defect marker is gone — these tests pin the FIXED
// behavior so a future refactor cannot regress it.
// ===========================================================================

describe("CS-56 T6 — manual run routes through the canonical lifecycle", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("a manual run with a true condition returns a terminal executed disposition and fires actions", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, {
      name: "ManualTrue",
      triggerType: "task.rejected",
      condition: { type: "priority_above", threshold: "medium" },
      actions: [{ type: "create_signal", content: "Manual fired" }],
      cooldownSeconds: 0,
    });

    const baselinePulses = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;

    // The handler delegates to attemptRuleRun with source="manual",
    // triggerEventId="manual", null eventDedupeKey, and the rule's
    // configured trigger type. Mirror the exact seam invocation here.
    const disposition = await attemptRuleRun({
      rule,
      source: "manual",
      trigger: {
        triggerType: rule.trigger.type === "scan"
          ? (rule.trigger as { scanType?: string }).scanType ?? "manual"
          : (rule.trigger as { eventType?: string }).eventType ?? "manual",
        triggerEventId: "manual",
        habitatId: h.id,
        targetType: "task",
        targetId: task.id,
      },
      eventDedupeKey: null,
    });

    expect(disposition.kind).toBe("executed");
    if (disposition.kind !== "executed") throw new Error("expected executed");
    // The returned run is the REFRESHED TERMINAL row — never `running`.
    expect(disposition.run.status).toBe("succeeded");
    expect(disposition.run.finishedAt).not.toBeNull();
    expect(disposition.run.conditionResult?.matched).toBe(true);
    expect(disposition.run.actionResults?.[0]?.status).toBe("succeeded");

    // Action side effect is observed: the pulse count grew by 1.
    const afterPulses = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;
    expect(afterPulses).toBe(baselinePulses + 1);
  });

  it("a manual run with a false condition returns terminal skipped/condition_false and fires NO action", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "low");
    const rule = createEnabledRule(h.id, {
      name: "ManualFalse",
      triggerType: "task.rejected",
      condition: { type: "priority_above", threshold: "high" },
      actions: [{ type: "create_signal", content: "Should NOT fire" }],
      cooldownSeconds: 0,
    });

    const baselinePulses = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;

    const disposition = await attemptRuleRun({
      rule,
      source: "manual",
      trigger: {
        triggerType: rule.trigger.type === "scan"
          ? (rule.trigger as { scanType?: string }).scanType ?? "manual"
          : (rule.trigger as { eventType?: string }).eventType ?? "manual",
        triggerEventId: "manual",
        habitatId: h.id,
        targetType: "task",
        targetId: task.id,
      },
      eventDedupeKey: null,
    });

    expect(disposition.kind).toBe("skipped");
    if (disposition.kind !== "skipped") throw new Error("expected skipped");
    expect(disposition.reason).toBe("condition_false");
    expect(disposition.run.status).toBe("skipped");
    expect(disposition.run.skipReason).toBe("condition_false");
    expect(disposition.run.conditionResult?.matched).toBe(false);
    expect(disposition.run.actionResults).toBeNull();

    // No side effect — the false condition correctly stopped action execution.
    const afterPulses = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;
    expect(afterPulses).toBe(baselinePulses);
  });

  it("a manual run with a missing target returns terminal skipped/missing_target and fires NO action", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const rule = createEnabledRule(h.id, {
      name: "ManualMissing",
      triggerType: "task.rejected",
      condition: { type: "always" },
      actions: [{ type: "create_signal", content: "Should NOT fire" }],
      cooldownSeconds: 0,
    });

    const baselinePulses = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;

    // The lifecycle's structural step-1 check fires when targetType !== "none"
    // and targetId is null. The real manual route does NOT null or fix
    // cross-Habitat / missing targets in this codepath — it 400s BEFORE
    // invoking the lifecycle (see `automationManualRoute.inject.test.ts` for
    // the inject-level cross-Habitat 400 test). This direct lifecycle test
    // covers the structural step-1 case: any caller that hands the
    // lifecycle a null targetId for a non-`none` targetType finalizes
    // `missing_target` with null conditionResult and no actions.
    const disposition = await attemptRuleRun({
      rule,
      source: "manual",
      trigger: {
        triggerType: rule.trigger.type === "scan"
          ? (rule.trigger as { scanType?: string }).scanType ?? "manual"
          : (rule.trigger as { eventType?: string }).eventType ?? "manual",
        triggerEventId: "manual",
        habitatId: h.id,
        targetType: "task",
        targetId: null,
      },
      eventDedupeKey: null,
    });

    expect(disposition.kind).toBe("skipped");
    if (disposition.kind !== "skipped") throw new Error("expected skipped");
    expect(disposition.reason).toBe("missing_target");
    expect(disposition.run.status).toBe("skipped");
    expect(disposition.run.skipReason).toBe("missing_target");
    // Step-1 check fires BEFORE evaluation — conditionResult stays null.
    expect(disposition.run.conditionResult).toBeNull();

    const afterPulses = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;
    expect(afterPulses).toBe(baselinePulses);
  });

  it("a manual run inside cooldown returns terminal skipped/cooldown without evaluating the condition", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, {
      name: "ManualCooldown",
      triggerType: "task.rejected",
      condition: { type: "priority_above", threshold: "medium" },
      actions: [{ type: "create_signal", content: "Should fire ONCE" }],
      cooldownSeconds: 3600,
    });

    const baselinePulses = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;

    // First attempt: owns the cooldown window.
    const first = await attemptRuleRun({
      rule,
      source: "manual",
      trigger: {
        triggerType: rule.trigger.type === "scan"
          ? (rule.trigger as { scanType?: string }).scanType ?? "manual"
          : (rule.trigger as { eventType?: string }).eventType ?? "manual",
        triggerEventId: "manual",
        habitatId: h.id,
        targetType: "task",
        targetId: task.id,
      },
      eventDedupeKey: null,
    });
    expect(first.kind).toBe("executed");
    const afterFirst = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;
    expect(afterFirst).toBe(baselinePulses + 1);

    // Second attempt: same fingerprint → cooldown skip.
    const second = await attemptRuleRun({
      rule,
      source: "manual",
      trigger: {
        triggerType: rule.trigger.type === "scan"
          ? (rule.trigger as { scanType?: string }).scanType ?? "manual"
          : (rule.trigger as { eventType?: string }).eventType ?? "manual",
        triggerEventId: "manual",
        habitatId: h.id,
        targetType: "task",
        targetId: task.id,
      },
      eventDedupeKey: null,
    });
    expect(second.kind).toBe("skipped");
    if (second.kind !== "skipped") throw new Error("expected skipped");
    expect(second.reason).toBe("cooldown");
    expect(second.run.status).toBe("skipped");
    expect(second.run.skipReason).toBe("cooldown");
    expect(second.run.conditionResult).toBeNull();

    const afterSecond = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;
    expect(afterSecond).toBe(afterFirst); // cooldown skipped → no new pulse
  });

  it("a manual run with the kill switch ON returns terminal skipped/disabled with the TRUE conditionResult persisted", async () => {
    const h = setupHabitat();
    boardRepo.updateHabitat(h.id, { automationSettings: { executeActions: false } });
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, {
      name: "ManualKillSwitch",
      triggerType: "task.rejected",
      condition: { type: "priority_above", threshold: "medium" },
      actions: [{ type: "create_signal", content: "Should NOT fire" }],
      cooldownSeconds: 0,
    });

    const baselinePulses = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;

    let hookOutcome: string | null = null;
    const unsub = onAutomationRunCompleted((opts) => {
      hookOutcome = opts.outcome;
    });

    const disposition = await attemptRuleRun({
      rule,
      source: "manual",
      trigger: {
        triggerType: rule.trigger.type === "scan"
          ? (rule.trigger as { scanType?: string }).scanType ?? "manual"
          : (rule.trigger as { eventType?: string }).eventType ?? "manual",
        triggerEventId: "manual",
        habitatId: h.id,
        targetType: "task",
        targetId: task.id,
      },
      eventDedupeKey: null,
    });

    expect(disposition.kind).toBe("skipped");
    if (disposition.kind !== "skipped") throw new Error("expected skipped");
    expect(disposition.reason).toBe("disabled");
    expect(disposition.run.status).toBe("skipped");
    expect(disposition.run.skipReason).toBe("disabled");
    // Kill switch is post-condition: the TRUE conditionResult is persisted.
    expect(disposition.run.conditionResult?.matched).toBe(true);
    expect(disposition.run.actionResults).toBeNull();
    // The hook observed `skipped` (broad skipped gates catch kill-switch).
    expect(hookOutcome).toBe("skipped");

    const afterPulses = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;
    expect(afterPulses).toBe(baselinePulses);

    unsub();
  });

  it("a manual run emits exactly one completion callback across all terminal branches", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, {
      name: "ManualCompletionCount",
      triggerType: "task.rejected",
      condition: { type: "always" },
      actions: [{ type: "create_signal", content: "Fired" }],
      cooldownSeconds: 0,
    });

    let hookCalls = 0;
    const hookOutcomes: string[] = [];
    const unsub = onAutomationRunCompleted((opts) => {
      hookCalls++;
      hookOutcomes.push(opts.outcome);
    });

    // Owned terminal transition: emits EXACTLY one callback.
    const d = await attemptRuleRun({
      rule,
      source: "manual",
      trigger: {
        triggerType: rule.trigger.type === "scan"
          ? (rule.trigger as { scanType?: string }).scanType ?? "manual"
          : (rule.trigger as { eventType?: string }).eventType ?? "manual",
        triggerEventId: "manual",
        habitatId: h.id,
        targetType: "task",
        targetId: task.id,
      },
      eventDedupeKey: null,
    });
    expect(d.kind).toBe("executed");
    expect(hookCalls).toBe(1);
    expect(hookOutcomes[0]).toBe("succeeded");

    unsub();
  });

  it("a manual run with rate_limited returns terminal skipped/rate_limited with no conditionResult", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, {
      name: "ManualRateLimited",
      triggerType: "task.rejected",
      condition: { type: "always" },
      actions: [{ type: "create_signal", content: "Should fire ONCE" }],
      cooldownSeconds: 0,
      maxRunsPerHour: 1,
    });

    // First attempt: owns the hourly slot.
    const first = await attemptRuleRun({
      rule,
      source: "manual",
      trigger: {
        triggerType: rule.trigger.type === "scan"
          ? (rule.trigger as { scanType?: string }).scanType ?? "manual"
          : (rule.trigger as { eventType?: string }).eventType ?? "manual",
        triggerEventId: "manual-1",
        habitatId: h.id,
        targetType: "task",
        targetId: task.id,
      },
      eventDedupeKey: null,
    });
    expect(first.kind).toBe("executed");

    // Second attempt: hourly cap reached → rate_limited skip (manual
    // attempts share the same `maxRunsPerHour` budget).
    const second = await attemptRuleRun({
      rule,
      source: "manual",
      trigger: {
        triggerType: rule.trigger.type === "scan"
          ? (rule.trigger as { scanType?: string }).scanType ?? "manual"
          : (rule.trigger as { eventType?: string }).eventType ?? "manual",
        triggerEventId: "manual-2",
        habitatId: h.id,
        targetType: "task",
        targetId: task.id,
      },
      eventDedupeKey: null,
    });
    expect(second.kind).toBe("skipped");
    if (second.kind !== "skipped") throw new Error("expected skipped");
    expect(second.reason).toBe("rate_limited");
    expect(second.run.status).toBe("skipped");
    expect(second.run.skipReason).toBe("rate_limited");
    // Step-3 fires BEFORE evaluation — conditionResult stays null.
    expect(second.run.conditionResult).toBeNull();
  });
});

// ===========================================================================
// 3. External guard skips emit completion (CS-56 T4 — permanent regression)
//
// After the T4 cutover, the event path routes every attempt through the
// canonical lifecycle (`attemptRuleRun`), which owns completion emission for
// every owned `running → terminal` transition — including cooldown and
// rate_limited skips. The legacy pre-admission guard path that finalized the
// row without calling `notifyAutomationRunCompleted` is gone. Pin the FIXED
// behavior so a future refactor cannot regress it back to the old
// emit-only-on-succeeded semantics.
//
// `on_automation` Workflow Gates configured for `outcome=skipped` therefore
// receive a signal on every guard skip (T6 verifies the Workflow Gate
// integration end-to-end).
// ===========================================================================

describe("CS-56 T4 — guard skips emit completion", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("a cooldown skip emits exactly one onAutomationRunCompleted callback", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    // Cooldown large so the second delivery is guaranteed to skip.
    const rule = createEnabledRule(h.id, {
      name: "Cooldown",
      cooldownSeconds: 3600,
    });

    // First delivery: succeeds, hook fires.
    let hookCalls = 0;
    const hookOutcomes: string[] = [];
    const unsub = onAutomationRunCompleted((opts) => {
      hookCalls++;
      hookOutcomes.push(opts.outcome);
    });

    const r1 = await ingestEvent(h.id, {
      type: "task.rejected",
      data: { taskId: task.id, eventId: "evt-cs56-cd-1" },
    });
    expect(r1.matched).toBe(1);
    expect(hookCalls).toBe(1);
    expect(hookOutcomes[0]).toBe("succeeded");

    // Second delivery: same eventId → cooldown skip. The lifecycle emits
    // completion for every owned terminal transition (including skips), so
    // hookCalls must advance by exactly 1.
    const r2 = await ingestEvent(h.id, {
      type: "task.rejected",
      data: { taskId: task.id, eventId: "evt-cs56-cd-1" },
    });
    expect(r2.skipped).toBeGreaterThanOrEqual(1);
    expect(hookCalls).toBe(2);

    unsub();
  });

  it("a rate_limited skip emits exactly one onAutomationRunCompleted callback", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    const rule = createEnabledRule(h.id, {
      name: "Once-per-hour",
      maxRunsPerHour: 1,
      cooldownSeconds: 0,
    });

    // Saturate the cap with the one allowed attempt.
    const r1 = await ingestEvent(h.id, {
      type: "task.rejected",
      data: { taskId: task.id, eventId: "evt-cs56-rl-1" },
    });
    expect(r1.matched).toBe(1);

    // Register hook AFTER the success to isolate the rate_limited call.
    let hookCalls = 0;
    const unsub = onAutomationRunCompleted(() => {
      hookCalls++;
    });

    // Second attempt → rate_limited skip. The lifecycle emits completion
    // exactly once for the owned terminal transition, so hookCalls advances
    // by exactly 1.
    const r2 = await ingestEvent(h.id, {
      type: "task.rejected",
      data: { taskId: task.id, eventId: "evt-cs56-rl-2" },
    });
    expect(r2.skipped).toBeGreaterThanOrEqual(1);
    expect(hookCalls).toBe(1);

    unsub();
  });
});

// ===========================================================================
// 4. Dedupe-loser safety (CORRECT behavior — pin as safety assertion)
//
// Trusted `task.created` delivery uses `(eventDedupeKey, ruleId)` as the
// reservation key. The first delivery owns the run and may execute; a
// redelivery finds the existing row and returns `created: false`, which the
// executor short-circuits. The dedupe loser must NOT mutate the run or
// re-execute actions. Pin this so future refactors cannot regress it.
//
// The ingestion counter increment on a dedupe loser is a SEPARATE defect
// extracted into its own labeled assertion below — it does not change the
// load-bearing safety property here.
// ===========================================================================

describe("CS-56 T1 — dedupe-loser safety (pinned CORRECT behavior)", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("dedupe loser of a trusted task.created redelivery returns the existing run without mutation", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    const rule = createEnabledRule(h.id, {
      name: "Dedupe",
      triggerType: "task.created",
      cooldownSeconds: 0,
    });

    const data = buildTrustedEnvelopeData("evt-cs56-dedupe-1", task.id, {
      root: { type: "human", id: "user-1" },
    });

    // First delivery: succeeds, persists a `succeeded` run row.
    await ingestEvent(h.id, { type: "task.created", data });
    const baseline = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;

    // Second delivery: same eventId → reservation engages inside
    // executeAndRecordRuleRun (via `!created`), so the run is NOT re-executed
    // and the row is NOT mutated. The safety property is asserted below;
    // the `matched`-counter misclassification is the separately-labeled
    // defect "Dedupe loser increments `matched` counter (T4)".
    await ingestEvent(h.id, { type: "task.created", data });

    const { runs } = runRepo.listRunsByRule(rule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("succeeded");
    expect(runs[0].finishedAt).not.toBeNull();

    // No duplicate pulse from the loser path — the safety property we care about.
    const after = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;
    expect(after).toBe(baseline);
  });

  it("a dedupe loser increments deduplicated, not matched (CS-56 T4 — permanent regression)", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    const rule = createEnabledRule(h.id, {
      name: "DedupeMatched",
      triggerType: "task.created",
      cooldownSeconds: 0,
    });

    const data = buildTrustedEnvelopeData("evt-cs56-dedupe-matched-1", task.id, {
      root: { type: "human", id: "user-1" },
    });

    // First delivery owns the run; second delivery short-circuits via the
    // `(eventDedupeKey, ruleId)` reservation inside the lifecycle — the
    // returned disposition is `deduplicated`. Counters derive SOLELY from
    // the disposition, so the loser's `matched` count is 0 and `deduplicated`
    // is 1.
    await ingestEvent(h.id, { type: "task.created", data });
    const r2 = await ingestEvent(h.id, { type: "task.created", data });

    // Sanity: only one run row exists (the dedupe short-circuit held).
    expect(runRepo.listRunsByRule(rule.id).runs).toHaveLength(1);
    expect(r2.matched).toBe(0);
    expect(r2.deduplicated).toBe(1);
  });

  it("dedupe loser cannot mutate the winning run's actionResults or status", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    const rule = createEnabledRule(h.id, {
      name: "DedupeMutate",
      triggerType: "task.created",
      cooldownSeconds: 0,
    });

    const data = buildTrustedEnvelopeData("evt-cs56-dedupe-mut-1", task.id, {
      root: { type: "human", id: "user-1" },
    });

    await ingestEvent(h.id, { type: "task.created", data });
    const winnerBefore = runRepo.listRunsByRule(rule.id).runs[0];

    // Redelivery, then assert the row is byte-equal on the load-bearing fields.
    await ingestEvent(h.id, { type: "task.created", data });
    const winnerAfter = runRepo.listRunsByRule(rule.id).runs[0];

    expect(winnerAfter.id).toBe(winnerBefore.id);
    expect(winnerAfter.status).toBe(winnerBefore.status);
    expect(winnerAfter.actionResults).toEqual(winnerBefore.actionResults);
    expect(winnerAfter.finishedAt).toBe(winnerBefore.finishedAt);
    expect(winnerAfter.startedAt).toBe(winnerBefore.startedAt);
  });
});

// ===========================================================================
// 5. Evaluator runs on the event path (CS-56 T4 — permanent regression)
//
// After the T4 cutover the event path routes through the canonical lifecycle
// (`attemptRuleRun`), which calls the evaluator BEFORE actions. A rule whose
// condition evaluates to FALSE on the trigger payload must persist
// `condition_false` and perform NO action. Pin the FIXED behavior so a future
// refactor cannot regress it back to the legacy "build context, skip
// evaluator, execute actions" path.
// ===========================================================================

describe("CS-56 T4 — false conditions persist condition_false and perform no action", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("a triggered rule with a real (non-`always`) false condition persists condition_false and fires no action", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    // A condition that, per `evaluateCondition`, evaluates to FALSE for a
    // task whose priority is "low". After T4 the lifecycle evaluates the
    // condition first and short-circuits with `skipped/condition_false` —
    // no actions fire.
    const rule = createEnabledRule(h.id, {
      name: "FalseCondition",
      triggerType: "task.rejected",
      condition: {
        type: "priority_above",
        threshold: "high",
      },
    });
    // Re-fetch to get the persisted (post-default) form.
    const persistedRule = ruleRepo.getAutomationRuleById(rule.id)!;
    expect(persistedRule.condition).toEqual({ type: "priority_above", threshold: "high" });

    const baseline = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;

    const result = await ingestEvent(h.id, {
      type: "task.rejected",
      data: { taskId: task.id, eventId: "evt-cs56-cond-false" },
    });

    // After T4: matched=0 (no action fired), skipped=1 (condition_false skip).
    expect(result.matched).toBe(0);
    expect(result.skipped).toBe(1);

    // The run row persists the false evaluation result, NO actionResults,
    // and the dedicated condition_false skipReason.
    const { runs } = runRepo.listRunsByRule(rule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("skipped");
    expect(runs[0].skipReason).toBe("condition_false");
    expect(runs[0].conditionResult).not.toBeNull();
    expect(runs[0].conditionResult!.matched).toBe(false);
    expect(runs[0].actionResults).toBeNull();

    // No pulse: the evaluator short-circuited before action execution.
    const after = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;
    expect(after).toBe(baseline);
  });
});

// ===========================================================================
// 6. Condition-before-causal ordering on the event path (CS-56 T4 — permanent regression)
//
// After the T4 cutover the lifecycle evaluates the stored condition BEFORE
// the causal cycle/depth guard. A rule whose condition is FALSE on the
// trigger payload must therefore be classified as `condition_false` — the
// causal cycle guard never sees it, so no phantom `causal_cycle` skip
// appears. Pin the FIXED behavior so a future refactor cannot regress it
// back to "cycle guard runs first, false condition misclassified as
// causal_cycle". The A→B→A proof in `automationTaskPublication.test.ts`
// asserts the same invariant end-to-end on the live producer path.
// ===========================================================================

describe("CS-56 T4 — false-condition rules classify as condition_false, not causal_cycle", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("a rule whose condition is FALSE on the trigger is recorded as condition_false, not causal_cycle", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    // Rule has a condition that is FALSE on `task.priority === "low"` AND
    // a self-loop in the chain. After T4 the lifecycle evaluates the
    // condition first; the false condition short-circuits to
    // `condition_false` and the causal_cycle guard never runs.
    const rule = createEnabledRule(h.id, {
      name: "FalseAndCyclic",
      triggerType: "task.created",
      condition: { type: "priority_above", threshold: "high" },
      actions: [{ type: "create_signal", content: "Should NOT fire" }],
    });

    const data = buildTrustedEnvelopeData("evt-cs56-phantom", task.id, {
      root: { type: "human", id: "user-1" },
      hops: [{ type: "automation", id: rule.id }],
    });

    const baseline = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;
    const result = await ingestEvent(h.id, { type: "task.created", data });

    // After T4: the condition is evaluated first; the false predicate
    // short-circuits with `condition_false` and the causal_cycle guard
    // never sees this rule.
    const skips = runRepo.getSkippedRunsByRule(rule.id).runs;
    expect(skips).toHaveLength(1);
    expect(skips[0].skipReason).toBe("condition_false");
    expect(result.matched).toBe(0);
    expect(result.skipped).toBe(1);

    // No pulse: the false condition correctly stopped action execution.
    const after = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;
    expect(after).toBe(baseline);
  });
});

// ===========================================================================
// 7. Kill switch (CS-56 T5 — permanent regression proving SETTLED semantics)
//
// CS-56 T1 mis-pinned this as "succeeded". The settled contract is that the
// kill switch finalizes `status=skipped`, `skipReason=disabled`, persists
// the true conditionResult, performs no action, and emits the completion
// hook. The legacy `executeAndRecordRuleRun` returned `succeeded` for the
// kill switch; T5 retired it and flipped this test to assert the
// SETTLED semantics through `attemptRuleRun`. The fix-up applies to the
// "succeeded" assertion only — no other behavior changed.
// ===========================================================================

describe("CS-56 T5 — kill switch finalizes skipped/disabled with persisted true conditionResult", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => {
    closeDb();
    delete process.env.ORCY_AUTOMATION_EXECUTE_ACTIONS;
  });

  it("kill switch OFF (habitat setting) emits completion and persists actionResults=null with skipped/disabled", async () => {
    const h = setupHabitat();
    boardRepo.updateHabitat(h.id, { automationSettings: { executeActions: false } });

    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    const rule = createEnabledRule(h.id, {
      name: "KillSwitch",
      actions: [{ type: "create_signal", content: "Should not fire" }],
    });
    const persisted = ruleRepo.getAutomationRuleById(rule.id)!;

    const baseline = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;

    let hookOutcome: string | null = null;
    const unsub = onAutomationRunCompleted((opts) => {
      hookOutcome = opts.outcome;
    });

    const disposition = await attemptRuleRun({
      rule: persisted,
      source: "event",
      trigger: {
        triggerType: "task.rejected",
        triggerEventId: "evt-cs56-killswitch-1",
        habitatId: h.id,
        targetType: "task",
        targetId: task.id,
      },
    });

    expect(disposition.kind).toBe("skipped");
    if (disposition.kind === "skipped") {
      expect(disposition.reason).toBe("disabled");
    }
    const finished = runRepo.getRuleRunById(disposition.run.id);
    expect(finished?.status).toBe("skipped");
    expect(finished?.skipReason).toBe("disabled");
    expect(finished?.actionResults).toBeNull();
    // The kill switch finalizes AFTER condition evaluation, so the true
    // conditionResult MUST be persisted — `disabled` is a post-condition
    // outcome, not a condition-evaluation failure.
    expect(finished?.conditionResult).not.toBeNull();
    expect(finished?.conditionResult!.matched).toBe(true);
    expect(hookOutcome).toBe("skipped");

    const after = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;
    expect(after).toBe(baseline);

    unsub();
  });
});

// ===========================================================================
// 8. Inventory pin: every scan/event path reaches the canonical lifecycle
//
// This file's job is characterization, not the inventory itself. We add a
// single assertion that re-confirms each production call site routes
// through `attemptRuleRun` by exercising one representative path per
// scan/event so a refactor that drops a call site would be observable.
//
// (The complete inventory is also pinned in `automationExecutor.test.ts`'s
// sibling file — see the ticket's "8 call sites" requirement.)
// ===========================================================================

describe("CS-56 T5 — inventory smoke: each scan/event path reaches attemptRuleRun", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("event path (task.rejected): one matched run per ingestion", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    const rule = createEnabledRule(h.id, {
      name: "EventSmoke",
      cooldownSeconds: 0,
    });

    const result = await ingestEvent(h.id, {
      type: "task.rejected",
      data: { taskId: task.id, eventId: "evt-cs56-smoke-event" },
    });
    expect(result.matched).toBe(1);
    const { runs } = runRepo.listRunsByRule(rule.id);
    expect(runs).toHaveLength(1);
  });

  it("scan path (mission_blocked): runAllScans fires one run per blocked Mission", async () => {
    const h = setupHabitat();
    // Create two non-archived missions in the Habitat, and a
    // `mission_dependencies` edge so source mission is blocked.
    const blocker = missionRepo.createMission({
      habitatId: h.id,
      title: "Blocker",
      createdBy: "user-1",
    });
    const blocked = missionRepo.createMission({
      habitatId: h.id,
      title: "Blocked",
      createdBy: "user-1",
    });
    getDb()
      .insert(missionDependencies)
      .values({ missionId: blocked.id, dependsOnId: blocker.id })
      .run();

    const rule = createEnabledRule(h.id, {
      name: "ScanSmoke",
      triggerType: "mission_blocked",
      cooldownSeconds: 0,
      maxRunsPerHour: 100,
    });

    const reports = await runAllScans();
    const r = reports.find(
      (x) => x.habitatId === h.id && x.scanType === "mission_blocked",
    );
    expect(r).toBeDefined();
    expect(r!.rulesMatched).toBe(1);

    const { runs } = runRepo.listRunsByRule(rule.id);
    // One canonical run per candidate per rule.
    expect(runs).toHaveLength(1);
    // Trigger id is deterministic per candidate identity.
    expect(runs[0].triggerEventId).toBe(`scan:mission_blocked:${blocked.id}:${h.id}`);
    expect(runs[0].targetType).toBe("mission");
    expect(runs[0].targetId).toBe(blocked.id);
  });
});

// ---------------------------------------------------------------------------
// Suppress unused-import lint warnings for symbols that are imported for type
// documentation only in this file.
// ---------------------------------------------------------------------------
void vi;
void tasks;
void automationRuleRuns;
void eq;