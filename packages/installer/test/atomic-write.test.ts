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

    // temp file is cleaned up after successful rename (temp is now per-write unique)
    expect(fs.readdirSync(orcyHome()).some((f) => f.startsWith("test-atomic.json.tmp"))).toBe(
      false,
    );
  });

  it("writeManifest failure leaves no dangling temp file (dangling-temp fix)", () => {
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
    // The fix: the helper unlinks the (per-write unique) temp on failure.
    expect(
      fs
        .readdirSync(path.dirname(manifestPath()))
        .some((f) => f.startsWith("install-manifest.json.tmp")),
      "no dangling temp left behind",
    ).toBe(false);

    spy.mockRestore();
  });

  it("T3.2: mode 0o600 is forced even when the temp path pre-exists with a looser mode (fchmod)", () => {
    const target = path.join(orcyHome(), "mode-test.json");
    // Pre-create the EXACT temp path the writer will use, with a looser mode —
    // writeFileSync alone would overwrite-in-place and inherit 0o644; fchmod forces 0o600.
    const tempPath = `${target}.tmp.${process.pid}`;
    fs.writeFileSync(tempPath, "stale", { mode: 0o644 });

    atomicWriteJson(target, "{}");

    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });
});
