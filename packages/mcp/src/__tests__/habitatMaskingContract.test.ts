import { describe, it, expect, vi } from "vitest";
import { habitatGetHabitat, habitatListHabitats } from "../tools/habitat.js";
import type { PublicHabitat } from "@orcy/shared";

/**
 * MCP ↔ server masking contract test.
 *
 * Mirrors packages/ui/src/api/domains/habitatsContract.test.ts:142-156.
 * Feeds canonical server JSON (masked PublicHabitat) through the MCP
 * handler and asserts:
 *   - codeReviewSettings has hasGithubSecret / hasGitlabSecret (presence booleans)
 *   - codeReviewSettings does NOT have githubSecret / gitlabSecret (raw secrets)
 *   - ciCdSettings follows the same masking contract
 *
 * Provable: if someone un-masks the server response (injects githubSecret),
 * the `not.toHaveProperty` assertions fail immediately.
 */

// Canonical masked habitat — what a correctly-masking server sends.
const maskedHabitat: PublicHabitat = {
  id: "h-1",
  name: "Contract Habitat",
  description: "",
  columns: [],
  teamId: null,
  retrySettings: null,
  anomalySettings: null,
  autoAssignSettings: null,
  codeReviewSettings: {
    hasGithubSecret: true,
    hasGitlabSecret: false,
    taskPattern: "TASK-\\d+",
    autoApproveOnMerge: true,
  },
  ciCdSettings: {
    hasGithubSecret: false,
    hasGitlabSecret: true,
    taskPattern: "CD-\\d+",
  },
  gitWorktreeSettings: null,
  prioritizationSettings: null,
  automationSettings: null,
  remoteGovernanceSettings: null,
  wikiSettings: null,
  triageSettings: null,
  releaseSettings: null,
  roadmapSettings: null,
  eventRetentionDays: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

describe("MCP ↔ server masking contract", () => {
  it("habitatGetHabitat preserves PublicHabitat masking (presence booleans, no raw secrets)", async () => {
    const client = {
      getHabitat: vi.fn().mockResolvedValue({ habitat: maskedHabitat }),
    };

    const result = await habitatGetHabitat(client as never, { habitatId: "h-1" });

    // Presence booleans exist on codeReviewSettings
    expect(result.habitat.codeReviewSettings).toHaveProperty("hasGithubSecret", true);
    expect(result.habitat.codeReviewSettings).toHaveProperty("hasGitlabSecret", false);

    // Raw secrets do NOT exist on codeReviewSettings
    expect(result.habitat.codeReviewSettings).not.toHaveProperty("githubSecret");
    expect(result.habitat.codeReviewSettings).not.toHaveProperty("gitlabSecret");

    // Presence booleans exist on ciCdSettings
    expect(result.habitat.ciCdSettings).toHaveProperty("hasGithubSecret", false);
    expect(result.habitat.ciCdSettings).toHaveProperty("hasGitlabSecret", true);

    // Raw secrets do NOT exist on ciCdSettings
    expect(result.habitat.ciCdSettings).not.toHaveProperty("githubSecret");
    expect(result.habitat.ciCdSettings).not.toHaveProperty("gitlabSecret");
  });

  it("habitatListHabitats projects discovery fields only (no settings leaked)", async () => {
    const client = {
      listHabitats: vi.fn().mockResolvedValue({ habitats: [maskedHabitat] }),
    };

    const result = await habitatListHabitats(client as never, {} as never);

    expect(result.habitats).toHaveLength(1);
    const h = result.habitats[0];

    // List response is a discovery projection — only id, name, description.
    expect(h).toHaveProperty("id", "h-1");
    expect(h).toHaveProperty("name", "Contract Habitat");

    // No settings fields leak through the list projection at all.
    expect(h).not.toHaveProperty("codeReviewSettings");
    expect(h).not.toHaveProperty("ciCdSettings");
  });

  it("catches a deliberately un-masked server response (negative proof)", async () => {
    // Simulate a BUG: server accidentally includes the raw secret.
    const unmaskedResponse = {
      ...maskedHabitat,
      codeReviewSettings: {
        hasGithubSecret: true,
        githubSecret: "ghs_secret123", // <-- raw secret leaked
        hasGitlabSecret: false,
        taskPattern: "TASK-\\d+",
        autoApproveOnMerge: true,
      },
    };

    const client = {
      getHabitat: vi.fn().mockResolvedValue({ habitat: unmaskedResponse }),
    };

    const result = await habitatGetHabitat(client as never, { habitatId: "h-1" });

    // The masking assertion catches the leaked secret — the inner expect throws,
    // proving the test has teeth. Wrap in expect().toThrow so this test PASSES.
    expect(() => {
      expect(result.habitat.codeReviewSettings).not.toHaveProperty("githubSecret");
    }).toThrow();
  });

  it("type-level: habitatGetHabitat return type is PublicHabitat (masked), not Habitat (raw)", () => {
    // Compile-time assertion — if someone changes the client return type from
    // PublicHabitat to Habitat, the hasGithubSecret property disappears from the
    // type and this assertion fails to compile.
    type HabitatResult = Awaited<ReturnType<typeof habitatGetHabitat>>["habitat"];
    type CodeReviewShape = NonNullable<HabitatResult["codeReviewSettings"]>;

    // PublicHabitat.codeReviewSettings has hasGithubSecret; Habitat has githubSecret.
    const _hasGithubSecretIsBoolean: CodeReviewShape extends { hasGithubSecret: boolean }
      ? true
      : false = true;
    const _githubSecretAbsent: CodeReviewShape extends { githubSecret: unknown }
      ? false
      : true = true;

    // Reference the consts to avoid unused-variable lint.
    void _hasGithubSecretIsBoolean;
    void _githubSecretAbsent;
  });
});
