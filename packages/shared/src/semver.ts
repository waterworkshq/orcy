/**
 * Pure semver engine for v0.24.0 "Cadence" (ADR-0029 / DESIGN §1).
 *
 * No DB, no side effects, no imports of API services. Fully unit-testable in
 * isolation. Powers release-type classification (`classifyReleaseType`) and
 * the two matching arms of auto-promotion: cascading-type match
 * (`matchesReleaseType`) and version-pin match (`matchesReleaseVersion`).
 *
 * Pre-release tags (e.g. `-rc.1`, `-beta`) are parsed and stored in the
 * `preRelease` field. Build metadata (`+build`) is stripped. Callers that
 * need strict-release-only semantics should check `isPreRelease()` after
 * parsing.
 */

import type { ReleaseType } from "./types/release.js";

/** Parsed major.minor.patch triple with optional pre-release suffix. */
export interface SemverVersion {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release suffix without the leading `-` (e.g. `"rc.1"`, `"beta"`), or `null` for strict releases. */
  preRelease: string | null;
}

/**
 * Parses a `MAJOR.MINOR.PATCH[-prerelease][+build]` version string.
 *
 * Strips a single leading `v`/`V`. Pre-release tags (`-rc.1`, `-beta`) are
 * captured in the `preRelease` field. Build metadata (`+build`) is stripped
 * and ignored. Rejects non-numeric components, missing components, and
 * leading-zero components (`01.02.03`) by throwing
 * `Error("Invalid semver: <input>")`. `0.0.0` is valid.
 *
 * @example parseVersion("v0.24.1") → { major: 0, minor: 24, patch: 1, preRelease: null }
 * @example parseVersion("v1.0.0-rc.1") → { major: 1, minor: 0, patch: 0, preRelease: "rc.1" }
 */
export function parseVersion(input: string): SemverVersion {
  const stripped = input.replace(/^[vV]/, "");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*))?(?:\+.*)?$/.exec(
    stripped,
  );
  if (!match) throw new Error(`Invalid semver: ${input}`);
  const [major, minor, patch] = [match[1], match[2], match[3]];
  if (
    (major.length > 1 && major.startsWith("0")) ||
    (minor.length > 1 && minor.startsWith("0")) ||
    (patch.length > 1 && patch.startsWith("0"))
  ) {
    throw new Error(`Invalid semver: ${input}`);
  }
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    preRelease: match[4] ?? null,
  };
}

/** Returns `true` when the parsed version has a pre-release suffix. */
export function isPreRelease(v: SemverVersion): boolean {
  return v.preRelease !== null;
}

/**
 * Classifies the type of a release relative to its predecessor: a major bump
 * (any major change) → `"major"`; else a minor bump → `"minor"`; else →
 * `"patch"`.
 *
 * Throws `Error("Cannot classify equal versions")` when `prior` deep-equals
 * `incoming` — equal versions are a bug condition (same version shipped
 * twice); the engine fails loud rather than silently returning `"patch"`.
 */
export function classifyReleaseType(prior: SemverVersion, incoming: SemverVersion): ReleaseType {
  if (
    prior.major === incoming.major &&
    prior.minor === incoming.minor &&
    prior.patch === incoming.patch
  ) {
    throw new Error("Cannot classify equal versions");
  }
  if (prior.major !== incoming.major) return "major";
  if (prior.minor !== incoming.minor) return "minor";
  return "patch";
}

/**
 * Cascading-type matcher: patch ⊂ minor ⊂ major. Returns true when `shipped`
 * is the same type OR a larger-scope type than `target`.
 *
 * - `target: "patch"` matches shipped `patch` | `minor` | `major`.
 * - `target: "minor"` matches shipped `minor` | `major`.
 * - `target: "major"` matches shipped `major` only.
 */
export function matchesReleaseType(target: ReleaseType, shipped: ReleaseType): boolean {
  if (target === "patch") return true;
  if (target === "minor") return shipped === "minor" || shipped === "major";
  return shipped === "major";
}

/**
 * Version-pin matcher for the `targetRelease` column (ADR-0029 version arm).
 * Never throws — the matching layer is total; malformed input returns `false`.
 *
 * - **Exact** (three components, e.g. `v0.24.0`): all three components equal.
 * - **Prefix** (two components, e.g. `v0.24`): major + minor equal, patch
 *   wildcard (matches any `0.24.x`).
 * - One-component, four-or-more-component, leading-zero, or otherwise
 *   malformed targets → `false`.
 */
export function matchesReleaseVersion(targetRelease: string, shippedVersion: string): boolean {
  let shipped: SemverVersion;
  try {
    shipped = parseVersion(shippedVersion);
  } catch {
    return false;
  }

  const stripped = targetRelease.replace(/^[vV]/, "");
  // Split on first two dots only — the third segment may contain pre-release
  // dots (e.g. "0.24.0-rc.1" → ["0", "24", "0-rc.1"]).
  const i = stripped.indexOf(".");
  const parts =
    i === -1
      ? [stripped]
      : (() => {
          const j = stripped.indexOf(".", i + 1);
          return j === -1
            ? [stripped.slice(0, i), stripped.slice(i + 1)]
            : [stripped.slice(0, i), stripped.slice(i + 1, j), stripped.slice(j + 1)];
        })();

  if (parts.length === 3) {
    let target: SemverVersion;
    try {
      target = parseVersion(targetRelease);
    } catch {
      return false;
    }
    return (
      target.major === shipped.major &&
      target.minor === shipped.minor &&
      target.patch === shipped.patch &&
      target.preRelease === shipped.preRelease
    );
  }

  if (parts.length === 2) {
    if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return false;
    if (
      (parts[0].length > 1 && parts[0].startsWith("0")) ||
      (parts[1].length > 1 && parts[1].startsWith("0"))
    ) {
      return false;
    }
    return Number(parts[0]) === shipped.major && Number(parts[1]) === shipped.minor;
  }

  return false;
}

/**
 * Release-gate satisfaction check (ADR-0032). Pure, total, side-effect-free.
 *
 * A gate is satisfied if EITHER arm matches (mirrors ADR-0029 either-match):
 * the type-cascade arm (`releaseGateType` via {@link matchesReleaseType}) OR the
 * version-pin arm (`releaseGateVersion` via {@link matchesReleaseVersion}). A
 * mission with no gate set (both fields null/empty) is trivially satisfied.
 *
 * `shippedTypes`/`shippedVersions` are the releases already detected for the
 * habitat (for the work-surfacing/roadmap paths) OR the single release that
 * just shipped (wrapped in a 1-element set/array for the activation path).
 *
 * @param gate - the gate fields, shaped after the `missions` columns.
 * @param shippedTypes - detected release types for the habitat (or the just-shipped one).
 * @param shippedVersions - detected release versions for the habitat (or the just-shipped one).
 */
export function isReleaseGateSatisfied(
  gate: { releaseGateType: string | null; releaseGateVersion: string | null },
  shippedTypes: Set<ReleaseType>,
  shippedVersions: string[],
): boolean {
  if (!gate.releaseGateType && !gate.releaseGateVersion) return true;
  const typeArm = gate.releaseGateType
    ? [...shippedTypes].some((shipped) =>
        matchesReleaseType(gate.releaseGateType as ReleaseType, shipped),
      )
    : false;
  const versionArm = gate.releaseGateVersion
    ? shippedVersions.some((v) => matchesReleaseVersion(gate.releaseGateVersion!, v))
    : false;
  return typeArm || versionArm;
}
