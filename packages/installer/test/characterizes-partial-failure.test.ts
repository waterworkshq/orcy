import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Flipped from characterizes_* in P1.4: with the journal wired into the install
// flow, record() redirects to the in-flight journal. A mid-install throw leaves
// the journal on disk and the manifest is NEVER written (commitJournal is
// unreachable). The next invocation detects the stale journal via G2 policy.
// The factory uses the REAL manifest.record() (imported dynamically) so the
// leftover journal entry is genuinely produced by production code.
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
import { orcyHome, readManifest } from "./helpers/setup.js";
import { wizard } from "../src/wizard.js";
import { journalExists } from "../src/journal.js";

describe("partial failure recovery", () => {
  it("should leave a stale journal (NOT a partial manifest) when installPackages throws mid-install", async () => {
    await expect(
      wizard({
        components: ["cli", "api", "mcp"],
        mcpClients: [],
        patchFiles: [],
        skillRoots: [],
        interactive: false,
      }),
    ).rejects.toThrow("partial-failure-mid-copy");

    // Journal survives — the in-flight transaction record is on disk.
    expect(journalExists(), "journal survives partial failure").toBe(true);

    // Manifest was NEVER written (commitJournal never reached).
    expect(readManifest(), "no partial manifest committed").toBeNull();

    // No-recovery pin: the leftover dir is NOT rolled back (no auto-recovery today).
    const leftover = path.join(orcyHome(), "node_modules", "@orcy", "cli");
    expect(fs.existsSync(leftover), "leftover dir NOT rolled back").toBe(true);
  });
});
