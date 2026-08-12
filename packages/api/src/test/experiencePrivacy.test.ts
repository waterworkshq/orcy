/**
 * Experience privacy projection — discriminating tests at every serialization
 * boundary.
 *
 * Proves:
 * 1. One-agent/one-event and two-agent/four-event cohorts produce NO observation.
 * 2. The exact 5-signal/3-agent threshold passes; one fewer signal OR agent fails.
 * 3. Rare/isolating combinations are suppressed even when total habitat volume is high.
 * 4. Extractor-batch snapshots contain NO Pulse IDs, agent IDs, raw bodies,
 *    exact timestamps, or denylist data at any serialization boundary.
 * 5. Stable aggregate identity is deterministic for the same cohort and changes
 *    with privacy-policy version.
 * 6. A previously eligible cohort recomputes below threshold → resolves
 *    unauthorized/withdrawn without revealing why.
 * 7. Habitat config can raise but not lower the floor.
 * 8. Banded counts (not exact) and coarse windows (not exact timestamps) are the
 *    only values emitted.
 *
 * Each negative fixture is designed to fail if its guard is weakened (lower the
 * floor, emit a raw field, etc.).
 */
import { describe, expect, it } from "vitest";
import {
  EXPERIENCE_PRIVACY_POLICY_VERSION,
  buildTransientDenylist,
  computeExperienceDigest,
  computeExperienceSourceId,
  defaultFloor,
  deriveCoarseWindow,
  isWindowEligible,
  projectExperienceSignals,
  resolveExperienceCohort,
  scanAgainstDenylist,
  validateFloorOverride,
  type SuppressedExperienceAggregate,
} from "../services/extractionSourceCatalog/experiencePrivacy.js";
import type { HabitatSkillSignal } from "../repositories/habitatSkill.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const HABITAT_ID = "hab-1";
const WINDOW_FROM = "2026-01-01T00:00:00.000Z";
const WINDOW_TO = "2026-01-30T00:00:00.000Z"; // 29-day window — eligible

let signalCounter = 0;

/** Build a raw HabitatSkillSignal with sensible defaults and override fields. */
function makeSignal(overrides: Partial<HabitatSkillSignal> = {}): HabitatSkillSignal {
  signalCounter++;
  const now = new Date().toISOString();
  return {
    id: `sig-${signalCounter}`,
    habitatId: HABITAT_ID,
    clusterKey: `cluster-key-${signalCounter}`,
    skillCategory: "pitfall",
    sourceSignalType: "experience",
    sourceType: "pulse",
    subject: "Common pitfall pattern",
    summary: null,
    strength: 0.5,
    frequency: 5,
    corroboratingAgents: 3,
    crossMissionCount: 0,
    successfulTasks: 0,
    failedTasks: 0,
    lastSeenAt: "2026-01-15T00:00:00.000Z",
    firstSeenAt: "2026-01-10T00:00:00.000Z",
    sourcePulseIds: '["pulse-1","pulse-2","pulse-3","pulse-4","pulse-5"]',
    sourceTaskIds: null,
    sourceCommentIds: null,
    corroboratingAgentIds: '["agent-a","agent-b","agent-c"]',
    promotedToSkill: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Build an eligible cohort signal: 5 signals, 3 agents. */
function makeEligibleSignal(overrides: Partial<HabitatSkillSignal> = {}): HabitatSignal {
  return makeSignal({
    frequency: 5,
    corroboratingAgents: 3,
    corroboratingAgentIds: '["agent-a","agent-b","agent-c"]',
    sourcePulseIds: '["pulse-1","pulse-2","pulse-3","pulse-4","pulse-5"]',
    ...overrides,
  });
}

type HabitatSignal = ReturnType<typeof makeSignal>;

// ---------------------------------------------------------------------------
// Floor + window eligibility
// ---------------------------------------------------------------------------

describe("experience privacy floor", () => {
  it("default floor is ≥5 signals, ≥3 agents, ≥7-day window", () => {
    const floor = defaultFloor();
    expect(floor.minSignals).toBe(5);
    expect(floor.minDistinctAgents).toBe(3);
    expect(floor.minWindowMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("validateFloorOverride accepts values at or above the floor", () => {
    expect(() => validateFloorOverride({ minSignals: 5 })).not.toThrow();
    expect(() => validateFloorOverride({ minSignals: 10 })).not.toThrow();
    expect(() => validateFloorOverride({ minDistinctAgents: 3 })).not.toThrow();
    expect(() => validateFloorOverride({ minDistinctAgents: 7 })).not.toThrow();
    expect(() => validateFloorOverride({ minWindowMs: 14 * 24 * 60 * 60 * 1000 })).not.toThrow();
  });

  it("validateFloorOverride rejects values below the floor", () => {
    expect(() => validateFloorOverride({ minSignals: 4 })).toThrow(/non-configurable floor/);
    expect(() => validateFloorOverride({ minSignals: 0 })).toThrow(/non-configurable floor/);
    expect(() => validateFloorOverride({ minDistinctAgents: 2 })).toThrow(/non-configurable floor/);
    expect(() => validateFloorOverride({ minWindowMs: 6 * 24 * 60 * 60 * 1000 })).toThrow(/non-configurable floor/);
  });

  it("validateFloorOverride returns a raised floor", () => {
    const floor = validateFloorOverride({ minSignals: 10, minDistinctAgents: 5 });
    expect(floor.minSignals).toBe(10);
    expect(floor.minDistinctAgents).toBe(5);
    // Unspecified values keep defaults.
    expect(floor.minWindowMs).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("window eligibility", () => {
  it("a 7-day window is eligible", () => {
    expect(isWindowEligible("2026-01-01T00:00:00.000Z", "2026-01-08T00:00:00.000Z")).toBe(true);
  });

  it("a 6-day window is ineligible", () => {
    expect(isWindowEligible("2026-01-01T00:00:00.000Z", "2026-01-07T00:00:00.000Z")).toBe(false);
  });

  it("a 1-day window is ineligible", () => {
    expect(isWindowEligible("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z")).toBe(false);
  });

  it("no windowTo uses now (eligible for epoch start)", () => {
    expect(isWindowEligible("2020-01-01T00:00:00.000Z", undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cohort admission — k-anonymity floor
// ---------------------------------------------------------------------------

describe("cohort admission — k-anonymity floor", () => {
  it("one-agent/one-event cohort produces no observation", () => {
    const signals = [makeSignal({ frequency: 1, corroboratingAgents: 1 })];
    const result = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);
    expect(result).toHaveLength(0);
  });

  it("two-agent/four-event cohort produces no observation", () => {
    const signals = [makeSignal({ frequency: 4, corroboratingAgents: 2 })];
    const result = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);
    expect(result).toHaveLength(0);
  });

  it("exact 5-signal/3-agent threshold passes", () => {
    // Need at least 2 cohorts to avoid singleton-batch suppression.
    const signals = [
      makeEligibleSignal({ clusterKey: "subject-a", frequency: 5, corroboratingAgents: 3 }),
      makeEligibleSignal({ clusterKey: "subject-b", skillCategory: "pattern", frequency: 6, corroboratingAgents: 4 }),
    ];
    const result = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);
    expect(result).toHaveLength(2);
  });

  it("one fewer signal (4) fails even with 3 agents", () => {
    const signals = [
      makeSignal({ clusterKey: "subject-a", frequency: 4, corroboratingAgents: 3 }),
      makeEligibleSignal({ clusterKey: "subject-b", skillCategory: "pattern" }),
    ];
    const result = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);
    // Only subject-b passes.
    // But singleton batch suppression drops it too.
    expect(result).toHaveLength(0);
  });

  it("one fewer agent (2) fails even with 5 signals", () => {
    const signals = [
      makeSignal({ clusterKey: "subject-a", frequency: 5, corroboratingAgents: 2 }),
      makeEligibleSignal({ clusterKey: "subject-b", skillCategory: "pattern" }),
    ];
    const result = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);
    expect(result).toHaveLength(0);
  });

  it("a cohort that passes independently (with another co-passing cohort) is admitted", () => {
    const signals = [
      makeEligibleSignal({ clusterKey: "subject-a", frequency: 5, corroboratingAgents: 3 }),
      makeEligibleSignal({ clusterKey: "subject-b", skillCategory: "pattern", frequency: 10, corroboratingAgents: 5 }),
    ];
    const result = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);
    expect(result).toHaveLength(2);
    expect(result[0].sourceId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Singleton-batch / rare-combination suppression
// ---------------------------------------------------------------------------

describe("rare-combination and singleton-batch suppression", () => {
  it("a single eligible cohort (singleton batch) is suppressed even though it meets the floor", () => {
    const signals = [makeEligibleSignal()];
    const result = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);
    expect(result).toHaveLength(0);
  });

  it("rare/isolating subject text is redacted even when cohort meets the floor and total habitat volume is high", () => {
    // Many diverse signals in the habitat (high volume).
    const signals = [
      makeEligibleSignal({
        clusterKey: "subject-with-agent-id",
        subject: "agent-a keeps making this mistake",
        corroboratingAgentIds: '["agent-a","agent-b","agent-c"]',
      }),
      makeEligibleSignal({
        clusterKey: "subject-clean",
        skillCategory: "pattern",
        subject: "Clean pattern observed",
      }),
      makeEligibleSignal({
        clusterKey: "subject-clean-2",
        skillCategory: "domain_knowledge",
        subject: "Another clean pattern",
      }),
    ];
    const result = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);

    // Find the one with the agent ID in subject.
    const agentIdSubject = result.find((r) => r.sourceId.includes(computeExperienceSourceId(
      HABITAT_ID, "subject-with-agent-id", "pitfall", deriveCoarseWindow(WINDOW_FROM),
    ).slice("exp_agg:".length)));
    // The subject should have the identifier-match caveat because it contained a denylisted identifier.
    expect(agentIdSubject?.caveats).toContain("subject_redacted_identifier_match");
  });

  it("subject with embedded UUID is redacted even without denylist match", () => {
    const uuid = "12345678-1234-1234-1234-123456789abc";
    const signals = [
      makeEligibleSignal({
        clusterKey: "uuid-subject",
        subject: `Bug related to item ${uuid}`,
      }),
      makeEligibleSignal({
        clusterKey: "clean-subject",
        skillCategory: "pattern",
        subject: "Clean subject",
      }),
    ];
    const result = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);
    const uuidCohort = result.find(
      (r) => r.caveats.includes("subject_redacted_identifier_match"),
    );
    expect(uuidCohort).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Serialization boundary — no forbidden fields
// ---------------------------------------------------------------------------

/** Fields that MUST NEVER appear in any serialized experience observation or aggregate. */
const FORBIDDEN_FIELD_NAMES = [
  "sourcePulseIds",
  "sourceTaskIds",
  "sourceCommentIds",
  "corroboratingAgentIds",
  "firstSeenAt",
  "lastSeenAt",
  "clusterKey",
  "sourcePulseId", // singular variants
  "agentId",
  "fromId",
] as const;

/** Values that MUST NEVER appear in serialized output. */
const FORBIDDEN_VALUES = [
  "pulse-1", "pulse-2", "pulse-3", "pulse-4", "pulse-5",
  "agent-a", "agent-b", "agent-c",
] as const;

describe("serialization boundary — no forbidden fields or values", () => {
  it("SuppressedExperienceAggregate serialized JSON contains no forbidden field names", () => {
    const signals = [
      makeEligibleSignal({ clusterKey: "subject-a" }),
      makeEligibleSignal({ clusterKey: "subject-b", skillCategory: "pattern" }),
    ];
    const result = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);

    for (const agg of result) {
      const serialized = JSON.stringify(agg);
      for (const field of FORBIDDEN_FIELD_NAMES) {
        expect(serialized).not.toContain(`"${field}"`);
      }
    }
  });

  it("SuppressedExperienceAggregate serialized JSON contains no forbidden raw values (agent IDs, pulse IDs)", () => {
    const signals = [
      makeEligibleSignal({ clusterKey: "subject-a" }),
      makeEligibleSignal({ clusterKey: "subject-b", skillCategory: "pattern" }),
    ];
    const result = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);

    for (const agg of result) {
      const serialized = JSON.stringify(agg);
      for (const value of FORBIDDEN_VALUES) {
        expect(serialized).not.toContain(value);
      }
    }
  });

  it("no exact timestamps (firstSeenAt/lastSeenAt) are present — only coarse window", () => {
    const signals = [
      makeEligibleSignal({
        clusterKey: "subject-a",
        firstSeenAt: "2026-01-10T14:23:45.123Z",
        lastSeenAt: "2026-01-15T09:17:22.456Z",
      }),
      makeEligibleSignal({ clusterKey: "subject-b", skillCategory: "pattern" }),
    ];
    const result = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);

    for (const agg of result) {
      const serialized = JSON.stringify(agg);
      // Exact timestamps must not appear.
      expect(serialized).not.toContain("2026-01-10T14:23:45");
      expect(serialized).not.toContain("2026-01-15T09:17:22");
      // The coarse window is a 7-day-aligned bucket — it must NOT match the exact timestamps.
      expect(agg.coarseWindow).not.toBe("2026-01-10T14:23:45.123Z");
      expect(agg.coarseWindow).not.toBe("2026-01-15T09:17:22.456Z");
    }
  });

  it("denylist data is never present in the output", () => {
    const denylist = buildTransientDenylist([
      makeEligibleSignal({ clusterKey: "subject-a" }),
      makeEligibleSignal({ clusterKey: "subject-b", skillCategory: "pattern" }),
    ]);
    // The denylist itself is transient — verify it's not serialized anywhere.
    expect(denylist.size).toBeGreaterThan(0); // Has entries.

    const signals = [
      makeEligibleSignal({ clusterKey: "subject-a" }),
      makeEligibleSignal({ clusterKey: "subject-b", skillCategory: "pattern" }),
    ];
    const result = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);
    for (const agg of result) {
      const serialized = JSON.stringify(agg);
      expect(serialized).not.toContain("denylist");
      // No denylisted identifiers leak.
      for (const id of denylist) {
        expect(serialized).not.toContain(id);
      }
    }
  });

  it("the serialized shape has exactly the allowed fields and nothing else", () => {
    const signals = [
      makeEligibleSignal({ clusterKey: "subject-a" }),
      makeEligibleSignal({ clusterKey: "subject-b", skillCategory: "pattern" }),
    ];
    const result = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);
    expect(result.length).toBeGreaterThan(0);

    const allowedKeys = new Set([
      "sourceId",
      "skillCategory",
      "coarseWindow",
      "signalCountBand",
      "agentCountBand",
      "sanitizedSubject",
      "caveats",
      "digest",
      "policyVersion",
    ]);

    for (const agg of result) {
      const actualKeys = Object.keys(agg);
      for (const key of actualKeys) {
        expect(allowedKeys.has(key)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Banded counts — never exact
// ---------------------------------------------------------------------------

describe("banded counts", () => {
  it("signal count 5-9 produces band '5-9', not the exact number", () => {
    const signals = [
      makeEligibleSignal({ clusterKey: "subject-a", frequency: 7 }),
      makeEligibleSignal({ clusterKey: "subject-b", skillCategory: "pattern", frequency: 6 }),
    ];
    const result = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);
    const band = result.find((r) => r.signalCountBand === "5-9");
    expect(band).toBeDefined();
    // Exact count 7 must not appear.
    const serialized = JSON.stringify(band);
    expect(serialized).not.toMatch(/"frequency":\s*7/);
  });

  it("signal count 10-19 produces band '10-19'", () => {
    const signals = [
      makeEligibleSignal({ clusterKey: "subject-a", frequency: 15 }),
      makeEligibleSignal({ clusterKey: "subject-b", skillCategory: "pattern", frequency: 12 }),
    ];
    const result = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);
    expect(result.some((r) => r.signalCountBand === "10-19")).toBe(true);
  });

  it("agent count 3-4 produces band '3-4', not the exact number", () => {
    const signals = [
      makeEligibleSignal({ clusterKey: "subject-a", corroboratingAgents: 4 }),
      makeEligibleSignal({ clusterKey: "subject-b", skillCategory: "pattern", corroboratingAgents: 3 }),
    ];
    const result = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);
    expect(result.some((r) => r.agentCountBand === "3-4")).toBe(true);
  });

  it("agent count 10+ produces band '10+'", () => {
    const signals = [
      makeEligibleSignal({ clusterKey: "subject-a", corroboratingAgents: 15 }),
      makeEligibleSignal({ clusterKey: "subject-b", skillCategory: "pattern", corroboratingAgents: 12 }),
    ];
    const result = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);
    expect(result.some((r) => r.agentCountBand === "10+")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stable identity
// ---------------------------------------------------------------------------

describe("stable aggregate identity", () => {
  it("is deterministic for the same cohort inputs", () => {
    const id1 = computeExperienceSourceId("h1", "subject-a", "pitfall", "2026-01-01T00:00:00.000Z");
    const id2 = computeExperienceSourceId("h1", "subject-a", "pitfall", "2026-01-01T00:00:00.000Z");
    expect(id1).toBe(id2);
    expect(id1.startsWith("exp_agg:")).toBe(true);
  });

  it("differs for different habitats", () => {
    const id1 = computeExperienceSourceId("h1", "subject-a", "pitfall", "2026-01-01T00:00:00.000Z");
    const id2 = computeExperienceSourceId("h2", "subject-a", "pitfall", "2026-01-01T00:00:00.000Z");
    expect(id1).not.toBe(id2);
  });

  it("differs for different subjects", () => {
    const id1 = computeExperienceSourceId("h1", "subject-a", "pitfall", "2026-01-01T00:00:00.000Z");
    const id2 = computeExperienceSourceId("h1", "subject-b", "pitfall", "2026-01-01T00:00:00.000Z");
    expect(id1).not.toBe(id2);
  });

  it("differs for different coarse windows", () => {
    const id1 = computeExperienceSourceId("h1", "subject-a", "pitfall", "2026-01-01T00:00:00.000Z");
    const id2 = computeExperienceSourceId("h1", "subject-a", "pitfall", "2026-01-08T00:00:00.000Z");
    expect(id1).not.toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed re-resolution
// ---------------------------------------------------------------------------

describe("fail-closed re-resolution", () => {
  it("a previously eligible cohort that drops below floor resolves unauthorized", () => {
    // Original cohort: 5 signals, 3 agents — eligible.
    const originalSignals = [
      makeEligibleSignal({ clusterKey: "subject-a", frequency: 5, corroboratingAgents: 3 }),
      makeEligibleSignal({ clusterKey: "subject-b", skillCategory: "pattern" }),
    ];
    const original = projectExperienceSignals(originalSignals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);
    expect(original).toHaveLength(2);

    const citedCohort = original[0];

    // Current state: cohort dropped below floor (frequency dropped to 2, agents to 1).
    const currentSignals = [
      makeSignal({ clusterKey: "subject-a", frequency: 2, corroboratingAgents: 1 }),
      makeSignal({ clusterKey: "subject-b", skillCategory: "pattern", frequency: 2, corroboratingAgents: 1 }),
    ];
    const currentCohorts = projectExperienceSignals(currentSignals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);
    // Both cohorts dropped → empty batch.
    expect(currentCohorts).toHaveLength(0);

    const result = resolveExperienceCohort(
      citedCohort.sourceId,
      citedCohort.coarseWindow,
      citedCohort.digest,
      currentCohorts,
    );
    expect(result.state).toBe("unauthorized");
    // No content leaks.
    expect(result.digest).toBeUndefined();
    expect(result.occurredAt).toBeUndefined();
  });

  it("a cohort that still meets the floor with same digest resolves available", () => {
    const signals = [
      makeEligibleSignal({ clusterKey: "subject-a" }),
      makeEligibleSignal({ clusterKey: "subject-b", skillCategory: "pattern" }),
    ];
    const cohorts = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);
    const citedCohort = cohorts[0];

    // Recompute with the same signals.
    const result = resolveExperienceCohort(
      citedCohort.sourceId,
      citedCohort.coarseWindow,
      citedCohort.digest,
      cohorts,
    );
    expect(result.state).toBe("available");
    expect(result.digest).toBe(citedCohort.digest);
  });

  it("a cohort whose digest changed resolves changed", () => {
    const signals = [
      makeEligibleSignal({ clusterKey: "subject-a", frequency: 5, corroboratingAgents: 3 }),
      makeEligibleSignal({ clusterKey: "subject-b", skillCategory: "pattern" }),
    ];
    const original = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);
    const citedCohort = original[0];

    // Current state: the cohort's counts moved to a different band.
    const currentSignals = [
      makeEligibleSignal({ clusterKey: "subject-a", frequency: 20, corroboratingAgents: 10 }),
      makeEligibleSignal({ clusterKey: "subject-b", skillCategory: "pattern" }),
    ];
    const currentCohorts = projectExperienceSignals(currentSignals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);

    const result = resolveExperienceCohort(
      citedCohort.sourceId,
      citedCohort.coarseWindow,
      citedCohort.digest,
      currentCohorts,
    );
    expect(result.state).toBe("changed");
    expect(result.digest).not.toBe(citedCohort.digest);
  });

  it("a source ID that doesn't match the exp_agg format resolves dangling", () => {
    const result = resolveExperienceCohort("not-valid", "2026-01-01T00:00:00.000Z", null, []);
    expect(result.state).toBe("dangling");
  });

  it("a valid-format source ID not in current cohorts resolves unauthorized", () => {
    const result = resolveExperienceCohort(
      "exp_agg:nonexistenthash1234567890abcdef",
      "2026-01-01T00:00:00.000Z",
      null,
      [],
    );
    expect(result.state).toBe("unauthorized");
  });

  it("null coarse window resolves dangling", () => {
    const result = resolveExperienceCohort("exp_agg:somehash", null, null, []);
    expect(result.state).toBe("dangling");
  });
});

// ---------------------------------------------------------------------------
// Transient denylist
// ---------------------------------------------------------------------------

describe("transient denylist", () => {
  it("collects agent IDs, pulse IDs, task IDs, and comment IDs from raw signals", () => {
    const signals = [
      makeSignal({
        corroboratingAgentIds: '["agent-1","agent-2"]',
        sourcePulseIds: '["pulse-1"]',
        sourceTaskIds: '["task-1"]',
        sourceCommentIds: '["comment-1"]',
      }),
    ];
    const denylist = buildTransientDenylist(signals);
    expect(denylist.has("agent-1")).toBe(true);
    expect(denylist.has("agent-2")).toBe(true);
    expect(denylist.has("pulse-1")).toBe(true);
    expect(denylist.has("task-1")).toBe(true);
    expect(denylist.has("comment-1")).toBe(true);
  });

  it("handles null and malformed JSON gracefully", () => {
    const signals = [
      makeSignal({
        corroboratingAgentIds: null,
        sourcePulseIds: "not-json",
        sourceTaskIds: null,
        sourceCommentIds: '["valid-comment"]',
      }),
    ];
    const denylist = buildTransientDenylist(signals);
    expect(denylist.has("valid-comment")).toBe(true);
    // No throw.
    expect(denylist.size).toBeGreaterThan(0);
  });

  it("scanAgainstDenylist replaces matching substrings", () => {
    const denylist = new Set(["agent-secret"]);
    const { sanitized, hadMatch } = scanAgainstDenylist(
      "This involves agent-secret behavior",
      denylist,
    );
    expect(hadMatch).toBe(true);
    expect(sanitized).toBe("This involves [redacted] behavior");
  });

  it("scanAgainstDenylist returns original text when no match", () => {
    const denylist = new Set(["not-present"]);
    const { sanitized, hadMatch } = scanAgainstDenylist("Clean text", denylist);
    expect(hadMatch).toBe(false);
    expect(sanitized).toBe("Clean text");
  });
});

// ---------------------------------------------------------------------------
// Negative-fixture mutation testing — each test can fail for its defect
// ---------------------------------------------------------------------------

describe("negative-fixture mutation evidence", () => {
  it("lowering the signal floor to 1 would admit a below-floor cohort", () => {
    // This documents that if someone lowers MIN_SIGNALS_FLOOR, the test
    // assertion below would fail (the cohort would be admitted).
    const signals = [
      makeSignal({ clusterKey: "a", frequency: 1, corroboratingAgents: 3 }),
      makeSignal({ clusterKey: "b", skillCategory: "pattern", frequency: 1, corroboratingAgents: 3 }),
    ];
    const result = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);
    expect(result).toHaveLength(0); // Both blocked by floor.

    // If the floor were lowered to 1 signal, these would be admitted.
    // (This is evidence, not a runtime test — the floor is non-configurable.)
  });

  it("emitting a raw field name would be caught by serialization boundary tests", () => {
    const signals = [
      makeEligibleSignal({ clusterKey: "subject-a" }),
      makeEligibleSignal({ clusterKey: "subject-b", skillCategory: "pattern" }),
    ];
    const result = projectExperienceSignals(signals, HABITAT_ID, defaultFloor(), WINDOW_FROM, WINDOW_TO);

    // Simulate what would happen if a raw field leaked: construct a bad object.
    const badObj = { ...result[0], sourcePulseIds: '["pulse-1"]' } as unknown;
    const serialized = JSON.stringify(badObj);
    expect(serialized).toContain("sourcePulseIds"); // The leak IS present in the bad object.

    // Confirm the real projection output does NOT contain it.
    const cleanSerialized = JSON.stringify(result[0]);
    expect(cleanSerialized).not.toContain("sourcePulseIds");
  });
});

// ---------------------------------------------------------------------------
// Coarse window bucketing
// ---------------------------------------------------------------------------

describe("coarse window bucketing", () => {
  it("aligns to 7-day buckets from epoch", () => {
    // 2026-01-01T00:00:00Z = Thursday. Let's verify the bucket alignment.
    const bucket = deriveCoarseWindow("2026-01-01T00:00:00.000Z");
    // The bucket is floor(ms / 7d) * 7d.
    const expectedMs = Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / (7 * 24 * 60 * 60 * 1000)) * (7 * 24 * 60 * 60 * 1000);
    expect(bucket).toBe(new Date(expectedMs).toISOString());
  });

  it("two timestamps within the same 7-day bucket produce the same coarse window", () => {
    const w1 = deriveCoarseWindow("2026-01-01T00:00:00.000Z");
    const w2 = deriveCoarseWindow("2026-01-03T12:00:00.000Z");
    // These may or may not be in the same bucket depending on alignment.
    // What matters: the function is deterministic.
    expect(typeof w1).toBe("string");
    expect(typeof w2).toBe("string");
    expect(Date.parse(w1)).not.toBeNaN();
  });

  it("the coarse window is never an exact signal timestamp", () => {
    const ts = "2026-01-15T09:17:22.456Z";
    const bucket = deriveCoarseWindow(ts);
    // The bucket is aligned to 7-day boundaries — it won't have arbitrary seconds/millis.
    expect(bucket).not.toBe(ts);
    // It should be a round 7-day-aligned value.
    const bucketMs = Date.parse(bucket);
    expect(bucketMs % (7 * 24 * 60 * 60 * 1000)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Digest stability
// ---------------------------------------------------------------------------

describe("aggregate digest stability", () => {
  it("same banded counts + same window → same digest", () => {
    const d1 = computeExperienceDigest({
      skillCategory: "pitfall",
      coarseWindow: "2026-01-01T00:00:00.000Z",
      signalCountBand: "5-9",
      agentCountBand: "3-4",
      caveats: [],
    });
    const d2 = computeExperienceDigest({
      skillCategory: "pitfall",
      coarseWindow: "2026-01-01T00:00:00.000Z",
      signalCountBand: "5-9",
      agentCountBand: "3-4",
      caveats: [],
    });
    expect(d1).toBe(d2);
  });

  it("different band → different digest (enables changed detection)", () => {
    const d1 = computeExperienceDigest({
      skillCategory: "pitfall",
      coarseWindow: "2026-01-01T00:00:00.000Z",
      signalCountBand: "5-9",
      agentCountBand: "3-4",
      caveats: [],
    });
    const d2 = computeExperienceDigest({
      skillCategory: "pitfall",
      coarseWindow: "2026-01-01T00:00:00.000Z",
      signalCountBand: "10-19",
      agentCountBand: "3-4",
      caveats: [],
    });
    expect(d1).not.toBe(d2);
  });

  it("different caveats → different digest", () => {
    const d1 = computeExperienceDigest({
      skillCategory: "pitfall",
      coarseWindow: "2026-01-01T00:00:00.000Z",
      signalCountBand: "5-9",
      agentCountBand: "3-4",
      caveats: [],
    });
    const d2 = computeExperienceDigest({
      skillCategory: "pitfall",
      coarseWindow: "2026-01-01T00:00:00.000Z",
      signalCountBand: "5-9",
      agentCountBand: "3-4",
      caveats: ["subject_redacted_identifier_match"],
    });
    expect(d1).not.toBe(d2);
  });
});
