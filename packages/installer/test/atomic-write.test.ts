/**
 * Tests for the shared atomic-write helper. Covers the extraction from
 * manifest.ts and journal.ts: correct content/mode on success, and the
 * dangling-temp fix (no `.tmp` left behind on failure).
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import "./helpers/setup.js";
import { orcyHome, manifestPath } from "./helpers/setup.js";
import { atomicWriteJson } from "../src/atomic-write.js";
import { writeManifest, type Manifest } from "../src/manifest.js";

describe("atomicWriteJson", () => {
  it("writes the target file with correct content and mode 0o600 on success", () => {
    const target = path.join(orcyHome(), "test-atomic.json");

    atomicWriteJson(target, JSON.stringify({ hello: "world" }, null, 2));

    expect(fs.existsSync(target)).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ hello: "world" });

    const stat = fs.statSync(target);
    expect(stat.mode & 0o777).toBe(0o600);

    // temp file is cleaned up after successful rename
    expect(fs.existsSync(target + ".tmp")).toBe(false);
  });

  it("writeManifest failure leaves no dangling .tmp file (dangling-temp fix)", () => {
    const spy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("boom");
    });

    const m: Manifest = {
      version: 1,
      installedAt: "2025-01-01T00:00:00.000Z",
      components: [],
      files: [],
    };

    expect(() => writeManifest(m)).toThrow("boom");
    // The fix: the helper unlinks the temp on failure, so no dangling .tmp remains.
    expect(fs.existsSync(manifestPath() + ".tmp")).toBe(false);

    spy.mockRestore();
  });
});
