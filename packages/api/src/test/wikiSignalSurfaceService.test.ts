import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as skillRepo from "../repositories/habitatSkill.js";
import * as surface from "../services/wikiSignalSurfaceService.js";
import {
  habitats,
  columns,
  missions,
  tasks,
  agents,
  habitatSkillSignals,
  pulses,
} from "../db/schema/index.js";

function setupHabitat() {
  const habitat = habitatRepo.createHabitat({ name: "Signal Surface Test Habitat" });
  const col = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0 });
  return { habitat, col };
}

function setupMission(habitatId: string, colId: string) {
  return missionRepo.createMission({
    habitatId,
    columnId: colId,
    title: "Signal Surface Mission",
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
  db.delete(habitatSkillSignals).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(pulses).run();
  db.delete(agents).run();
  db.delete(columns).run();
  db.delete(habitats).run();
});

afterEach(() => {
  closeDb();
});

describe("wikiSignalSurfaceService.getExperienceSurface — privacy invariant", () => {
  it("returns aggregates with frequency and success/fail counts", () => {
    const { habitat } = setupHabitat();

    skillRepo.createSignal({
      habitatId: habitat.id,
      clusterKey: "uses-drizzle",
      skillCategory: "pitfall",
      sourceSignalType: "experience",
      subject: "Uses Drizzle",
      summary: "Stuck on Drizzle migrations",
    });

    const result = surface.getExperienceSurface(habitat.id);
    expect(result.habitatId).toBe(habitat.id);
    expect(result.aggregates).toHaveLength(1);
    expect(result.aggregates[0]).toMatchObject({
      subject: "Uses Drizzle",
      skillCategory: "pitfall",
      sourceSignalType: "experience",
      frequency: 1,
      successfulTasks: 0,
      failedTasks: 0,
      corroboratingAgents: 1,
    });
  });

  it("strips individual pulse / task / comment / agent IDs from the projection", () => {
    const { habitat } = setupHabitat();
    skillRepo.createSignal({
      habitatId: habitat.id,
      clusterKey: "drizzle-2",
      skillCategory: "pitfall",
      sourceSignalType: "experience",
      subject: "Drizzle pitfalls",
      summary: "stuff",
      sourcePulseId: "pulse-secret-1",
      sourceTaskId: "task-secret-1",
      agentId: "agent-secret-1",
    });

    const result = surface.getExperienceSurface(habitat.id);
    const aggregate = result.aggregates[0];

    expect(aggregate).not.toHaveProperty("sourcePulseIds");
    expect(aggregate).not.toHaveProperty("sourceTaskIds");
    expect(aggregate).not.toHaveProperty("sourceCommentIds");
    expect(aggregate).not.toHaveProperty("corroboratingAgentIds");

    const serialised = JSON.stringify(aggregate);
    expect(serialised).not.toContain("pulse-secret-1");
    expect(serialised).not.toContain("task-secret-1");
    expect(serialised).not.toContain("agent-secret-1");
  });

  it("returns only experience-derived skill categories (no agent_insight / convention)", () => {
    const { habitat } = setupHabitat();
    skillRepo.createSignal({
      habitatId: habitat.id,
      clusterKey: "a",
      skillCategory: "agent_insight",
      sourceSignalType: "agent_comment",
      subject: "Insight A",
    });
    skillRepo.createSignal({
      habitatId: habitat.id,
      clusterKey: "b",
      skillCategory: "convention",
      sourceSignalType: "manual_contribution",
      subject: "Convention B",
    });
    skillRepo.createSignal({
      habitatId: habitat.id,
      clusterKey: "c",
      skillCategory: "pitfall",
      sourceSignalType: "experience",
      subject: "Pitfall C",
    });
    skillRepo.createSignal({
      habitatId: habitat.id,
      clusterKey: "d",
      skillCategory: "domain_knowledge",
      sourceSignalType: "experience",
      subject: "Domain D",
    });
    skillRepo.createSignal({
      habitatId: habitat.id,
      clusterKey: "e",
      skillCategory: "anti_patterns",
      sourceSignalType: "experience",
      subject: "Anti-Pattern E",
    });
    skillRepo.createSignal({
      habitatId: habitat.id,
      clusterKey: "f",
      skillCategory: "pattern",
      sourceSignalType: "experience",
      subject: "Pattern F",
    });

    const result = surface.getExperienceSurface(habitat.id);
    expect(result.aggregates).toHaveLength(4);
    const categories = result.aggregates.map((a) => a.skillCategory).sort();
    expect(categories).toEqual(["anti_patterns", "domain_knowledge", "pattern", "pitfall"]);
  });

  it("narrows by category when provided", () => {
    const { habitat } = setupHabitat();
    skillRepo.createSignal({
      habitatId: habitat.id,
      clusterKey: "a",
      skillCategory: "pitfall",
      sourceSignalType: "experience",
      subject: "Pitfall",
    });
    skillRepo.createSignal({
      habitatId: habitat.id,
      clusterKey: "b",
      skillCategory: "pattern",
      sourceSignalType: "experience",
      subject: "Pattern",
    });

    const result = surface.getExperienceSurface(habitat.id, { category: "pitfall" });
    expect(result.aggregates).toHaveLength(1);
    expect(result.aggregates[0].skillCategory).toBe("pitfall");
    expect(result.category).toBe("pitfall");
  });

  it("rejects an out-of-subset category", () => {
    const { habitat } = setupHabitat();
    expect(() => surface.getExperienceSurface(habitat.id, { category: "agent_insight" })).toThrow(
      /Invalid experience category/,
    );
  });

  it("filters by timeWindow", () => {
    const { habitat } = setupHabitat();
    const sig = skillRepo.createSignal({
      habitatId: habitat.id,
      clusterKey: "old",
      skillCategory: "pitfall",
      sourceSignalType: "experience",
      subject: "Old signal",
    });

    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(sig.lastSeenAt).toBeTruthy();

    const result = surface.getExperienceSurface(habitat.id, { timeWindow: "1 days" });
    expect(result.aggregates).toHaveLength(1);

    void future;
  });

  it("accepts domain filter as a no-op (deferred per MEMORY)", () => {
    const { habitat } = setupHabitat();
    skillRepo.createSignal({
      habitatId: habitat.id,
      clusterKey: "a",
      skillCategory: "pitfall",
      sourceSignalType: "experience",
      subject: "Anything",
    });

    const result = surface.getExperienceSurface(habitat.id, { domain: "backend" });
    expect(result.domain).toBe("backend");
    expect(result.aggregates).toHaveLength(1);
  });
});

describe("wikiSignalSurfaceService.getFindingsSurface — structured/unstructured split", () => {
  it("splits structured and unstructured findings correctly", () => {
    const { habitat } = setupHabitat();

    pulseRepo.createPulse({
      habitatId: habitat.id,
      scope: "habitat",
      fromType: "human",
      fromId: "human-1",
      signalType: "finding",
      subject: "Structured finding",
      body: "has metadata",
      metadata: {
        findingKind: "bug",
        severity: "high",
        affectedFiles: ["src/foo.ts"],
        blocksCurrentWork: true,
      },
    });

    pulseRepo.createPulse({
      habitatId: habitat.id,
      scope: "habitat",
      fromType: "human",
      fromId: "human-2",
      signalType: "finding",
      subject: "Free-form finding",
      body: "no metadata",
    });

    const result = surface.getFindingsSurface(habitat.id);
    expect(result.structuredFindings).toHaveLength(1);
    expect(result.unstructuredFindings).toHaveLength(1);
    expect(result.structuredFindings[0].subject).toBe("Structured finding");
    expect(result.unstructuredFindings[0].subject).toBe("Free-form finding");
  });

  it("preserves attribution (fromType + fromId) on findings", () => {
    const { habitat } = setupHabitat();
    pulseRepo.createPulse({
      habitatId: habitat.id,
      scope: "habitat",
      fromType: "agent",
      fromId: "agent-claude-7",
      signalType: "finding",
      subject: "Agent found something",
      metadata: {
        findingKind: "convention",
        severity: "low",
        affectedFiles: ["x"],
        blocksCurrentWork: false,
      },
    });

    const result = surface.getFindingsSurface(habitat.id);
    expect(result.structuredFindings).toHaveLength(1);
    expect(result.structuredFindings[0].fromType).toBe("agent");
    expect(result.structuredFindings[0].fromId).toBe("agent-claude-7");
  });

  it("filters by findingKind when supplied", () => {
    const { habitat } = setupHabitat();
    pulseRepo.createPulse({
      habitatId: habitat.id,
      scope: "habitat",
      fromType: "human",
      fromId: "h",
      signalType: "finding",
      subject: "Bug",
      metadata: {
        findingKind: "bug",
        severity: "low",
        affectedFiles: ["x"],
        blocksCurrentWork: false,
      },
    });
    pulseRepo.createPulse({
      habitatId: habitat.id,
      scope: "habitat",
      fromType: "human",
      fromId: "h",
      signalType: "finding",
      subject: "Perf",
      metadata: {
        findingKind: "performance",
        severity: "low",
        affectedFiles: ["x"],
        blocksCurrentWork: false,
      },
    });

    const result = surface.getFindingsSurface(habitat.id, { findingKind: "bug" });
    expect(result.findingKind).toBe("bug");
    expect(result.structuredFindings).toHaveLength(1);
    expect(result.structuredFindings[0].subject).toBe("Bug");
  });

  it("excludes non-finding signal types", () => {
    const { habitat } = setupHabitat();
    pulseRepo.createPulse({
      habitatId: habitat.id,
      scope: "habitat",
      fromType: "human",
      fromId: "h",
      signalType: "context",
      subject: "Context signal — not a finding",
    });
    pulseRepo.createPulse({
      habitatId: habitat.id,
      scope: "habitat",
      fromType: "human",
      fromId: "h",
      signalType: "finding",
      subject: "Real finding",
    });

    const result = surface.getFindingsSurface(habitat.id);
    expect(result.structuredFindings).toHaveLength(0);
    expect(result.unstructuredFindings).toHaveLength(1);
    expect(result.unstructuredFindings[0].subject).toBe("Real finding");
  });
});

describe("wikiSignalSurfaceService.getSignalSurfaceForAgent — signalClass routing", () => {
  it("'experience' signalClass returns only experiencePatterns", () => {
    const { habitat } = setupHabitat();
    skillRepo.createSignal({
      habitatId: habitat.id,
      clusterKey: "exp-1",
      skillCategory: "pitfall",
      sourceSignalType: "experience",
      subject: "Pitfall",
    });
    pulseRepo.createPulse({
      habitatId: habitat.id,
      scope: "habitat",
      fromType: "human",
      fromId: "h",
      signalType: "finding",
      subject: "Finding — should be filtered out",
    });

    const result = surface.getSignalSurfaceForAgent(habitat.id, { signalClass: "experience" });
    expect(result.experiencePatterns).toHaveLength(1);
    expect(result.findings).toBeUndefined();
    expect(result.unstructuredFindings).toBeUndefined();
  });

  it("'finding' signalClass returns only findings + unstructuredFindings", () => {
    const { habitat } = setupHabitat();
    skillRepo.createSignal({
      habitatId: habitat.id,
      clusterKey: "exp-1",
      skillCategory: "pitfall",
      sourceSignalType: "experience",
      subject: "Pitfall — should be filtered out",
    });
    pulseRepo.createPulse({
      habitatId: habitat.id,
      scope: "habitat",
      fromType: "human",
      fromId: "h",
      signalType: "finding",
      subject: "Structured finding",
      metadata: {
        findingKind: "bug",
        severity: "high",
        affectedFiles: ["x"],
        blocksCurrentWork: true,
      },
    });
    pulseRepo.createPulse({
      habitatId: habitat.id,
      scope: "habitat",
      fromType: "human",
      fromId: "h",
      signalType: "finding",
      subject: "Free-form finding",
    });

    const result = surface.getSignalSurfaceForAgent(habitat.id, { signalClass: "finding" });
    expect(result.experiencePatterns).toBeUndefined();
    expect(result.findings).toHaveLength(1);
    expect(result.unstructuredFindings).toHaveLength(1);
  });

  it("'both' signalClass returns all three arrays in parallel (not correlated)", () => {
    const { habitat } = setupHabitat();
    skillRepo.createSignal({
      habitatId: habitat.id,
      clusterKey: "exp-1",
      skillCategory: "pitfall",
      sourceSignalType: "experience",
      subject: "Pitfall",
    });
    pulseRepo.createPulse({
      habitatId: habitat.id,
      scope: "habitat",
      fromType: "human",
      fromId: "h",
      signalType: "finding",
      subject: "Structured",
      metadata: {
        findingKind: "bug",
        severity: "high",
        affectedFiles: ["x"],
        blocksCurrentWork: true,
      },
    });

    const result = surface.getSignalSurfaceForAgent(habitat.id, { signalClass: "both" });
    expect(result.experiencePatterns).toHaveLength(1);
    expect(result.findings).toHaveLength(1);
    expect(result.unstructuredFindings).toHaveLength(0);

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("sourcePulseIds");
    expect(serialised).not.toContain("sourceTaskIds");
  });
});
