import { describe, it, expect } from "vitest";
import type { WizardOptions } from "../src/wizard.js";
import "./helpers/setup.js";
import { readManifest, countEntries, defaultSkillRoot } from "./helpers/setup.js";
import { wizard } from "../src/wizard.js";

describe("install idempotency", () => {
  it("characterizes B5: running install twice grows files[] with DUPLICATE created entries (record() does not dedup)", async () => {
    // KNOWN-DESTRUCTIVE: pinned by characterizes_*; flips to should_* in Phase 1.
    // B5 = manifest.record() pushes without dedup, so a second install appends
    // duplicate {path, action} entries for the steps that always re-record.
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
    const secondTotal = afterSecond!.files.length;
    const secondCliCreated = countEntries(
      (e) => e.action === "created" && /node_modules\/@orcy\/cli/.test(e.path),
    );

    // B5 pin: files[] grew — no dedup between runs.
    expect(secondTotal).toBeGreaterThan(firstTotal);
    // B5 pin: the @orcy/cli `created` entry now appears more than once (duplicated).
    expect(secondCliCreated).toBeGreaterThan(firstCliCreated);
    expect(secondCliCreated).toBeGreaterThanOrEqual(2);
  });
});
