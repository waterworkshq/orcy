/**
 * Doctor liveness probe (P5.1). Verifies:
 *  (a) doctor runs against a fresh temp home without throwing.
 *  (b) A stale install-journal.json present in orcyHome() produces the
 *      WARN line (a present journal = an interrupted install).
 *
 * Harness (test/helpers/setup.js) is imported FIRST so @orcy/shared's
 * ORCY_PATHS is redirected to a per-file temp dir; the real node:fs
 * operates on that temp dir; external execSync (systemctl/launchctl)
 * and fetch are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import "./helpers/setup.js";
import { orcyHome } from "./helpers/setup.js";
import { doctor } from "../src/doctor.js";

describe("doctor liveness probe", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("runs against a fresh temp home without throwing", async () => {
    // No journal present (beforeEach in the harness already cleared orcyHome()).
    expect(fs.existsSync(path.join(orcyHome(), "install-journal.json"))).toBe(false);

    await expect(doctor()).resolves.toBeUndefined();

    const output = logSpy.mock.calls.map((args: unknown[]) => args.map(String).join(" ")).join("\n");
    // Fresh home has no journal → OK line, not WARN.
    expect(output).toContain("OK no stale install journal");
    expect(output).not.toContain("WARN stale install journal");
  });

  it("reports WARN when an install journal is present (interrupted install)", async () => {
    // Seed a stale journal at the canonical path used by journal.ts.
    const journalPath = path.join(orcyHome(), "install-journal.json");
    fs.writeFileSync(
      journalPath,
      JSON.stringify({ version: 1, startedAt: new Date().toISOString(), components: [], steps: [] }),
      "utf-8",
    );

    await expect(doctor()).resolves.toBeUndefined();

    const output = logSpy.mock.calls.map((args: unknown[]) => args.map(String).join(" ")).join("\n");
    expect(output).toContain("WARN stale install journal present (interrupted install)");
  });
});
