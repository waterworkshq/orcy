/**
 * REC-06 (agent-deletion batch) — installer discipline on typed deletion
 * blockers (independent-review pin 5):
 *
 *   - a typed 409 (`deletion_blocked_review_in_flight` /
 *     `deletion_blocked_budget`) from the self-delete API MUST stop the
 *     purge of credentials.json/.env/orcy.db — the agent is still
 *     registered, its key is the only credential, destroying it strands the
 *     agent unrecoverably. The uninstall reports itself blocked (manifest
 *     preserved for retry) and names the admin remedy;
 *   - a normal 204 deactivation still purges (no regression);
 *   - an unreachable API keeps the EXISTING separate policy (warn + manual
 *     cleanup; purge proceeds when consented) — not conflated with blockers.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import fs from "node:fs";
import path from "node:path";
import "./helpers/setup.js";
import { orcyHome, manifestPath } from "./helpers/setup.js";
import { uninstallAll } from "../src/lifecycle.js";
import { getContext } from "../src/context.js";
import { record } from "../src/manifest.js";

type FetchMock = typeof globalThis.fetch & { mock: { calls: unknown[][] } };

function fetchMock(): FetchMock {
  return globalThis.fetch as FetchMock;
}

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

describe("typed agent-deletion blockers stop the uninstall purge", () => {
  let errSpy: MockInstance;
  let warnSpy: MockInstance;
  let defaultImpl: typeof globalThis.fetch;

  beforeEach(() => {
    seedMinimalManifest();
    seedDataFiles();
    defaultImpl = globalThis.fetch;
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = defaultImpl;
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  for (const code of [
    "deletion_blocked_review_in_flight",
    "deletion_blocked_budget",
    "AGENT_TEARDOWN_REFERENCES_REMAIN",
  ] as const) {
    it(`${code}: data files UNCHANGED, uninstall reported blocked, manifest kept`, async () => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: "Agent not deleted: 1 task(s) in submitted/rejected state are still assigned.",
              code,
              details: { blockedTasks: [{ id: "t1", title: "T", status: "submitted" }] },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
      ) as typeof globalThis.fetch;

      await uninstallAll(getContext(), { purge: true, yes: true });

      for (const f of dataFiles()) {
        expect(fs.existsSync(f), `${path.basename(f)} preserved`).toBe(true);
      }
      expect(fs.existsSync(manifestPath()), "manifest preserved for retry").toBe(true);
      const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("NOT deleted");
      expect(logged).toContain(code);
      expect(logged).toContain("administrator");
      expect(logged).toContain("nothing was purged");
    });
  }

  it("normal 204 deactivation still purges (no regression)", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 204 }),
    ) as typeof globalThis.fetch;

    await uninstallAll(getContext(), { purge: true, yes: true });

    for (const f of dataFiles()) {
      expect(fs.existsSync(f), `${path.basename(f)} removed`).toBe(false);
    }
  });

  it("unreachable API keeps the existing policy: warn + purge proceeds", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;

    await uninstallAll(getContext(), { purge: true, yes: true });

    for (const f of dataFiles()) {
      expect(fs.existsSync(f), `${path.basename(f)} removed`).toBe(false);
    }
    const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warned).toContain("API unreachable");
  });
});
