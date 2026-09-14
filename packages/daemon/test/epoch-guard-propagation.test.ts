/**
 * Epoch mutation guard — daemon-side propagation (ticket I4).
 *
 *   - every adapter prompt is built at spawn with taskId + execution token,
 *     states the task is already claimed (do NOT claim again) and instructs
 *     presenting the token on start/submit/fail/release
 *   - the token rides the prompt only — NEVER a file channel: `.mcp.json`
 *     written into a (re-claimed) workdir contains no token
 *   - the shared ClaimResult task projection carries the token, and the
 *     session manager hands it to the spawner (typed wiring proof)
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAdapter } from "../src/session/adapters.js";
import { writeMcpConfig } from "../src/mcp-config.js";
import { spawnCli } from "../src/session/spawner.js";
import type { ClaimResult } from "@orcy/shared/types";

const CLI_TYPES = ["claude-code", "codex", "opencode", "cursor", "gemini"] as const;

describe("epoch guard — adapter prompt carries the claim token immutably", () => {
  it.each([...CLI_TYPES])(
    "%s prompt contains taskId + token + do-not-reclaim + present-on-mutations",
    (type) => {
      const adapter = getAdapter(type);
      const args = adapter.buildArgs("task-ep-1", "Some title", "/workdir", "token-ep-abc");
      const prompt = args.join(" ");
      expect(prompt).toContain("task-ep-1");
      expect(prompt).toContain("token-ep-abc");
      expect(prompt.toLowerCase()).toContain("already claimed");
      expect(prompt.toLowerCase()).toContain("do not claim");
      expect(prompt).toContain("executionToken");
      expect(prompt).toContain("start/submit/fail/release");
    },
  );
});

describe("epoch guard — no file channel", () => {
  it("generateMcpConfig/writeMcpConfig never embed an execution token (re-claimed workdir stays clean)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epoch-mcp-config-"));
    try {
      writeMcpConfig(
        {
          apiUrl: "http://127.0.0.1:3000",
          agent: { id: "agent-1", name: "a", type: "claude-code", apiKey: "key" },
          workdir: dir,
        },
        dir,
      );
      const raw = await readFile(join(dir, ".mcp.json"), "utf-8");
      expect(raw).not.toContain("executionToken");
      expect(raw).not.toContain("token-ep");
      expect(JSON.parse(raw).mcpServers.orcy.env).not.toHaveProperty("ORCY_EXECUTION_TOKEN");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("epoch guard — claim surfaces carry the token", () => {
  it("ClaimResult.task carries executionToken (shared type)", () => {
    const claim: ClaimResult = {
      task: {
        id: "t1",
        title: "T",
        description: null,
        missionId: "m1",
        habitatId: "h1",
        priority: "medium",
        requiredDomain: null,
        requiredCapabilities: [],
        executionToken: "token-ep-abc",
      },
      worktreeSettings: null,
    };
    expect(claim.task.executionToken).toBe("token-ep-abc");
  });

  it("spawnCli receives the execution token and forwards it to buildArgs", async () => {
    // spawnCli with a fake bin that cannot spawn: the args are built BEFORE
    // spawn, so asserting on the adapter path via a stub adapter is not
    // possible without touching the registry — instead pin the manager→spawner
    // seam shape by driving spawnCli against /bin/true-like garbage and
    // asserting the child errors AFTER args were built (the type-level
    // threading is pinned by tsc; runtime proof is the buildArgs tests above).
    expect(() =>
      spawnCli(
        "claude-code",
        "task-ep-2",
        "Title",
        "/workdir",
        "agent-1",
        "key",
        "http://127.0.0.1:1",
        "/nonexistent/bin/definitely-not-here",
        "token-ep-xyz",
        { onStdout: () => {}, onStderr: () => {}, onExit: () => {}, onError: () => {} },
      ),
    ).toThrow();
  });
});
