import { describe, it, expect } from "vitest";
import {
  parseVersion,
  classifyReleaseType,
  matchesReleaseType,
  matchesReleaseVersion,
  isPreRelease,
} from "../semver.js";

describe("parseVersion", () => {
  it.each([
    ["v0.24.1", { major: 0, minor: 24, patch: 1, preRelease: null }],
    ["0.24.0", { major: 0, minor: 24, patch: 0, preRelease: null }],
    ["V1.2.3", { major: 1, minor: 2, patch: 3, preRelease: null }],
    ["0.0.0", { major: 0, minor: 0, patch: 0, preRelease: null }],
    ["10.20.30", { major: 10, minor: 20, patch: 30, preRelease: null }],
    ["v1.0.0-rc.1", { major: 1, minor: 0, patch: 0, preRelease: "rc.1" }],
    ["v1.0.0-beta", { major: 1, minor: 0, patch: 0, preRelease: "beta" }],
    ["v0.24.0-alpha.3", { major: 0, minor: 24, patch: 0, preRelease: "alpha.3" }],
    ["v1.0.0-rc.1+build.123", { major: 1, minor: 0, patch: 0, preRelease: "rc.1" }],
  ])("parses %s", (input, expected) => {
    expect(parseVersion(input)).toEqual(expected);
  });

  it.each([
    ["01.02.03"],
    ["v1.0"],
    ["v1"],
    ["v1.0.0.0"],
    ["v1.0.x"],
    ["v"],
    [""],
    ["banana"],
    ["v01.0.0"],
    ["v1.01.0"],
    ["v1.0.01"],
  ])("throws on invalid input %s", (input) => {
    expect(() => parseVersion(input)).toThrow(/^Invalid semver: /);
  });
});

describe("classifyReleaseType", () => {
  it("classifies a patch bump", () => {
    expect(classifyReleaseType(parseVersion("0.23.4"), parseVersion("0.23.5"))).toBe("patch");
  });

  it("classifies a minor bump", () => {
    expect(classifyReleaseType(parseVersion("0.23.5"), parseVersion("0.24.0"))).toBe("minor");
  });

  it("classifies a major bump", () => {
    expect(classifyReleaseType(parseVersion("0.24.0"), parseVersion("1.0.0"))).toBe("major");
  });

  it("classifies a minor bump across a patch difference", () => {
    expect(classifyReleaseType(parseVersion("0.23.5"), parseVersion("0.24.3"))).toBe("minor");
  });

  it("classifies a major bump across minor and patch differences", () => {
    expect(classifyReleaseType(parseVersion("0.24.5"), parseVersion("1.2.0"))).toBe("major");
  });

  it("throws when versions are equal", () => {
    expect(() => classifyReleaseType(parseVersion("0.24.0"), parseVersion("0.24.0"))).toThrow(
      "Cannot classify equal versions",
    );
  });
});

describe("matchesReleaseType", () => {
  it.each([
    ["patch", "patch", true],
    ["patch", "minor", true],
    ["patch", "major", true],
    ["minor", "patch", false],
    ["minor", "minor", true],
    ["minor", "major", true],
    ["major", "patch", false],
    ["major", "minor", false],
    ["major", "major", true],
  ] as const)("target %s vs shipped %s → %s", (target, shipped, expected) => {
    expect(matchesReleaseType(target, shipped)).toBe(expected);
  });
});

describe("matchesReleaseVersion", () => {
  describe("exact (three components)", () => {
    it.each([
      ["v0.24.0", "v0.24.0", true],
      ["0.24.0", "0.24.0", true],
      ["0.24.0", "0.24.1", false],
      ["0.24.1", "0.24.0", false],
      ["1.0.0", "1.0.0", true],
      ["1.2.3", "1.2.4", false],
    ])("target %s vs shipped %s → %s", (target, shipped, expected) => {
      expect(matchesReleaseVersion(target, shipped)).toBe(expected);
    });
  });

  describe("prefix (two components)", () => {
    it.each([
      ["v0.24", "v0.24.1", true],
      ["0.24", "0.24.99", true],
      ["0.24", "0.25.0", false],
      ["0.24", "0.23.9", false],
      ["1.2", "1.2.3", true],
      ["1.2", "1.3.0", false],
    ])("target prefix %s vs shipped %s → %s", (target, shipped, expected) => {
      expect(matchesReleaseVersion(target, shipped)).toBe(expected);
    });
  });

  describe("pre-release and build-metadata targets", () => {
    it.each([
      ["0.24.0-rc.1", "0.24.0", false], // pre-release ≠ strict release (different preRelease field)
      ["0.24.0-rc.1", "0.24.0-rc.1", true], // same pre-release matches
      ["v1.0.0+build", "1.0.0", true], // build metadata stripped, base matches
    ])("target %s vs shipped %s → %s", (target, shipped, expected) => {
      expect(matchesReleaseVersion(target, shipped)).toBe(expected);
    });
  });

  describe("malformed targets (never throws)", () => {
    it.each([
      ["0", "0.24.0"],
      ["v", "0.24.0"],
      ["0.24.0.0", "0.24.0"],
      ["banana", "0.24.0"],
      ["01.02", "0.24.0"],
      ["", "0.24.0"],
    ])("malformed target %s vs shipped %s → false", (target, shipped) => {
      expect(matchesReleaseVersion(target, shipped)).toBe(false);
    });

    it("returns false when the shipped version is malformed", () => {
      expect(matchesReleaseVersion("0.24.0", "banana")).toBe(false);
      expect(matchesReleaseVersion("0.24", "not-a-version")).toBe(false);
    });
  });
});

describe("isPreRelease", () => {
  it("returns false for strict releases", () => {
    expect(isPreRelease(parseVersion("v1.0.0"))).toBe(false);
    expect(isPreRelease(parseVersion("0.24.1"))).toBe(false);
  });

  it("returns true for pre-release versions", () => {
    expect(isPreRelease(parseVersion("v1.0.0-rc.1"))).toBe(true);
    expect(isPreRelease(parseVersion("v0.1.0-beta"))).toBe(true);
    expect(isPreRelease(parseVersion("v1.0.0-alpha.3"))).toBe(true);
  });
});
