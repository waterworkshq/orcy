/**
 * Test-only authority sentinel containment (FU6 memory + FU9).
 *
 * `TEST_ONLY_SKIP_IN_TX_AUTHORITY` is the sanctioned escape hatch that skips
 * the in-transaction authority recheck in Finding Triage lifecycle commands.
 * A production caller copying a test fixture pattern would silently ship
 * that hole, so this test fails if the sentinel identifier appears anywhere
 * in api source OUTSIDE `src/test/**` — the single sanctioned exception is
 * its definition site (and doc references) in `services/findingTriageLifecycle.ts`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SENTINEL = "TEST_ONLY_SKIP_IN_TX_AUTHORITY";
const SRC_ROOT = join(import.meta.dirname, "..");
/** The single production module allowed to mention the sentinel: its definition. */
const SANCTIONED_DEFINITION_MODULE = join("services", "findingTriageLifecycle.ts");

function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTypeScriptFiles(full));
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("test-only authority sentinel containment", () => {
  it("TEST_ONLY_SKIP_IN_TX_AUTHORITY appears only under src/test/ and its definition module", () => {
    const offenders: string[] = [];
    for (const file of listTypeScriptFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file);
      if (rel.split(/[\\/]/)[0] === "test") continue; // src/test/**
      if (rel === SANCTIONED_DEFINITION_MODULE) continue; // definition + doc site
      const content = readFileSync(file, "utf-8");
      if (content.includes(SENTINEL)) offenders.push(rel);
    }
    expect(
      offenders,
      `test-only authority sentinel leaked into production source: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
