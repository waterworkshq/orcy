/**
 * Phase 5 detected-signal pipeline tests.
 *
 * Covers the activated detected-signal flow end-to-end:
 *  - PulseWriter.createDetectedSignal routes through pulseService.createPulseAndNotify (hooks
 *    fire) + broadcastPulse (SSE event emitted).
 *  - Agent-authored POST with signalType "detected" is rejected at validatePostBody.
 *  - Detected signals are ingested into habitat_skill_signals with category "detected_patterns"
 *    (the fromType:"system" skip is exempted for detected).
 *  - Wiki signal surface returns detected pulses with detector attribution.
 *  - classifyPulseToCategory + SKILL_CATEGORY_MAP wiring for "detected".
 *
 * Per ADR-0013 (detected-signal category) + ADR-0014 (lifecycle interceptor contract).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as skillRepo from "../repositories/habitatSkill.js";
import { buildPluginContext } from "../plugins/context.js";
import {
  classifyPulseToCategory,
  ingestFromPulse,
  initSkillHooks,
} from "../services/habitatSkillService.js";
import * as surface from "../services/wikiSignalSurfaceService.js";
import { postHabitatPulseSignal } from "../services/pulseService.js";
import { badRequest, isAppError } from "../errors.js";
import { habitats, columns, missions, pulses, habitatSkillSignals } from "../db/schema/index.js";
const publishMock = vi.fn();
vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: (...args: unknown[]) => publishMock(...args) },
}));

function setupHabitat() {
  const habitat = habitatRepo.createHabitat({ name: "Detected Signal Test Habitat" });
  const col = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0 });
  return { habitat, col };
}

describe("detected signal pipeline (Phase 5)", () => {
  beforeEach(async () => {
    await initTestDb();
    publishMock.mockClear();
    // initSkillHooks registers the pulseService.onPulseCreated subscriber that routes new pulses
    // into habitat_skill_signals via ingestFromPulse. In production this is called once from
    // src/index.ts; in unit tests we must invoke it manually so createPulseAndNotify fires hooks.
    initSkillHooks();
    const db = getDb();
    db.delete(habitatSkillSignals).run();
    db.delete(pulses).run();
    db.delete(missions).run();
    db.delete(columns).run();
    db.delete(habitats).run();
  });

  afterEach(() => {
    closeDb();
  });

  describe("classifyPulseToCategory + SKILL_CATEGORY_MAP wiring", () => {
    it("maps 'detected' to the 'detected_patterns' skill category (ADR-0013)", () => {
      expect(classifyPulseToCategory("detected")).toBe("detected_patterns");
    });
  });

  describe("ingestFromPulse — detected exemption from system-skip", () => {
    it("ingests a detected signal even though fromType is 'system' (server-injected provenance)", () => {
      const { habitat } = setupHabitat();

      ingestFromPulse({
        habitatId: habitat.id,
        signalType: "detected",
        subject: "frustration detected",
        body: "regex match on pulse text",
        pulseId: "pulse-x",
        fromType: "system",
        fromId: "regex-frustration-plugin",
      });

      const rows = skillRepo.getSignalsByHabitat(habitat.id);
      expect(rows.signals).toHaveLength(1);
      expect(rows.signals[0].skillCategory).toBe("detected_patterns");
      expect(rows.signals[0].sourceSignalType).toBe("detected");
    });

    it("still skips non-detected system-authored signals (emitAutoSignal bookkeeping)", () => {
      const { habitat } = setupHabitat();

      ingestFromPulse({
        habitatId: habitat.id,
        signalType: "directive",
        subject: "auto directive",
        body: "bookkeeping",
        pulseId: "pulse-y",
        fromType: "system",
        fromId: "system",
      });

      expect(skillRepo.getSignalsByHabitat(habitat.id).signals).toHaveLength(0);
    });
  });

  describe("PulseWriter.createDetectedSignal — full pipeline", () => {
    it("writes the pulse, fires skill hooks (detected_patterns row), and broadcasts SSE", async () => {
      const { habitat } = setupHabitat();

      const ctx = buildPluginContext({
        pluginId: "regex-frustration",
        contributionId: "detector-1",
        habitatId: habitat.id,
        runId: "run-42",
        requires: ["pulseWriter"],
      });

      const pulse = await ctx.pulseWriter!.createDetectedSignal({
        signalType: "detected",
        subject: "frustration detected",
        body: "matched /stuck|blocked|giving up/i",
        metadata: { confidence: 0.82 },
      });

      // Pulse row written with server-injected provenance.
      expect(pulse.id).toBeTruthy();
      expect(pulse.signalType).toBe("detected");
      expect(pulse.fromType).toBe("system");
      expect(pulse.fromId).toBe("regex-frustration");
      expect(pulse.metadata.detected).toBe(true);
      expect(pulse.metadata.detector).toBe("regex-frustration");
      expect(pulse.metadata.detectorRunId).toBe("run-42");

      // Skill ingestion hook fired (the fromType:"system" + detected exemption).
      const skillRows = skillRepo.getSignalsByHabitat(habitat.id);
      expect(skillRows.signals).toHaveLength(1);
      expect(skillRows.signals[0].skillCategory).toBe("detected_patterns");

      // SSE broadcast fired (pulse.signal_posted event).
      expect(publishMock).toHaveBeenCalledTimes(1);
      const event = publishMock.mock.calls[0][1];
      expect(event.type).toBe("pulse.signal_posted");
      expect(event.data.signalType).toBe("detected");
    });

    it("rejects non-detected signalType ( PulseWriter is detected-only by ADR-0012)", async () => {
      const { habitat } = setupHabitat();
      const ctx = buildPluginContext({
        pluginId: "p",
        contributionId: "c",
        habitatId: habitat.id,
        runId: "r",
        requires: ["pulseWriter"],
      });

      await expect(
        ctx.pulseWriter!.createDetectedSignal({
          signalType: "experience" as "detected",
          subject: "nope",
        }),
      ).rejects.toThrow(/signalType "detected"/);
    });
  });

  describe("validatePostBody — agent-authored 'detected' rejection", () => {
    it("postHabitatPulseSignal throws badRequest for signalType 'detected' (provenance gate)", () => {
      const { habitat } = setupHabitat();

      let captured: unknown;
      try {
        postHabitatPulseSignal({
          habitatId: habitat.id,
          caller: { type: "agent", id: "agent-1" },
          body: {
            signalType: "detected",
            subject: "forged",
            body: "agent attempts detector output",
          },
        });
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(Error);
      expect(isAppError(captured as Error)).toBe(true);
      expect((captured as { statusCode: number }).statusCode).toBe(400);
      expect((captured as Error).message).toMatch(/detected.*plugin detector/);
      // No pulse row written.
      const rows = pulseRepo.listByHabitatSince(habitat.id, "1970-01-01T00:00:00Z");
      expect(rows.filter((p) => p.signalType === "detected")).toHaveLength(0);
      // validatePostBody is also exported-facing via badRequest shape.
      void badRequest;
    });
  });

  describe("wiki signal surface — detected sub-bucket", () => {
    it("signalClass 'detected' returns only detectedSignals with detector attribution", () => {
      const { habitat } = setupHabitat();

      // Plant one detected pulse directly via the repo (bypassing PulseWriter to keep this test
      // focused on the surface query — the createDetectedSignal end-to-end coverage lives above).
      pulseRepo.createPulse({
        habitatId: habitat.id,
        scope: "habitat",
        fromType: "system",
        fromId: "short-submission",
        signalType: "detected",
        subject: "short submission detected",
        body: "submission under 50 chars",
        metadata: { detected: true, detector: "short-submission", detectorRunId: "r1" },
        isAuto: true,
      });
      // Plant a finding pulse that must NOT appear in the detected bucket.
      pulseRepo.createPulse({
        habitatId: habitat.id,
        scope: "habitat",
        fromType: "agent",
        fromId: "agent-1",
        signalType: "finding",
        subject: "unrelated finding",
        body: "should not leak into detected",
      });

      const result = surface.getSignalSurfaceForAgent(habitat.id, { signalClass: "detected" });

      expect(result.detectedSignals).toHaveLength(1);
      expect(result.detectedSignals?.[0].signalType).toBe("detected");
      expect(result.detectedSignals?.[0].metadata.detector).toBe("short-submission");
      // Other buckets are NOT populated for signalClass "detected".
      expect(result.experiencePatterns).toBeUndefined();
      expect(result.findings).toBeUndefined();
      expect(result.unstructuredFindings).toBeUndefined();
    });

    it("signalClass 'both' does NOT include detected (detected stays a separate class per ADR-0013)", () => {
      const { habitat } = setupHabitat();
      pulseRepo.createPulse({
        habitatId: habitat.id,
        scope: "habitat",
        fromType: "system",
        fromId: "regex-frustration",
        signalType: "detected",
        subject: "detected signal",
        body: "x",
        metadata: { detected: true, detector: "regex-frustration", detectorRunId: "r" },
        isAuto: true,
      });

      const result = surface.getSignalSurfaceForAgent(habitat.id, { signalClass: "both" });

      // 'both' keeps its v0.21 meaning (experience + findings) — detected requires explicit opt-in.
      expect(result.detectedSignals).toBeUndefined();
    });
  });
});
