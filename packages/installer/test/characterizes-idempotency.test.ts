import { describe, it, expect } from "vitest";
import type { WizardOptions } from "../src/wizard.js";
import "./helpers/setup.js";
import { readManifest, countEntries, defaultSkillRoot } from "./helpers/setup.js";
import { wizard } from "../src/wizard.js";

describe("install idempotency", () => {
  it("should not grow files[] when install runs twice (record() dedups on {path, action})", async () => {
    // Was characterizes_* pinning the no-dedup bug (B5); flipped to should_* in Phase 1 (P1.1)
    // when record() gained {path, action} dedup. A second identical install must not append
    // duplicate entries — the manifest stays byte-stable across re-runs.
    const opts: WizardOptions = {
      components: ["cli", "api", "mcp"],
      mcpClients: [],
      patchFiles: [],
      skillRoots: [defaultSkillRoot()],
      interactive: false,
    };

    await wizard(opts);
    const afterFirst = readManifest();
    expect(afterFirst).not.toBeNull();
    const firstTotal = afterFirst!.files.length;
    const firstCliCreated = countEntries(
      (e) => e.action === "created" && /node_modules\/@orcy\/cli/.test(e.path),
    );
    expect(
      firstCliCreated,
      "precondition: @orcy/cli created entry recorded on first install",
    ).toBeGreaterThanOrEqual(1);

    await wizard(opts);
    const afterSecond = readManifest();
    expect(afterSecond).not.toBeNull();
    const secondCliCreated = countEntries(
      (e) => e.action === "created" && /node_modules\/@orcy\/cli/.test(e.path),
    );

    // Dedup pin: files[] does NOT grow on a second identical install.
    expect(afterSecond!.files.length).toBe(firstTotal);
    // Dedup pin: the @orcy/cli `created` entry appears exactly once (not duplicated).
    expect(secondCliCreated).toBe(firstCliCreated);
    expect(secondCliCreated).toBe(1);
  });
});
