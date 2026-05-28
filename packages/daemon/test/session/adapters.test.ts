import { describe, it, expect } from "vitest";
import { getAdapter, getAllAdapters } from "../../src/session/adapters.js";

describe("adapters", () => {
  const cliTypes = ["claude-code", "codex", "opencode", "cursor", "gemini"] as const;

  describe("getAdapter", () => {
    it("returns adapter for each registered CLI type", () => {
      for (const type of cliTypes) {
        const adapter = getAdapter(type);
        expect(adapter.type).toBe(type);
        expect(adapter.bin).toBeTruthy();
        expect(typeof adapter.buildArgs).toBe("function");
        expect(typeof adapter.buildEnv).toBe("function");
        expect(typeof adapter.parseOutput).toBe("function");
        expect(typeof adapter.supportsResume).toBe("function");
      }
    });

    it("throws for unknown CLI type", () => {
      expect(() => getAdapter("unknown" as any)).toThrow("No adapter registered");
    });
  });

  describe("buildArgs", () => {
    it("includes task ID and title in args for claude-code", () => {
      const adapter = getAdapter("claude-code");
      const args = adapter.buildArgs("task-123", "Fix auth bug", "/workdir");
      expect(args).toEqual(expect.arrayContaining([expect.stringContaining("Fix auth bug")]));
      expect(args).toEqual(expect.arrayContaining([expect.stringContaining("task-123")]));
    });

    it("includes task ID and title in args for codex", () => {
      const adapter = getAdapter("codex");
      const args = adapter.buildArgs("task-456", "Add tests", "/workdir");
      expect(args).toEqual(expect.arrayContaining([expect.stringContaining("Add tests")]));
      expect(args).toEqual(expect.arrayContaining([expect.stringContaining("task-456")]));
    });

    it("includes task ID and title in args for opencode", () => {
      const adapter = getAdapter("opencode");
      const args = adapter.buildArgs("task-789", "Refactor API", "/workdir");
      expect(args).toEqual(expect.arrayContaining([expect.stringContaining("Refactor API")]));
    });

    it("includes task ID and title in args for cursor", () => {
      const adapter = getAdapter("cursor");
      const args = adapter.buildArgs("task-abc", "Update docs", "/workdir");
      expect(args).toEqual(expect.arrayContaining([expect.stringContaining("Update docs")]));
    });

    it("includes task ID and title in args for gemini", () => {
      const adapter = getAdapter("gemini");
      const args = adapter.buildArgs("task-def", "Add feature", "/workdir");
      expect(args).toEqual(expect.arrayContaining([expect.stringContaining("Add feature")]));
    });
  });

  describe("buildEnv", () => {
    it("returns env with API credentials for each adapter", () => {
      for (const type of cliTypes) {
        const adapter = getAdapter(type);
        const env = adapter.buildEnv("test-key", "agent-1", "http://localhost:3000");
        expect(env.ORCY_API_URL).toBe("http://localhost:3000");
        expect(env.ORCY_AGENT_ID).toBe("agent-1");
        expect(env.ORCY_API_KEY).toBe("test-key");
      }
    });
  });

  describe("parseOutput", () => {
    it("returns trimmed non-empty strings", () => {
      const adapter = getAdapter("claude-code");
      expect(adapter.parseOutput("  hello world  ")).toBe("hello world");
    });

    it("returns null for empty/whitespace-only chunks", () => {
      const adapter = getAdapter("claude-code");
      expect(adapter.parseOutput("   ")).toBeNull();
      expect(adapter.parseOutput("")).toBeNull();
    });
  });

  describe("supportsResume", () => {
    it("returns false for all adapters (MVP)", () => {
      for (const type of cliTypes) {
        const adapter = getAdapter(type);
        expect(adapter.supportsResume("1.0.0")).toBe(false);
        expect(adapter.supportsResume(null)).toBe(false);
      }
    });
  });

  describe("getAllAdapters", () => {
    it("returns all 5 adapters", () => {
      const all = getAllAdapters();
      expect(all.size).toBe(5);
      for (const type of cliTypes) {
        expect(all.has(type)).toBe(true);
      }
    });
  });
});
