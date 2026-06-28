import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as skillRepo from "../repositories/habitatSkill.js";
import * as insightRepo from "../repositories/insight.js";
import * as effortRepo from "../repositories/effortEntry.js";
import * as commentRepo from "../repositories/comment.js";
import * as wikiService from "../services/wikiService.js";
import * as augmentation from "../services/wikiAugmentationService.js";
import {
  habitats,
  columns,
  missions,
  tasks,
  agents,
  wikiPages,
  wikiPageVersions,
  wikiPageLinks,
  wikiCoverageMarkers,
  habitatSkillSignals,
  projectInsights,
  pulses,
  effortEntries,
  taskComments,
  missionComments,
} from "../db/schema/index.js";

/** Spin-waits until the wall clock advances past `since`; used to disambiguate timestamps that
 * would otherwise be equal at millisecond resolution. */
function advanceClockPast(since: string): string {
  let now = new Date().toISOString();
  while (now <= since) {
    const next = new Date(Date.now() + 2);
    while (new Date().toISOString() <= since) {
      // spin
    }
    now = new Date().toISOString();
  }
  return now;
}

function setupHabitat() {
  const habitat = habitatRepo.createHabitat({ name: "Augmentation Test Habitat" });
  const col = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0 });
  return { habitat, col };
}

function setupMission(habitatId: string, colId: string) {
  return missionRepo.createMission({
    habitatId,
    columnId: colId,
    title: "Augmentation Test Mission",
    createdBy: "test-user",
  });
}

function setupAgent(name: string) {
  return agentRepo.createAgent({
    name,
    type: "claude-code",
    domain: "general",
  });
}

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(wikiPageLinks).run();
  db.delete(wikiCoverageMarkers).run();
  db.delete(wikiPageVersions).run();
  db.delete(wikiPages).run();
  db.delete(habitatSkillSignals).run();
  db.delete(projectInsights).run();
  db.delete(taskComments).run();
  db.delete(missionComments).run();
  db.delete(effortEntries).run();
  db.delete(pulses).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(agents).run();
  db.delete(columns).run();
  db.delete(habitats).run();
});

afterEach(() => {
  closeDb();
});

describe("wikiAugmentationService.getAuthoringContextForEdit — delta mode", () => {
  it("returns empty arrays for a freshly-created page with no later activity", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(
      habitat.id,
      { title: "Fresh page", content: "body" },
      "human-1",
    );

    const ctx = augmentation.getAuthoringContextForEdit(page.id);
    expect(ctx.habitatId).toBe(habitat.id);
    expect(ctx.from).toBe(page.lastUpdatedAt);
    expect(ctx.to).toBeNull();
    expect(ctx.query).toBeNull();
    expect(ctx.pulses).toEqual([]);
    expect(ctx.skillSignals).toEqual([]);
    expect(ctx.insights).toEqual([]);
    expect(ctx.evidence).toEqual([]);
    expect(ctx.effort).toEqual([]);
    expect(ctx.comments).toEqual([]);
  });

  it("surfaces a habitat-scoped pulse that arrives after the page's lastUpdatedAt", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(habitat.id, { title: "Page", content: "body" }, "human-1");

    pulseRepo.createPulse({
      habitatId: habitat.id,
      scope: "habitat",
      fromType: "human",
      fromId: "human-1",
      signalType: "context",
      subject: "Context signal after page",
      body: "Should appear in delta",
    });

    const ctx = augmentation.getAuthoringContextForEdit(page.id);
    expect(ctx.pulses).toHaveLength(1);
    expect(ctx.pulses[0].subject).toBe("Context signal after page");
    expect(ctx.skillSignals).toEqual([]);
    expect(ctx.insights).toEqual([]);
    expect(ctx.evidence).toEqual([]);
    expect(ctx.effort).toEqual([]);
    expect(ctx.comments).toEqual([]);
  });

  it("surfaces a mission-scoped pulse when the mission is in the page's habitat", () => {
    const { habitat, col } = setupHabitat();
    const mission = setupMission(habitat.id, col.id);
    const page = wikiService.createPage(habitat.id, { title: "Page", content: "body" }, "human-1");

    advanceClockPast(page.lastUpdatedAt);
    pulseRepo.createPulse({
      missionId: mission.id,
      habitatId: habitat.id,
      scope: "mission",
      fromType: "human",
      fromId: "human-1",
      signalType: "finding",
      subject: "Mission finding",
      body: "Body",
    });

    const ctx = augmentation.getAuthoringContextForEdit(page.id);
    expect(ctx.pulses).toHaveLength(1);
  });

  it("surfaces a habitat skill signal whose updatedAt > lastUpdatedAt", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(habitat.id, { title: "Page", content: "body" }, "human-1");

    advanceClockPast(page.lastUpdatedAt);
    skillRepo.createSignal({
      habitatId: habitat.id,
      clusterKey: "uses-drizzle",
      skillCategory: "convention",
      sourceSignalType: "finding",
      subject: "Uses Drizzle",
      summary: "Project uses Drizzle",
    });

    const ctx = augmentation.getAuthoringContextForEdit(page.id);
    expect(ctx.skillSignals).toHaveLength(1);
  });

  it("strips individual experience-signal source IDs from the authoring context (privacy boundary)", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(habitat.id, { title: "Page", content: "body" }, "human-1");

    advanceClockPast(page.lastUpdatedAt);
    skillRepo.createSignal({
      habitatId: habitat.id,
      clusterKey: "stuck-on-drizzle",
      skillCategory: "pitfall",
      sourceSignalType: "experience",
      subject: "Stuck on Drizzle migrations",
      summary: "Agent got stuck on FTS5 migration",
      sourcePulseId: "pulse-secret-1",
      sourceTaskId: "task-secret-1",
      sourceCommentId: "comment-secret-1",
      agentId: "agent-secret-1",
    });

    const ctx = augmentation.getAuthoringContextForEdit(page.id);
    expect(ctx.skillSignals).toHaveLength(1);
    const signal = ctx.skillSignals[0] as Record<string, unknown>;
    // Aggregate counts are retained...
    expect(signal.frequency).toBe(1);
    expect(signal.corroboratingAgents).toBe(1);
    // ...but individual-level source IDs must never leave the service.
    expect(signal.sourcePulseIds).toBeUndefined();
    expect(signal.sourceTaskIds).toBeUndefined();
    expect(signal.sourceCommentIds).toBeUndefined();
    expect(signal.corroboratingAgentIds).toBeUndefined();
    const serialised = JSON.stringify(ctx.skillSignals[0]);
    expect(serialised).not.toContain("pulse-secret-1");
    expect(serialised).not.toContain("task-secret-1");
    expect(serialised).not.toContain("comment-secret-1");
    expect(serialised).not.toContain("agent-secret-1");
  });

  it("surfaces an active project insight in the habitat", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(habitat.id, { title: "Page", content: "body" }, "human-1");

    advanceClockPast(page.lastUpdatedAt);
    insightRepo.createInsight({
      habitatId: habitat.id,
      signalType: "context",
      subject: "Pattern: X",
      body: "Insight body",
      promotedBy: "human-1",
    });

    const ctx = augmentation.getAuthoringContextForEdit(page.id);
    expect(ctx.insights).toHaveLength(1);
  });

  it("surfaces effort entries via the tasks->missions join", () => {
    const { habitat, col } = setupHabitat();
    setupAgent("agent-1");
    const mission = setupMission(habitat.id, col.id);
    const task = taskRepo.createTask({
      missionId: mission.id,
      title: "Effort task",
      createdBy: "test-user",
    });
    const page = wikiService.createPage(habitat.id, { title: "Page", content: "body" }, "human-1");

    advanceClockPast(page.lastUpdatedAt);
    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      actorId: "user-1",
      minutes: 15,
      source: "human_manual",
      note: "Doing the work",
    });

    const ctx = augmentation.getAuthoringContextForEdit(page.id);
    expect(ctx.effort).toHaveLength(1);
    expect(ctx.effort[0].taskId).toBe(task.id);
  });

  it("surfaces task comments in the habitat", () => {
    const { habitat, col } = setupHabitat();
    const mission = setupMission(habitat.id, col.id);
    const task = taskRepo.createTask({
      missionId: mission.id,
      title: "Commented task",
      createdBy: "test-user",
    });
    const page = wikiService.createPage(habitat.id, { title: "Page", content: "body" }, "human-1");

    advanceClockPast(page.lastUpdatedAt);
    commentRepo.createComment({
      taskId: task.id,
      authorType: "human",
      authorId: "user-1",
      content: "Hello world",
    });

    const ctx = augmentation.getAuthoringContextForEdit(page.id);
    expect(ctx.comments).toHaveLength(1);
    expect(ctx.comments[0].scope).toBe("task");
  });

  it("does not surface pulses from a different habitat", () => {
    const { habitat } = setupHabitat();
    const otherHabitat = habitatRepo.createHabitat({ name: "Other habitat" });
    const page = wikiService.createPage(habitat.id, { title: "Page", content: "body" }, "human-1");

    pulseRepo.createPulse({
      habitatId: otherHabitat.id,
      scope: "habitat",
      fromType: "human",
      fromId: "human-1",
      signalType: "context",
      subject: "Cross-habitat leak",
      body: "should not appear",
    });

    const ctx = augmentation.getAuthoringContextForEdit(page.id);
    expect(ctx.pulses).toEqual([]);
  });

  it("throws 404 for a missing page", () => {
    expect(() => augmentation.getAuthoringContextForEdit("nonexistent-page-id")).toThrow(
      /not found/i,
    );
  });
});

describe("wikiAugmentationService.getAuthoringContextForChunk — chunk mode", () => {
  it("returns primitives in the date range and excludes out-of-range", () => {
    const { habitat } = setupHabitat();
    const db = getDb();

    db.insert(pulses)
      .values({
        id: "pulse-in",
        habitatId: habitat.id,
        scope: "habitat",
        fromType: "human",
        fromId: "human-1",
        signalType: "context",
        subject: "In window",
        body: "Body",
        metadata: {},
        createdAt: "2026-01-15T00:00:00.000Z",
        pinned: 0,
        isAuto: false,
      })
      .run();
    db.insert(pulses)
      .values({
        id: "pulse-out",
        habitatId: habitat.id,
        scope: "habitat",
        fromType: "human",
        fromId: "human-1",
        signalType: "context",
        subject: "Out of window",
        body: "Body",
        metadata: {},
        createdAt: "2025-12-01T00:00:00.000Z",
        pinned: 0,
        isAuto: false,
      })
      .run();

    const ctx = augmentation.getAuthoringContextForChunk(habitat.id, {
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
    });

    expect(ctx.from).toBe("2026-01-01T00:00:00.000Z");
    expect(ctx.to).toBe("2026-02-01T00:00:00.000Z");
    expect(ctx.query).toBeNull();
    expect(ctx.pulses).toHaveLength(1);
    expect(ctx.pulses[0].subject).toBe("In window");
  });

  it("narrows results when a keyword query is provided", () => {
    const { habitat } = setupHabitat();

    pulseRepo.createPulse({
      habitatId: habitat.id,
      scope: "habitat",
      fromType: "human",
      fromId: "human-1",
      signalType: "context",
      subject: "Auth context",
      body: "About login",
    });
    pulseRepo.createPulse({
      habitatId: habitat.id,
      scope: "habitat",
      fromType: "human",
      fromId: "human-1",
      signalType: "context",
      subject: "Build context",
      body: "About bundling",
    });

    const ctx = augmentation.getAuthoringContextForChunk(habitat.id, {
      from: "2020-01-01T00:00:00.000Z",
      to: "2099-01-01T00:00:00.000Z",
    });

    const authCtx = augmentation.getAuthoringContextForChunk(habitat.id, {
      from: "2020-01-01T00:00:00.000Z",
      to: "2099-01-01T00:00:00.000Z",
      query: "auth",
    });
    expect(ctx.pulses).toHaveLength(2);
    expect(authCtx.pulses).toHaveLength(1);
    expect(authCtx.pulses[0].subject).toBe("Auth context");
  });
});

describe("wikiAugmentationService.getRelevantPrimitives — reactive suggest", () => {
  it("returns primitives matching the keyword across types, capped at 20", () => {
    const { habitat } = setupHabitat();

    pulseRepo.createPulse({
      habitatId: habitat.id,
      scope: "habitat",
      fromType: "human",
      fromId: "human-1",
      signalType: "context",
      subject: "Auth flow note",
      body: "About OAuth",
    });
    pulseRepo.createPulse({
      habitatId: habitat.id,
      scope: "habitat",
      fromType: "human",
      fromId: "human-1",
      signalType: "context",
      subject: "Build pipeline",
      body: "Webpack config",
    });

    const matches = augmentation.getRelevantPrimitives(habitat.id, { query: "auth" });
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].type).toBe("pulse");
    expect(matches[0].subject.toLowerCase()).toContain("auth");
  });

  it("returns empty array when no query provided", () => {
    const { habitat } = setupHabitat();
    expect(augmentation.getRelevantPrimitives(habitat.id)).toEqual([]);
    expect(augmentation.getRelevantPrimitives(habitat.id, { limit: 10 })).toEqual([]);
  });
});
