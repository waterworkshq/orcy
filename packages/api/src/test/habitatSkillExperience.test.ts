import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as skillRepo from "../repositories/habitatSkill.js";
import {
  ingestExperienceSignal,
  ingestFromPulse,
  classifyExperienceToCategory,
  EXPERIENCE_CATEGORY_TO_SKILL,
} from "../services/habitatSkillService.js";
import type { ExperienceCategory } from "@orcy/shared";
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

const ALL_CATEGORIES: ExperienceCategory[] = [
  "stuck",
  "confused",
  "backtrack",
  "surprised",
  "ambiguous",
  "sidetracked",
  "smooth",
];

describe("habitatSkillService.experience", () => {
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

  describe("classifyExperienceToCategory", () => {
    it("maps stuck/confused/backtrack to pitfall", () => {
      expect(classifyExperienceToCategory("stuck")).toBe("pitfall");
      expect(classifyExperienceToCategory("confused")).toBe("pitfall");
      expect(classifyExperienceToCategory("backtrack")).toBe("pitfall");
    });

    it("maps surprised/ambiguous to domain_knowledge", () => {
      expect(classifyExperienceToCategory("surprised")).toBe("domain_knowledge");
      expect(classifyExperienceToCategory("ambiguous")).toBe("domain_knowledge");
    });

    it("maps sidetracked to anti_patterns", () => {
      expect(classifyExperienceToCategory("sidetracked")).toBe("anti_patterns");
    });

    it("maps smooth to pattern", () => {
      expect(classifyExperienceToCategory("smooth")).toBe("pattern");
    });

    it("falls back to agent_insight for unknown categories", () => {
      expect(classifyExperienceToCategory("frustrated")).toBe("agent_insight");
      expect(classifyExperienceToCategory("")).toBe("agent_insight");
    });

    it("EXPERIENCE_CATEGORY_TO_SKILL covers all 7 categories", () => {
      for (const cat of ALL_CATEGORIES) {
        expect(EXPERIENCE_CATEGORY_TO_SKILL[cat]).toBeDefined();
      }
    });
  });

  describe("ingestExperienceSignal", () => {
    it("creates a signal with the mapped skill category for each of the 7 categories", () => {
      const { habitat } = setupHabitat();
      const expectedMapping: Record<ExperienceCategory, string> = {
        stuck: "pitfall",
        confused: "pitfall",
        backtrack: "pitfall",
        surprised: "domain_knowledge",
        ambiguous: "domain_knowledge",
        sidetracked: "anti_patterns",
        smooth: "pattern",
      };

      for (const category of ALL_CATEGORIES) {
        ingestExperienceSignal({
          habitatId: habitat.id,
          subject: `Signal for ${category}`,
          body: `Body describing the ${category} experience`,
          pulseId: `pulse-${category}`,
          fromType: "agent",
          fromId: `agent-${category}`,
          experience: category,
        });
      }

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.total).toBe(7);
      for (const signal of signals.signals) {
        const category = signal.subject.replace("Signal for ", "") as ExperienceCategory;
        expect(signal.skillCategory).toBe(expectedMapping[category]);
      }
    });

    it("records sourceSignalType='experience' so the implicit provenance is recoverable", () => {
      const { habitat } = setupHabitat();
      ingestExperienceSignal({
        habitatId: habitat.id,
        subject: "Hit unexpected rate limit after retries",
        body: "",
        pulseId: "pulse-impl-1",
        fromType: "agent",
        fromId: "agent-1",
        experience: "stuck",
      });

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.total).toBe(1);
      expect(signals.signals[0].sourceSignalType).toBe("experience");
    });

    it("merges experience signals with the same normalized subject across agents (frequency drives strength)", () => {
      const { habitat } = setupHabitat();
      const subject = "Hit unexpected API rate limit after 5 retries";
      for (let i = 0; i < 3; i++) {
        ingestExperienceSignal({
          habitatId: habitat.id,
          subject,
          body: "",
          pulseId: `pulse-${i}`,
          fromType: "agent",
          fromId: `agent-${i}`,
          experience: "stuck",
        });
      }

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.total).toBe(1);
      expect(signals.signals[0].frequency).toBe(3);
      expect(signals.signals[0].corroboratingAgents).toBe(3);
      expect(signals.signals[0].sourceSignalType).toBe("experience");
      expect(signals.signals[0].skillCategory).toBe("pitfall");
    });

    it("clusters signals by subject independent of category (same subject, different categories still merge)", () => {
      const { habitat } = setupHabitat();
      const subject = "Worked through the auth migration";
      ingestExperienceSignal({
        habitatId: habitat.id,
        subject,
        body: "",
        pulseId: "p1",
        fromType: "agent",
        fromId: "agent-1",
        experience: "stuck",
      });
      ingestExperienceSignal({
        habitatId: habitat.id,
        subject,
        body: "",
        pulseId: "p2",
        fromType: "agent",
        fromId: "agent-1",
        experience: "smooth",
      });

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.total).toBe(1);
      expect(signals.signals[0].frequency).toBe(2);
    });

    it("skips system-originated experience signals", () => {
      const { habitat } = setupHabitat();
      ingestExperienceSignal({
        habitatId: habitat.id,
        subject: "System-injected signal",
        body: "",
        pulseId: "pulse-sys",
        fromType: "system",
        fromId: "system",
        experience: "stuck",
      });

      expect(skillRepo.getSignalsByHabitat(habitat.id).total).toBe(0);
    });

    it("deduplicates by pulse ID on repeated ingestion", () => {
      const { habitat } = setupHabitat();
      const opts = {
        habitatId: habitat.id,
        subject: "Hit unexpected rate limit",
        body: "",
        pulseId: "pulse-dedup",
        fromType: "agent" as const,
        fromId: "agent-1",
        experience: "stuck" as ExperienceCategory,
      };
      ingestExperienceSignal(opts);
      ingestExperienceSignal(opts);

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.total).toBe(1);
      expect(signals.signals[0].frequency).toBe(1);
    });

    it("accepts remote-human and remote-orcy origins", () => {
      const { habitat } = setupHabitat();
      ingestExperienceSignal({
        habitatId: habitat.id,
        subject: "Remote contributor signal",
        body: "",
        pulseId: "pulse-remote",
        fromType: "remote_orcy",
        fromId: "remote-agent-1",
        experience: "surprised",
      });

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.total).toBe(1);
      expect(signals.signals[0].skillCategory).toBe("domain_knowledge");
    });

    it("persists the body as summary so failure context can surface it later", () => {
      const { habitat } = setupHabitat();
      ingestExperienceSignal({
        habitatId: habitat.id,
        subject: "Backtrack from REST to GraphQL",
        body: "Started down REST path, discovered the gateway requires GraphQL schema.",
        pulseId: "pulse-body",
        fromType: "agent",
        fromId: "agent-1",
        experience: "backtrack",
      });

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.signals[0].summary).toContain("REST path");
    });
  });

  describe("ingestFromPulse unchanged by experience addition", () => {
    it("still maps finding to convention via the pre-existing path", () => {
      const { habitat } = setupHabitat();
      ingestFromPulse({
        habitatId: habitat.id,
        signalType: "finding",
        subject: "Project uses Drizzle ORM",
        body: "",
        pulseId: "pulse-finding",
        fromType: "agent",
        fromId: "agent-1",
      });

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.total).toBe(1);
      expect(signals.signals[0].skillCategory).toBe("convention");
      expect(signals.signals[0].sourceSignalType).toBe("finding");
    });

    it("does NOT route experience signalType through ingestFromPulse when called directly", () => {
      const { habitat } = setupHabitat();
      ingestFromPulse({
        habitatId: habitat.id,
        signalType: "experience",
        subject: "Would fall through to agent_insight",
        body: "",
        pulseId: "pulse-leak",
        fromType: "agent",
        fromId: "agent-1",
      });

      const signals = skillRepo.getSignalsByHabitat(habitat.id);
      expect(signals.total).toBe(1);
      // ingestFromPulse has no SKILL_CATEGORY_MAP entry for 'experience' → falls through to agent_insight.
      // This documents the reason initSkillHooks branches early: callers posting experience signals
      // through the MCP tool always go through ingestExperienceSignal, not ingestFromPulse.
      expect(signals.signals[0].skillCategory).toBe("agent_insight");
      expect(signals.signals[0].sourceSignalType).toBe("experience");
    });
  });
});
