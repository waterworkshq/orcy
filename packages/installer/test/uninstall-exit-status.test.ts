/**
 * F3 (cold review) — the uninstall COMMAND boundary reports blocked agent
 * deletion truthfully: `uninstallAll` returns a structured outcome and the
 * CLI action maps a typed blocker (and pre-existing removal failures) to a
 * NONZERO process exit code — after cleanup completes, via `process.exitCode`
 * (the `verify` command's established pattern), never `process.exit`.
 *
 * Pins: typed 409 blocker → exit 1 + credentials/.env/orcy.db/manifest all
 * preserved; normal 204 deactivation → exit 0 (no regression); unreachable
 * API → exit 0 (existing separate policy) UNLESS removal failures already
 * exist, in which case the CLI reports the truth (exit 1).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import "./helpers/setup.js";
import { orcyHome, manifestPath } from "./helpers/setup.js";
import { runUninstallCommand } from "../src/index.js";
import { getContext } from "../src/context.js";
import { record } from "../src/manifest.js";

/**
 * Deterministic fs-removal fault injection at the unlink/rm seam (portable —
 * no POSIX-only chmod/root dependencies): exactly ONE path's removal throws,
 * every other fs call delegates to the real implementation, so the REAL
 * uninstall command boundary handles a REAL cleanup failure against real
 * disposable-home files.
 */
const REMOV = vi.hoisted(() => ({ failPath: null as string | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  const maybeThrow = (p: unknown): void => {
    if (REMOV.failPath !== null && typeof p === "string" && p === REMOV.failPath) {
      throw new Error("injected_removal_failure");
    }
  };
  // Wrap BOTH the named exports and the CJS default object — the installer
  // source imports the default (`import fs from "node:fs"`).
  const rmSync = (p: any, ...rest: any[]): any => {
    maybeThrow(p);
    return actual.rmSync(p, ...rest);
  };
  const unlinkSync = (p: any, ...rest: any[]): any => {
    maybeThrow(p);
    return actual.unlinkSync(p, ...rest);
  };
  return {
    ...actual,
    rmSync,
    unlinkSync,
    default: { ...actual.default, rmSync, unlinkSync },
  };
});
import fs from "node:fs";

function seedMinimalManifest(): void {
  const dummy = path.join(orcyHome(), "dummy");
  fs.writeFileSync(dummy, "x");
  record({ path: dummy, action: "created" });
}

function seedDataFiles(): void {
  fs.writeFileSync(path.join(orcyHome(), ".env"), "ORCY_API_URL=http://127.0.0.1:4000\n");
  fs.writeFileSync(path.join(orcyHome(), "orcy.db"), "fake-db");
  fs.writeFileSync(
    path.join(orcyHome(), "credentials.json"),
    JSON.stringify({ agentId: "agent-test-001", apiKey: "orcy-key-test", agentName: "test-agent" }),
  );
}

const dataFiles = (): string[] =>
  [".env", "orcy.db", "credentials.json"].map((f) => path.join(orcyHome(), f));

describe("uninstall command exit status (F3)", () => {
  let defaultFetch: typeof globalThis.fetch;

  beforeEach(() => {
    seedMinimalManifest();
    seedDataFiles();
    defaultFetch = globalThis.fetch;
    process.exitCode = 0;
  });
  afterEach(() => {
    globalThis.fetch = defaultFetch;
    REMOV.failPath = null;
    process.exitCode = 0;
  });

  it("typed blocker: exit code 1, data files + manifest preserved", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: "Agent not deleted: the transition budget is exhausted for a held task.",
            code: "deletion_blocked_budget",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    ) as typeof globalThis.fetch;

    await runUninstallCommand({ yes: true, purge: true });

    expect(process.exitCode).toBe(1);
    for (const f of dataFiles()) expect(fs.existsSync(f)).toBe(true);
    expect(fs.existsSync(manifestPath())).toBe(true);
  });

  it("normal 204 deactivation: exit code 0, purge proceeds", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 204 }),
    ) as typeof globalThis.fetch;

    await runUninstallCommand({ yes: true, purge: true });

    expect(process.exitCode).toBe(0);
    for (const f of dataFiles()) expect(fs.existsSync(f)).toBe(false);
  });

  it("unreachable API (no other failures): exit code 0 — existing policy", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;

    await runUninstallCommand({ yes: true, purge: true });

    expect(process.exitCode).toBe(0);
  });

  it("unreachable API WITH a real removal failure: exit code 1 — truth (portable seam injection)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;
    // Deterministic cleanup failure at the fs unlink/rm seam: a "created"
    // manifest entry (a directory) whose removal throws exactly once-path —
    // everything else stays real. Same command boundary, real files.
    const dirEntry = path.join(orcyHome(), "stub-dir");
    fs.mkdirSync(path.join(dirEntry, "keep"), { recursive: true });
    fs.writeFileSync(path.join(dirEntry, "keep", "f"), "x");
    record({ path: dirEntry, action: "created" });
    REMOV.failPath = dirEntry;

    try {
      await runUninstallCommand({ yes: true, purge: true });
    } finally {
      REMOV.failPath = null;
    }

    expect(process.exitCode).toBe(1);
    // The failed entry truthfully remains (the manifest was kept for retry).
    expect(fs.existsSync(dirEntry)).toBe(true);
    expect(fs.existsSync(manifestPath())).toBe(true);
  });

  it("third typed code AGENT_TEARDOWN_REFERENCES_REMAIN: exit 1, data files + manifest UNCHANGED", async () => {
    // The API refused the deletion on the internal teardown invariant — the
    // deletion ROLLED BACK and the agent is STILL REGISTERED. The installer
    // must treat this exactly like the two user-facing blockers: no purge.
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error:
            "Agent deletion aborted: task references remain after the teardown composition; nothing was deleted.",
          code: "AGENT_TEARDOWN_REFERENCES_REMAIN",
          details: { assignedRefs: 1, delegatedRefs: 0 },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    ) as typeof globalThis.fetch;

    await runUninstallCommand({ yes: true, purge: true });

    expect(process.exitCode).toBe(1);
    for (const f of dataFiles()) expect(fs.existsSync(f)).toBe(true);
    expect(fs.existsSync(manifestPath())).toBe(true);
  });
});
