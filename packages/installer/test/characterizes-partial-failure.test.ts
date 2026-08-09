import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// KNOWN-DESTRUCTIVE: pinned by characterizes_*; flips to should_* in Phase 1.
// Mock install-packages.js to record a partial `created` entry then throw, so we
// can pin the "no recovery/rollback on partial failure" baseline. The factory uses
// the REAL manifest.record() (imported dynamically) so the leftover manifest is
// genuinely produced by production code, and dynamically imports fs/path (mock
// factories may only reference vi.hoisted bindings otherwise).
vi.mock("../src/install-packages.js", async () => {
  const { record } = await import("../src/manifest.js");
  const nfs = await import("node:fs");
  const npath = await import("node:path");
  return {
    installPackages: async (ctx: { orcyHome: string }, _components: string[]): Promise<void> => {
      // Simulate partial work: create one package dir + record it, then fail.
      const dir = npath.join(ctx.orcyHome, "node_modules", "@orcy", "cli");
      nfs.mkdirSync(dir, { recursive: true });
      record({ path: dir, action: "created" });
      throw new Error("partial-failure-mid-copy");
    },
  };
});

import "./helpers/setup.js";
import { orcyHome, readManifest, manifestPath } from "./helpers/setup.js";
import { wizard } from "../src/wizard.js";

describe("partial failure recovery", () => {
  it("characterizes that a mid-installPackages throw leaves a partial manifest with NO recovery/rollback", async () => {
    await expect(
      wizard({
        components: ["cli", "api", "mcp"],
        mcpClients: [],
        patchFiles: [],
        skillRoots: [],
        interactive: false,
      }),
    ).rejects.toThrow("partial-failure-mid-copy");

    const m = readManifest();
    expect(m, "partial manifest exists (entries recorded before throw)").not.toBeNull();
    expect(
      m!.files.some((e) => e.action === "created"),
      "at least one created entry recorded before the throw",
    ).toBe(true);

    // No-recovery pin: the leftover dir and the partial manifest are NOT rolled back.
    const leftover = path.join(orcyHome(), "node_modules", "@orcy", "cli");
    expect(fs.existsSync(leftover), "leftover dir NOT rolled back").toBe(true);
    expect(fs.existsSync(manifestPath()), "partial manifest NOT rolled back").toBe(true);
  });
});
