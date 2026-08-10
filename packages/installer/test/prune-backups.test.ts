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

describe("pruneBackups", () => {
  it("keeps only the newest .bak when keepN=1", () => {
    const file = fileInTmp("prune-keep1.cfg");
    fs.writeFileSync(file, "live content\n", "utf-8");
    // Three backups with monotonically increasing timestamps (lex sort == time order).
    fs.writeFileSync(file + ".bak.t1-old", "v1\n", "utf-8");
    fs.writeFileSync(file + ".bak.t2-mid", "v2\n", "utf-8");
    fs.writeFileSync(file + ".bak.t3-new", "v3\n", "utf-8");
    expect(listBackups(file)).toEqual([
      "prune-keep1.cfg.bak.t1-old",
      "prune-keep1.cfg.bak.t2-mid",
      "prune-keep1.cfg.bak.t3-new",
    ]);

    pruneBackups(file, 1);

    expect(listBackups(file)).toEqual(["prune-keep1.cfg.bak.t3-new"]);
  });

  it("defaults keepN to 1 when omitted", () => {
    const file = fileInTmp("prune-default.cfg");
    fs.writeFileSync(file + ".bak.a", "1\n", "utf-8");
    fs.writeFileSync(file + ".bak.b", "2\n", "utf-8");
    fs.writeFileSync(file + ".bak.c", "3\n", "utf-8");

    pruneBackups(file);

    expect(listBackups(file)).toEqual(["prune-default.cfg.bak.c"]);
  });

  it("keeps the newest N when keepN > 1", () => {
    const file = fileInTmp("prune-keep3.cfg");
    fs.writeFileSync(file + ".bak.t1", "1\n", "utf-8");
    fs.writeFileSync(file + ".bak.t2", "2\n", "utf-8");
    fs.writeFileSync(file + ".bak.t3", "3\n", "utf-8");
    fs.writeFileSync(file + ".bak.t4", "4\n", "utf-8");

    pruneBackups(file, 3);

    expect(listBackups(file)).toEqual([
      "prune-keep3.cfg.bak.t2",
      "prune-keep3.cfg.bak.t3",
      "prune-keep3.cfg.bak.t4",
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
    fs.writeFileSync(file + ".bak.t1", "1\n", "utf-8");

    pruneBackups(file, 5);

    expect(listBackups(file)).toEqual(["prune-underflow.cfg.bak.t1"]);
  });

  it("ignores unrelated files in the same directory", () => {
    const file = fileInTmp("prune-noise.cfg");
    const unrelated = fileInTmp("other.bak.t1");
    fs.writeFileSync(file + ".bak.t1", "1\n", "utf-8");
    fs.writeFileSync(file + ".bak.t2", "2\n", "utf-8");
    fs.writeFileSync(unrelated, "x\n", "utf-8");

    pruneBackups(file, 1);

    expect(listBackups(file)).toEqual(["prune-noise.cfg.bak.t2"]);
    expect(fs.existsSync(unrelated)).toBe(true);
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
