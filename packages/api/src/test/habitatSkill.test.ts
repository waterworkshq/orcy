import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as skillRepo from "../repositories/habitatSkill.js";
import {
  ingestFromPulse,
  ingestFromTaskEvent,
  ingestFromComment,
  classifyPulseToCategory,
  normalize,
  calculateStrength,
  reclassifyCategory,
  scoreAllSignals,
  contributeSignal,
  generateSkillDocument,
  regenerateSkill,
} from "../services/habitatSkillService.js";
import type { HabitatSkillSignal } from "../repositories/habitatSkill.js";
import { habitats, columns, missions, tasks, agents } from "../db/schema/index.js";

function setupHabitat() {
  const habitat = habitatRepo.createHabitat({ name: "Test Habitat" });
  const col = columnRepo.createColumn({
    habitatId: habitat.id,
    name: "Todo",
    order: 0,
  });
  return { habitat, col };
}

function setupMission(habitatId: string, colId: string) {
  return missionRepo.createMission({
    habitatId,
    columnId: colId,
    title: "Test Mission",
    createdBy: "test",
  });
}

function createAgent(name: string) {
  return agentRepo.createAgent({
    name,
    type: "claude-code",
    domain: "general",
  });
}

describe("habitatSkillService", () => {
  beforeEach(async () => {
    await initTestDb();
    const db = getDb();
    db.delete(tasks).run();
    db.delete(missions).run();
    db.delete(columns).run();
    db.delete(agents).run();
    db.delete(habitats).run();
  });

  afterEach(() => {
    closeDb();
  });

  describe("classifyPulseToCategory", () => {
    it("maps finding to convention", () => {
      expect(classifyPulseToCategory("finding")).toBe("convention");
    });

    it("maps directive to convention", () => {
      expect(classifyPulseToCategory("directive")).toBe("convention");
    });

    it("maps context to domain_knowledge", () => {
      expect(classifyPulseToCategory("context")).toBe("domain_knowledge");
    });

    it("maps warning to pitfall", () => {
      expect(classifyPulseToCategory("warning")).toBe("pitfall");
    });

    it("maps blocker to pitfall", () => {
      expect(classifyPulseToCategory("blocker")).toBe("pitfall");
    });

    it("maps handoff to agent_insight", () => {
      expect(classifyPulseToCategory("handoff")).toBe("agent_insight");
    });

    it("defaults unknown types to agent_insight", () => {
      expect(classifyPulseToCategory("unknown")).toBe("agent_insight");
    });
  });

  describe("normalize", () => {
    it("lowercases and strips punctuation", () => {
      const result = normalize("Drizzle ORM uses bun:sqlite!");
      expect(result.startsWith("drizzle orm uses bunsqlite")).toBe(true);
      expect(result).toMatch(/^drizzle orm uses bunsqlite#[a-z0-9]+$/);
    });

    it("collapses whitespace", () => {
      const result = normalize("  hello   world  ");
      expect(result.startsWith("hello world")).toBe(true);
      expect(result).toMatch(/^hello world#[a-z0-9]+$/);
    });

    it("truncates prefix to 80 chars and appends hash", () => {
      const long = "a".repeat(200);
      const result = normalize(long);
      expect(result.length).toBeLessThan(100);
      expect(result).toMatch(/^a{80}#[a-z0-9]+$/);
    });

    it("produces same hash for identical inputs", () => {
      expect(normalize("Hello World")).toBe(normalize("Hello World"));
    });

    it("produces different hashes for different inputs with same prefix", () => {
      const a = normalize("a".repeat(200) + "x");
      const b = normalize("a".repeat(200) + "y");
      expect(a).not.toBe(b);
    });
  });

  describe("ingestFromPulse", () => {
    it("creates signal for finding pulse", () => {
      const { habitat } = setupHabitat();
      ingestFromPulse({
        habitatId: habitat.id,
        signalType: "finding",
        subject: "Uses Drizzle ORM",
        body: "The project uses Drizzle ORM",
        pulseId: "pulse-1",
        fromType: "agent",
        fromId: "agent-1",
      });

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.total).toBe(1);
      expect(signals.signals[0].skillCategory).toBe("convention");
      expect(signals.signals[0].sourceSignalType).toBe("finding");
    });

    it("skips system signals", () => {
      const { habitat } = setupHabitat();
      ingestFromPulse({
        habitatId: habitat.id,
        signalType: "context",
        subject: "System message",
        body: "",
        pulseId: "pulse-sys",
        fromType: "system",
        fromId: "system",
      });

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.total).toBe(0);
    });

    it("skips question signals", () => {
      const { habitat } = setupHabitat();
      ingestFromPulse({
        habitatId: habitat.id,
        signalType: "question",
        subject: "How does this work?",
        body: "",
        pulseId: "pulse-q",
        fromType: "agent",
        fromId: "agent-1",
      });

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.total).toBe(0);
    });

    it("skips answer signals", () => {
      const { habitat } = setupHabitat();
      ingestFromPulse({
        habitatId: habitat.id,
        signalType: "answer",
        subject: "It works like this",
        body: "",
        pulseId: "pulse-a",
        fromType: "agent",
        fromId: "agent-1",
      });

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.total).toBe(0);
    });

    it("merges signals with same normalized subject", () => {
      const { habitat } = setupHabitat();
      ingestFromPulse({
        habitatId: habitat.id,
        signalType: "finding",
        subject: "Uses Drizzle ORM",
        body: "",
        pulseId: "pulse-1",
        fromType: "agent",
        fromId: "agent-1",
      });
      ingestFromPulse({
        habitatId: habitat.id,
        signalType: "finding",
        subject: "uses drizzle orm",
        body: "",
        pulseId: "pulse-2",
        fromType: "agent",
        fromId: "agent-1",
      });

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.total).toBe(1);
      expect(signals.signals[0].frequency).toBe(2);
    });

    it("deduplicates by pulse ID", () => {
      const { habitat } = setupHabitat();
      ingestFromPulse({
        habitatId: habitat.id,
        signalType: "finding",
        subject: "Uses Drizzle ORM",
        body: "",
        pulseId: "pulse-1",
        fromType: "agent",
        fromId: "agent-1",
      });
      ingestFromPulse({
        habitatId: habitat.id,
        signalType: "finding",
        subject: "Uses Drizzle ORM",
        body: "",
        pulseId: "pulse-1",
        fromType: "agent",
        fromId: "agent-1",
      });

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.total).toBe(1);
      expect(signals.signals[0].frequency).toBe(1);
    });
  });

  describe("ingestFromTaskEvent", () => {
    it("creates pitfall signal for rejected task", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);

      ingestFromTaskEvent({
        habitatId: habitat.id,
        eventType: "rejected",
        taskTitle: "Fix auth bug",
        reason: "Missing tests",
        taskId: "task-1",
        associatedAgentId: "agent-1",
      });

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.total).toBe(1);
      expect(signals.signals[0].skillCategory).toBe("pitfall");
      expect(signals.signals[0].failedTasks).toBe(1);
    });

    it("creates pitfall signal for failed task", () => {
      const { habitat } = setupHabitat();
      ingestFromTaskEvent({
        habitatId: habitat.id,
        eventType: "failed",
        taskTitle: "Fix auth bug",
        reason: "Timeout",
        taskId: "task-1",
        associatedAgentId: "agent-1",
      });

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.total).toBe(1);
      expect(signals.signals[0].sourceSignalType).toBe("blocker");
    });

    it("ignores non-rejected/failed events", () => {
      const { habitat } = setupHabitat();
      ingestFromTaskEvent({
        habitatId: habitat.id,
        eventType: "completed",
        taskTitle: "Fix auth bug",
        taskId: "task-1",
      });

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.total).toBe(0);
    });
  });

  describe("ingestFromComment", () => {
    it("creates signal for agent comment", () => {
      const { habitat } = setupHabitat();
      ingestFromComment({
        habitatId: habitat.id,
        taskId: "task-1",
        content: "This pattern of using raw SQL is error-prone",
        authorType: "agent",
        authorId: "agent-1",
        commentId: "comment-1",
      });

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.total).toBe(1);
      expect(signals.signals[0].skillCategory).toBe("agent_insight");
    });

    it("skips human comments", () => {
      const { habitat } = setupHabitat();
      ingestFromComment({
        habitatId: habitat.id,
        taskId: "task-1",
        content: "Good work",
        authorType: "human",
        authorId: "user-1",
        commentId: "comment-1",
      });

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.total).toBe(0);
    });

    it("truncates long comments for subject", () => {
      const { habitat } = setupHabitat();
      const longContent = "x".repeat(200);
      ingestFromComment({
        habitatId: habitat.id,
        taskId: "task-1",
        content: longContent,
        authorType: "agent",
        authorId: "agent-1",
        commentId: "comment-1",
      });

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.signals[0].subject.endsWith("...")).toBe(true);
    });
  });

  describe("calculateStrength", () => {
    it("returns composite score", () => {
      const signal: HabitatSkillSignal = {
        id: "1",
        habitatId: "h1",
        clusterKey: "test",
        skillCategory: "convention",
        sourceSignalType: "finding",
        sourceType: "pulse",
        subject: "test",
        summary: null,
        strength: 0,
        frequency: 5,
        corroboratingAgents: 3,
        crossMissionCount: 0,
        successfulTasks: 2,
        failedTasks: 2,
        lastSeenAt: new Date().toISOString(),
        firstSeenAt: new Date().toISOString(),
        sourcePulseIds: null,
        sourceTaskIds: null,
        sourceCommentIds: null,
        corroboratingAgentIds: null,
        promotedToSkill: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const strength = calculateStrength(signal);
      expect(strength).toBeGreaterThan(0);
      expect(strength).toBeLessThanOrEqual(1);
    });

    it("penalizes old signals", () => {
      const recent: HabitatSkillSignal = {
        id: "1",
        habitatId: "h1",
        clusterKey: "test",
        skillCategory: "convention",
        sourceSignalType: "finding",
        sourceType: "pulse",
        subject: "test",
        summary: null,
        strength: 0,
        frequency: 1,
        corroboratingAgents: 1,
        crossMissionCount: 0,
        successfulTasks: 0,
        failedTasks: 0,
        lastSeenAt: new Date().toISOString(),
        firstSeenAt: new Date().toISOString(),
        sourcePulseIds: null,
        sourceTaskIds: null,
        sourceCommentIds: null,
        corroboratingAgentIds: null,
        promotedToSkill: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const old = {
        ...recent,
        id: "2",
        lastSeenAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
      };

      expect(calculateStrength(recent)).toBeGreaterThan(calculateStrength(old));
    });
  });

  describe("reclassifyCategory", () => {
    it("promotes convention to domain_knowledge when freq >= 3 and corroboration >= 2", () => {
      const signal: HabitatSkillSignal = {
        id: "1",
        habitatId: "h1",
        clusterKey: "test",
        skillCategory: "convention",
        sourceSignalType: "finding",
        sourceType: "pulse",
        subject: "test",
        summary: null,
        strength: 0,
        frequency: 3,
        corroboratingAgents: 2,
        crossMissionCount: 0,
        successfulTasks: 0,
        failedTasks: 0,
        lastSeenAt: new Date().toISOString(),
        firstSeenAt: new Date().toISOString(),
        sourcePulseIds: null,
        sourceTaskIds: null,
        sourceCommentIds: null,
        corroboratingAgentIds: null,
        promotedToSkill: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      expect(reclassifyCategory(signal)).toBe("domain_knowledge");
    });

    it("promotes to pattern when freq >= 3 and crossMissionCount >= 2", () => {
      const signal: HabitatSkillSignal = {
        id: "1",
        habitatId: "h1",
        clusterKey: "test",
        skillCategory: "pitfall",
        sourceSignalType: "warning",
        sourceType: "pulse",
        subject: "test",
        summary: null,
        strength: 0,
        frequency: 3,
        corroboratingAgents: 1,
        crossMissionCount: 2,
        successfulTasks: 0,
        failedTasks: 0,
        lastSeenAt: new Date().toISOString(),
        firstSeenAt: new Date().toISOString(),
        sourcePulseIds: null,
        sourceTaskIds: null,
        sourceCommentIds: null,
        corroboratingAgentIds: null,
        promotedToSkill: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      expect(reclassifyCategory(signal)).toBe("pattern");
    });

    it("keeps category unchanged when thresholds not met", () => {
      const signal: HabitatSkillSignal = {
        id: "1",
        habitatId: "h1",
        clusterKey: "test",
        skillCategory: "convention",
        sourceSignalType: "finding",
        sourceType: "pulse",
        subject: "test",
        summary: null,
        strength: 0,
        frequency: 1,
        corroboratingAgents: 1,
        crossMissionCount: 0,
        successfulTasks: 0,
        failedTasks: 0,
        lastSeenAt: new Date().toISOString(),
        firstSeenAt: new Date().toISOString(),
        sourcePulseIds: null,
        sourceTaskIds: null,
        sourceCommentIds: null,
        corroboratingAgentIds: null,
        promotedToSkill: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      expect(reclassifyCategory(signal)).toBe("convention");
    });
  });

  describe("scoreAllSignals", () => {
    it("updates strength and promotes high-scoring signals", () => {
      const { habitat } = setupHabitat();
      for (let i = 0; i < 5; i++) {
        ingestFromPulse({
          habitatId: habitat.id,
          signalType: "finding",
          subject: "Uses Drizzle ORM",
          body: "",
          pulseId: `pulse-${i}`,
          fromType: "agent",
          fromId: `agent-${i % 3}`,
        });
      }

      scoreAllSignals(habitat.id);

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.signals[0].strength).toBeGreaterThan(0);
      expect(signals.signals[0].promotedToSkill).toBe(1);
    });
  });

  describe("contributeSignal", () => {
    it("creates new signal from manual contribution", () => {
      const { habitat } = setupHabitat();
      const signal = contributeSignal(habitat.id, {
        insight: "Manual insight about architecture",
        skillCategory: "convention",
      });

      expect(signal).not.toBeNull();
      expect(signal!.skillCategory).toBe("convention");
    });

    it("merges with existing signal of same subject", () => {
      const { habitat } = setupHabitat();
      contributeSignal(habitat.id, {
        insight: "Uses Drizzle ORM",
        skillCategory: "convention",
      });
      const signal = contributeSignal(habitat.id, {
        insight: "Uses Drizzle ORM",
        skillCategory: "convention",
      });

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.total).toBe(1);
      expect(signals.signals[0].frequency).toBe(2);
    });
  });

  describe("generateSkillDocument", () => {
    it("generates markdown with promoted signals", () => {
      const { habitat } = setupHabitat();
      skillRepo.getOrCreateSkill(habitat.id);

      skillRepo.createSignal({
        habitatId: habitat.id,
        clusterKey: "uses-drizzle-orm",
        skillCategory: "convention",
        sourceSignalType: "finding",
        subject: "Uses Drizzle ORM",
        summary: "The project uses Drizzle ORM for database access",
        sourcePulseId: "pulse-1",
      });
      const signals = skillRepo.getAllSignalsByHabitat(habitat.id);
      skillRepo.updateSignal(signals[0].id, { promotedToSkill: 1, strength: 0.8 });

      const doc = generateSkillDocument(habitat.id);
      expect(doc).toContain("Habitat Knowledge: Test Habitat");
      expect(doc).toContain("Architecture & Conventions");
      expect(doc).toContain("Drizzle ORM");
    });

    it("returns empty document for habitat with no promoted signals", () => {
      const { habitat } = setupHabitat();
      skillRepo.getOrCreateSkill(habitat.id);

      const doc = generateSkillDocument(habitat.id);
      expect(doc).toContain("Habitat Knowledge");
      expect(doc).not.toContain("## Architecture");
    });
  });

  describe("regenerateSkill", () => {
    it("updates skill content after regeneration", () => {
      const { habitat } = setupHabitat();
      for (let i = 0; i < 6; i++) {
        ingestFromPulse({
          habitatId: habitat.id,
          signalType: "finding",
          subject: "Uses Drizzle ORM",
          body: "",
          pulseId: `pulse-${i}`,
          fromType: "agent",
          fromId: `agent-${i % 3}`,
        });
      }

      regenerateSkill(habitat.id);

      const skill = skillRepo.getSkillByHabitatId(habitat.id);
      expect(skill).not.toBeNull();
      expect(skill!.signalCount).toBeGreaterThan(0);
      expect(skill!.content).toContain("Habitat Knowledge");
    });
  });
});
