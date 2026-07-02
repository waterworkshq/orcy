/**
 * Pure semver engine for v0.24.0 "Cadence" (ADR-0029 / DESIGN §1).
 *
 * No DB, no side effects, no imports of API services. Fully unit-testable in
 * isolation. Powers release-type classification (`classifyReleaseType`) and
 * the two matching arms of auto-promotion: cascading-type match
 * (`matchesReleaseType`) and version-pin match (`matchesReleaseVersion`).
 *
 * Strict-semver only: pre-release tags and build metadata are rejected by
 * `parseVersion` (out of scope for v0.24.0 per the PRD risk row). A future
 * release may widen `parseVersion` without breaking stored `releases.version`
 * rows, which are always strict semver.
 */

import type { ReleaseType } from "./types/release.js";

/** Parsed major.minor.patch triple (non-negative integers). */
export interface SemverVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parses a strict `MAJOR.MINOR.PATCH` version string into a `SemverVersion`.
 *
 * Strips a single leading `v`/`V`. Rejects pre-release tags (`v1.0.0-rc.1`),
 * build metadata (`v1.0.0+build`), non-numeric components, missing components,
 * and leading-zero components (`01.02.03`) by throwing
 * `Error("Invalid semver: <input>")`. `0.0.0` is valid.
 *
 * @example parseVersion("v0.24.1") → { major: 0, minor: 24, patch: 1 }
 */
export function parseVersion(input: string): SemverVersion {
  const stripped = input.replace(/^[vV]/, "");
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(stripped);
  if (!match) throw new Error(`Invalid semver: ${input}`);
  const [major, minor, patch] = [match[1], match[2], match[3]];
  if (
    (major.length > 1 && major.startsWith("0")) ||
    (minor.length > 1 && minor.startsWith("0")) ||
    (patch.length > 1 && patch.startsWith("0"))
  ) {
    throw new Error(`Invalid semver: ${input}`);
  }
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
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
  const parts = stripped.split(".");

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
      target.patch === shipped.patch
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
