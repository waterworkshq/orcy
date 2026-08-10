/**
 * P7.2 — `.bak.<ts>` pruning.
 *
 * `backupFile` (writers/index.ts) writes `<filePath>.bak.<iso-ts>` before
 * overwriting a file. Without pruning, every re-install leaves another `.bak`
 * behind — accumulating forever. `pruneBackups(filePath, keepN)` keeps the
 * newest `keepN` and unlinks the rest; `backupFile` calls it automatically so
 * every backup-producing site gets the policy for free.
 *
 * Boundary: real `node:fs` against the temp home; the harness mocks
 * `@orcy/shared` / `node:child_process` only — `pruneBackups` is a pure node:fs
 * operation and doesn't depend on those mocks.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import "./helpers/setup.js";
import { tempHome } from "./helpers/setup.js";
import { pruneBackups, backupFile } from "../src/writers/index.js";

function fileInTmp(name: string): string {
  return path.join(tempHome(), name);
}

function listBackups(filePath: string): string[] {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const prefix = base + ".bak.";
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(prefix))
      .sort();
  } catch {
    return [];
  }
}

// Valid `.bak.<ts>` suffixes in the exact grammar backupFile emits
// (ISO 8601 with ':' and '.' → '-'). Lex sort == chronological order.
const T1 = "2024-01-01T00-00-00-000Z";
const T2 = "2024-01-01T00-00-01-000Z";
const T3 = "2024-01-01T00-00-02-000Z";
const T4 = "2024-01-01T00-00-03-000Z";

describe("pruneBackups", () => {
  it("keeps only the newest .bak when keepN=1", () => {
    const file = fileInTmp("prune-keep1.cfg");
    fs.writeFileSync(file, "live content\n", "utf-8");
    fs.writeFileSync(`${file}.bak.${T1}`, "v1\n", "utf-8");
    fs.writeFileSync(`${file}.bak.${T2}`, "v2\n", "utf-8");
    fs.writeFileSync(`${file}.bak.${T3}`, "v3\n", "utf-8");
    expect(listBackups(file)).toEqual([
      `prune-keep1.cfg.bak.${T1}`,
      `prune-keep1.cfg.bak.${T2}`,
      `prune-keep1.cfg.bak.${T3}`,
    ]);

    pruneBackups(file, 1);

    expect(listBackups(file)).toEqual([`prune-keep1.cfg.bak.${T3}`]);
  });

  it("defaults keepN to 1 when omitted", () => {
    const file = fileInTmp("prune-default.cfg");
    fs.writeFileSync(`${file}.bak.${T1}`, "1\n", "utf-8");
    fs.writeFileSync(`${file}.bak.${T2}`, "2\n", "utf-8");
    fs.writeFileSync(`${file}.bak.${T3}`, "3\n", "utf-8");

    pruneBackups(file);

    expect(listBackups(file)).toEqual([`prune-default.cfg.bak.${T3}`]);
  });

  it("keeps the newest N when keepN > 1", () => {
    const file = fileInTmp("prune-keep3.cfg");
    fs.writeFileSync(`${file}.bak.${T1}`, "1\n", "utf-8");
    fs.writeFileSync(`${file}.bak.${T2}`, "2\n", "utf-8");
    fs.writeFileSync(`${file}.bak.${T3}`, "3\n", "utf-8");
    fs.writeFileSync(`${file}.bak.${T4}`, "4\n", "utf-8");

    pruneBackups(file, 3);

    expect(listBackups(file)).toEqual([
      `prune-keep3.cfg.bak.${T2}`,
      `prune-keep3.cfg.bak.${T3}`,
      `prune-keep3.cfg.bak.${T4}`,
    ]);
  });

  it("is a no-op when there are no .bak files", () => {
    const file = fileInTmp("prune-empty.cfg");
    fs.writeFileSync(file, "live\n", "utf-8");
    expect(listBackups(file)).toEqual([]);

    expect(() => pruneBackups(file, 1)).not.toThrow();

    expect(listBackups(file)).toEqual([]);
  });

  it("is a no-op when there are fewer .bak files than keepN", () => {
    const file = fileInTmp("prune-underflow.cfg");
    fs.writeFileSync(`${file}.bak.${T1}`, "1\n", "utf-8");

    pruneBackups(file, 5);

    expect(listBackups(file)).toEqual([`prune-underflow.cfg.bak.${T1}`]);
  });

  it("ignores unrelated files AND non-timestamp siblings like .bak.notes (T4.7)", () => {
    const file = fileInTmp("prune-noise.cfg");
    const unrelated = fileInTmp("other.bak.t1");
    const userNotes = `${file}.bak.notes`; // user file — must NOT be swept
    fs.writeFileSync(`${file}.bak.${T1}`, "1\n", "utf-8");
    fs.writeFileSync(`${file}.bak.${T2}`, "2\n", "utf-8");
    fs.writeFileSync(unrelated, "x\n", "utf-8");
    fs.writeFileSync(userNotes, "my notes\n", "utf-8");

    pruneBackups(file, 1);

    expect(listBackups(file)).toEqual([`prune-noise.cfg.bak.${T2}`, "prune-noise.cfg.bak.notes"]);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.existsSync(userNotes), "user .bak.notes preserved").toBe(true);
  });
});

describe("backupFile auto-prunes", () => {
  it("keeps only the newest backup after each backupFile call", async () => {
    const file = fileInTmp("autoprune.cfg");
    fs.writeFileSync(file, "v1\n", "utf-8");

    const first = backupFile(file);
    expect(first).toBeTruthy();
    expect(listBackups(file)).toEqual([path.basename(first!)]);

    // Modify content so each subsequent backup has a lexicographically greater
    // timestamp suffix — a small delay guarantees a distinct ISO string even
    // when the underlying clock has ms resolution.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    fs.writeFileSync(file, "v2\n", "utf-8");
    await sleep(5);
    const second = backupFile(file);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(listBackups(file)).toEqual([path.basename(second!)]);

    fs.writeFileSync(file, "v3\n", "utf-8");
    await sleep(5);
    const third = backupFile(file);
    expect(third).toBeTruthy();
    expect(listBackups(file)).toEqual([path.basename(third!)]);
  });
});
