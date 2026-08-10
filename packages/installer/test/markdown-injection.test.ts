/**
 * P4.2 — Markdown injection idempotency (G8).
 *
 * `injectIntoFile` must be a clean "ensure exactly one fence exists with this
 * content," surviving both re-runs and partial-marker states (a user edit that
 * deletes only START or only END). `removeFromFile` must robustly strip a fence
 * in any marker state, not no-op on single survivors.
 *
 * Boundary: real `node:fs` against the temp home; `@orcy/shared` /
 * `node:child_process` mocked by the harness so `record()` + `generateBlock`
 * resolve under the temp home. The `InstallContext.binDir` points at an empty
 * dir so every tool shows ✗ — only the fence structure matters here.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import "./helpers/setup.js";
import { tempHome, orcyHome } from "./helpers/setup.js";
import { injectIntoFile, removeFromFile } from "../src/markdown-injector.js";
import type { InstallContext } from "../src/context.js";

const START = "<!-- orcy:start -->";
const END = "<!-- orcy:end -->";

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

function makeCtx(): InstallContext {
  return {
    orcyHome: orcyHome(),
    binDir: path.join(orcyHome(), "bin"),
    uiDir: path.join(orcyHome(), "ui"),
    runDir: path.join(orcyHome(), "run"),
    logsDir: path.join(orcyHome(), "logs"),
    apiUrl: "http://127.0.0.1:4000",
    platform: "linux",
    shell: "bash",
    homeDir: tempHome(),
  };
}

function tmpFile(name: string): string {
  return path.join(tempHome(), `md-${name}.md`);
}

describe("injectIntoFile — idempotency (G8)", () => {
  it("injects a single fence into a fresh file", () => {
    const f = tmpFile("fresh");
    injectIntoFile(f, makeCtx());
    const out = fs.readFileSync(f, "utf-8");
    expect(countOccurrences(out, START)).toBe(1);
    expect(countOccurrences(out, END)).toBe(1);
  });

  it("inject x3 leaves exactly one fence", () => {
    const f = tmpFile("triple");
    for (let i = 0; i < 3; i++) injectIntoFile(f, makeCtx());
    const out = fs.readFileSync(f, "utf-8");
    expect(countOccurrences(out, START)).toBe(1);
    expect(countOccurrences(out, END)).toBe(1);
  });

  it("clears pre-existing DUPLICATE fences down to one on inject (T2.2)", () => {
    const f = tmpFile("dup-pairs");
    injectIntoFile(f, makeCtx());
    // Manually append a SECOND complete fence (simulates a pre-P4.2 bug state).
    const block = fs.readFileSync(f, "utf-8");
    fs.writeFileSync(f, block + "\n" + block, "utf-8");
    expect(countOccurrences(fs.readFileSync(f, "utf-8"), START)).toBe(2);
    expect(countOccurrences(fs.readFileSync(f, "utf-8"), END)).toBe(2);

    injectIntoFile(f, makeCtx());
    const out = fs.readFileSync(f, "utf-8");
    expect(countOccurrences(out, START)).toBe(1);
    expect(countOccurrences(out, END)).toBe(1);
  });

  it("clears END-before-START (malformed) down to a clean single fence on inject (T2.2)", () => {
    const f = tmpFile("end-before-start");
    // A malformed state: END appears before START.
    fs.writeFileSync(f, `intro\n${END}\nmid\n${START}\nbody\ntail\n`, "utf-8");
    injectIntoFile(f, makeCtx());
    const out = fs.readFileSync(f, "utf-8");
    expect(countOccurrences(out, START)).toBe(1);
    expect(countOccurrences(out, END)).toBe(1);
    expect(out).toContain("intro");
    expect(out).toContain("tail");
  });

  it("preserves surrounding user content across injections", () => {
    const f = tmpFile("surround");
    fs.writeFileSync(f, "# My Project\n\nSome user notes.\n", "utf-8");
    injectIntoFile(f, makeCtx());
    injectIntoFile(f, makeCtx());
    const out = fs.readFileSync(f, "utf-8");
    expect(out).toContain("# My Project");
    expect(out).toContain("Some user notes.");
    expect(countOccurrences(out, START)).toBe(1);
    expect(countOccurrences(out, END)).toBe(1);
  });

  it("recovers from a partial-marker state: END deleted, then re-inject → single clean fence", () => {
    const f = tmpFile("end-deleted");
    injectIntoFile(f, makeCtx());
    // Simulate a user edit that deletes only the END marker.
    let c = fs.readFileSync(f, "utf-8");
    c = c.replace(END, "");
    fs.writeFileSync(f, c, "utf-8");
    // Pre-condition: orphan START present, no END.
    expect(countOccurrences(fs.readFileSync(f, "utf-8"), START)).toBe(1);
    expect(countOccurrences(fs.readFileSync(f, "utf-8"), END)).toBe(0);

    injectIntoFile(f, makeCtx());
    const out = fs.readFileSync(f, "utf-8");
    expect(countOccurrences(out, START)).toBe(1);
    expect(countOccurrences(out, END)).toBe(1);
  });

  it("recovers from a partial-marker state: START deleted, then re-inject → single clean fence", () => {
    const f = tmpFile("start-deleted");
    injectIntoFile(f, makeCtx());
    let c = fs.readFileSync(f, "utf-8");
    c = c.replace(START, "");
    fs.writeFileSync(f, c, "utf-8");
    expect(countOccurrences(fs.readFileSync(f, "utf-8"), START)).toBe(0);
    expect(countOccurrences(fs.readFileSync(f, "utf-8"), END)).toBe(1);

    injectIntoFile(f, makeCtx());
    const out = fs.readFileSync(f, "utf-8");
    expect(countOccurrences(out, START)).toBe(1);
    expect(countOccurrences(out, END)).toBe(1);
  });
});

describe("removeFromFile — robustness across marker states", () => {
  it("removes a complete fence and returns true", () => {
    const f = tmpFile("rm-complete");
    injectIntoFile(f, makeCtx());
    expect(removeFromFile(f)).toBe(true);
    const out = fs.readFileSync(f, "utf-8");
    expect(countOccurrences(out, START)).toBe(0);
    expect(countOccurrences(out, END)).toBe(0);
  });

  it("strips an orphan START marker (END already absent) and returns true", () => {
    const f = tmpFile("rm-orphan-start");
    fs.writeFileSync(f, `# title\n\n${START}\n\norphan body\n`, "utf-8");
    expect(removeFromFile(f)).toBe(true);
    const out = fs.readFileSync(f, "utf-8");
    expect(countOccurrences(out, START)).toBe(0);
    // Body the marker trapped is left intact (only the marker line is removed).
    expect(out).toContain("orphan body");
    expect(out).toContain("# title");
  });

  it("strips an orphan END marker and returns true", () => {
    const f = tmpFile("rm-orphan-end");
    fs.writeFileSync(f, `intro\n${END}\ntail\n`, "utf-8");
    expect(removeFromFile(f)).toBe(true);
    const out = fs.readFileSync(f, "utf-8");
    expect(countOccurrences(out, END)).toBe(0);
    expect(out).toContain("intro");
    expect(out).toContain("tail");
  });

  it("returns false and leaves the file unchanged when no markers are present", () => {
    const f = tmpFile("rm-none");
    const original = "# just user content\nno markers here\n";
    fs.writeFileSync(f, original, "utf-8");
    expect(removeFromFile(f)).toBe(false);
    expect(fs.readFileSync(f, "utf-8")).toBe(original);
  });

  it("returns false for a missing file", () => {
    expect(removeFromFile(tmpFile("does-not-exist"))).toBe(false);
  });
});
