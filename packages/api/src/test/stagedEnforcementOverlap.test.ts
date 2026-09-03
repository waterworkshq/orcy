/**
 * Genuine two-process overlap gate for the staged-enforcement suite.
 *
 * Sequential runs are not concurrency proof: the recorded incident was two
 * overlapping Vitest invocations in one checkout whose hook-time recursive
 * rmSync of the shared temp directory unlinked each other's live databases
 * (readonly-database failures). This gate spawns two REAL concurrent
 * invocations of the staged suite — the second staggered ~2s so its module
 * load lands mid-run of the first, the historical collision window — and
 * accepts only BOTH passing 19/19 with no residue in the constant parent.
 *
 * Excluded from the default suite (package.json --exclude, perfWorkflow
 * precedent; runs as `test:staged-overlap`) because it costs ~2x the staged
 * chain. Recursion-safe by construction: children run ONLY the staged file,
 * never this one. No child_process mocking anywhere.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";

// Two full staged chains (~45s each serially) overlapped with a 2s stagger,
// plus pnpm/corepack startup for both children — generous headroom under the
// 10-minute budget.
vi.setConfig({ testTimeout: 600_000 });

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const STAGED_FILE = "src/test/stagedEnforcementMigration.test.ts";
const PARENT_DIR = join(PACKAGE_ROOT, ".test-staged-enforcement");
const STAGGER_MS = 2_000;

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runStagedSuite(): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("corepack", ["pnpm", "exec", "vitest", "run", STAGED_FILE], {
      cwd: PACKAGE_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("staged enforcement two-process overlap gate", () => {
  it("two overlapping invocations both pass 19/19 and leave no residue", async () => {
    const first = runStagedSuite();
    await new Promise((resolve) => setTimeout(resolve, STAGGER_MS));
    const second = runStagedSuite();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    for (const [label, result] of [
      ["first", firstResult],
      ["second", secondResult],
    ] as const) {
      expect(
        result.code,
        `${label} child exited non-zero; stderr tail: ${result.stderr.slice(-2_000)}`,
      ).toBe(0);
      expect(result.stdout, `${label} child summary`).toContain("19 passed");
    }

    // The constant parent holds no residue once both invocations finished:
    // each tore down only its own run-* directory.
    const residue = existsSync(PARENT_DIR) ? readdirSync(PARENT_DIR).length : 0;
    expect(residue, "stale entries left in .test-staged-enforcement").toBe(0);
  });
});
