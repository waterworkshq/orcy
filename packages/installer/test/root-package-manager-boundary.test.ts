/**
 * REL-INFRA-2.1 — root package-script pnpm re-entry boundary.
 *
 * Under a Corepack parent, a nested bare `pnpm` inside a root package script
 * resolves an ambient pnpm and refuses to self-switch to the repository's
 * `packageManager` pin — exit 1. Every root-script pnpm
 * invocation must therefore enter through `corepack pnpm` so the pin stays the
 * single version authority.
 *
 * This guard deliberately checks the closed root-script surface rather than
 * maintaining a second script-name allowlist: it strips every sanctioned
 * `corepack pnpm` pair from each script body and fails if any `pnpm` token
 * survives anywhere.
 *
 * `ORCY_ROOT_PKG_JSON_OVERRIDE` is a test-only fixture seam for the mutation
 * discriminator: it redirects which package.json the guard reads. It never
 * weakens the assertion — the same strip-and-scan runs against the override.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import "./helpers/setup.js";

/** Sanctioned command pair: corepack-mediated pnpm entry. */
const COREPACK_PNPM_PAIR = /corepack\s+pnpm/g;

/** Target for the guard: the repo root manifest, unless a fixture overrides it. */
function rootPackageJsonPath(): string {
  const override = process.env.ORCY_ROOT_PKG_JSON_OVERRIDE;
  if (override !== undefined && override !== "") return override;
  return path.resolve(import.meta.dirname, "..", "..", "..", "package.json");
}

type Violation = { script: string; body: string };

function findBarePnpmScripts(pkgJsonPath: string): Violation[] {
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};
  expect(Object.keys(scripts).length).toBeGreaterThan(0);

  const violations: Violation[] = [];
  for (const [script, body] of Object.entries(scripts)) {
    const residual = body.replace(COREPACK_PNPM_PAIR, "");
    if (/\bpnpm\b/.test(residual)) violations.push({ script, body });
  }
  return violations;
}

describe("root package-script pnpm boundary (REL-INFRA-2.1)", () => {
  it("every pnpm invocation in root scripts enters through corepack", () => {
    const violations = findBarePnpmScripts(rootPackageJsonPath());
    expect(violations.map((v) => `${v.script}: ${v.body}`)).toEqual([]);
  });
});
