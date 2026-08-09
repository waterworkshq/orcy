/**
 * MOCK BOUNDARY: this test mocks `node:child_process.execSync` so that the `curl`
 * download materializes its target file, the `tar` extract seeds a fake source tree
 * (`packages/<comp>/{dist,package.json}` + `packages/ui/dist` + `packages/api/drizzle`)
 * into the extracted source dir, and all `pnpm`/`npm`/`systemctl`/`launchctl` calls
 * are no-ops. The real `node:fs` then runs the real `installPackages` →
 * `installBuiltPackages` → `record()` path against the temp ORCY_HOME. Boundary
 * chosen so the OBSERVABLE manifest/fs shape is exercised end-to-end while only the
 * external process invocations are faked — later phases that refactor the build
 * pipeline still produce the same manifest shape.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import "./helpers/setup.js";
import {
  orcyHome,
  readManifest,
  countEntries,
  createAgentConfigDir,
  createPatchFile,
  defaultSkillRoot,
} from "./helpers/setup.js";
import { wizard } from "../src/wizard.js";

describe("install happy path", () => {
  it("characterizes that wizard creates a manifest recording components and @orcy/* created entries", async () => {
    createAgentConfigDir();
    const patchFile = createPatchFile("AGENTS.md");

    await wizard({
      components: ["cli", "api", "mcp"],
      mcpClients: ["claude-code"],
      patchFiles: [patchFile],
      skillRoots: [defaultSkillRoot()],
      interactive: false,
    });

    // Manifest created at ORCY_PATHS.home/install-manifest.json (temp home).
    expect(fs.existsSync(path.join(orcyHome(), "install-manifest.json"))).toBe(true);

    const m = readManifest();
    expect(m).not.toBeNull();
    expect(m!.components).toEqual(expect.arrayContaining(["cli", "api", "mcp"]));

    // ≥1 `created` entry whose path names an @orcy/* package (shape, not exact count).
    const createdOrcy = countEntries(
      (e) => e.action === "created" && /node_modules\/@orcy\/(cli|api|mcp)/.test(e.path),
    );
    expect(createdOrcy).toBeGreaterThanOrEqual(1);

    // The install produces the full set of side-effect kinds the wizard owns today.
    const actions = new Set(m!.files.map((e) => e.action));
    expect(actions).toContain("created"); // packages, shims, service, credentials
    expect(actions).toContain("fenced"); // agent instruction file patch
    expect(actions).toContain("merged-json"); // MCP client config
    expect(actions).toContain("copied"); // skill files
    expect(actions).toContain("appended"); // shell rc PATH block
  });
});
