/**
 * Legacy notification wrapper retirement guard (N8/N9 boundary; T10.1's
 * ARCHITECTURE prose and the @deprecated banners lean on this test).
 *
 * `services/notificationCommandService.ts` is deprecated test-only surface
 * after the recipient-intent migration: its three enqueue/resolution wrappers
 * are the OLD audience authority (silent remote augmentation, no writer
 * reservation). No production module may acquire them in ANY binding form.
 *
 * Production source = packages/api/src minus src/test/** minus the definition
 * module itself. Rules:
 *   A. no import/export-from clause may bind one of the three wrapper names
 *      from the legacy module — plain, aliased (`as`), or string-named;
 *      TYPE-only imports (`EnqueueNotificationCommand`/`EnqueueNotificationResult`)
 *      stay legal (erased at runtime, no authority);
 *   B. no namespace import (`import * as x from`), wildcard re-export
 *      (`export * [as x] from`), dynamic `import("…")`, or `require("…")` of
 *      the legacy module — any of these reaches the wrapper values and would
 *      bypass A; literal specifiers are cooked (escape sequences resolved)
 *      before matching, so `notificationCommandService.js` is caught too;
 *   C. call/reference tripwire: a `wrapperName(` call shape in comment-stripped
 *      production source — belt-and-suspenders for a binding smuggled without
 *      a visible import clause; string-literal occurrences fail closed, the
 *      same documented token-context residual class as the house pattern.
 * Non-literal specifiers (a variable `import(mod)`) are the standing dataflow
 * residual, accepted at the same precision as the house guard.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// GROUND: T9 (MIGRATION-TASKS 9.3) — PRD N8 "No invisible audience
// contraction/expansion through an old generic wrapper" + N9 minimum
// compatibility footprint; DESIGN §1 "do not silently maintain two production
// policy authorities"; DESIGN §2 notificationCommandService row: "Retire
// production use after a complete caller census." Detectors below are the
// complete fence; stripComments is copied VERBATIM from the
// httpRouteAuthorityBoundary.test.ts house pattern (importing a .test.ts would
// execute its describe blocks inside this run).

function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    switch (state) {
      case "code":
        if (c === "/" && next === "/") {
          state = "line";
          out += "  ";
          i += 2;
        } else if (c === "/" && next === "*") {
          state = "block";
          out += "  ";
          i += 2;
        } else if (c === "'") {
          state = "single";
          out += c;
          i += 1;
        } else if (c === '"') {
          state = "double";
          out += c;
          i += 1;
        } else if (c === "`") {
          state = "template";
          out += c;
          i += 1;
        } else {
          out += c;
          i += 1;
        }
        break;
      case "line":
        if (c === "\n") {
          state = "code";
          out += c;
        } else {
          out += " ";
        }
        i += 1;
        break;
      case "block":
        if (c === "*" && next === "/") {
          state = "code";
          out += "  ";
          i += 2;
        } else {
          out += c === "\n" ? "\n" : " ";
          i += 1;
        }
        break;
      case "single":
      case "double":
        out += c;
        if (c === "\\") {
          out += next ?? "";
          i += 2;
        } else {
          if ((state === "single" && c === "'") || (state === "double" && c === '"')) {
            state = "code";
          }
          i += 1;
        }
        break;
      case "template":
        out += c;
        if (c === "\\") {
          out += next ?? "";
          i += 2;
        } else {
          if (c === "`") state = "code";
          i += 1;
        }
        break;
    }
  }
  return out;
}

const SRC_ROOT = join(import.meta.dirname, ".."); // packages/api/src — ONE parent from src/test (round-4 flag 12)
const LEGACY_REL = join("services", "notificationCommandService.ts");
const LEGACY_SPECIFIER = /(?:^|[./])notificationCommandService(?:\.js)?$/; // literal module specifier

/** Cook a raw literal (escape sequences intact) to its runtime string value. */
function cook(raw: string): string {
  return raw.replace(
    /\\\r?\n|\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|\\([\s\S])/g,
    (_m, uB: string, u4: string, x2: string, ch: string) => {
      if (uB !== undefined) return String.fromCodePoint(parseInt(uB, 16));
      if (u4 !== undefined) return String.fromCharCode(parseInt(u4, 16));
      if (x2 !== undefined) return String.fromCharCode(parseInt(x2, 16));
      if (ch !== undefined) return ch; // identity escape (\. → .); octal/`\n` never appear in specifiers
      return ""; // line continuation
    },
  );
}
const WRAPPERS = ["enqueueNotification", "enqueueNotificationForRecipients", "getResolvedRecipients"] as const;

function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTypeScriptFiles(full));
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Production files: src/** minus src/test/** minus the definition module. */
function productionFiles(): string[] {
  return listTypeScriptFiles(SRC_ROOT)
    .map((file) => relative(SRC_ROOT, file))
    .filter((rel) => rel.split(/[\\/]/)[0] !== "test" && rel !== LEGACY_REL);
}

/** All import/export-from clauses whose cooked specifier is the legacy module. */
function legacyClauses(stripped: string): string[] {
  const clauses: string[] = [];
  const re = /(?:import|export)\s+(?:type\s+)?[^;()]*?\s*from\s*(["'`])([^"'`]+)\1/g;
  for (const m of stripped.matchAll(re)) {
    if (LEGACY_SPECIFIER.test(cook(m[2]!))) clauses.push(m[0]);
  }
  return clauses;
}

/** Namespace/wildcard/dynamic/require acquisition of the legacy module (any binding). */
function legacyAcquisition(stripped: string): string | null {
  const spec = (specifier: string) => LEGACY_SPECIFIER.test(cook(specifier));
  let m: RegExpExecArray | null;
  const wc = /export\s*\*(?:\s*as\s+\w+)?\s*from\s*(["'`])([^"'`]+)\1/g;
  while ((m = wc.exec(stripped))) if (spec(m[2]!)) return "wildcard re-export";
  const ns = /import\s*\*\s*as\s+\w+\s*from\s*(["'`])([^"'`]+)\1/g;
  while ((m = ns.exec(stripped))) if (spec(m[2]!)) return "namespace import";
  const dyn = /(?:import|require)\s*\(?\s*(["'`])([^"'`]+)\1/g;
  while ((m = dyn.exec(stripped))) {
    if (spec(m[2]!)) return m[0]!.startsWith("import") ? "dynamic import()" : "require()";
  }
  return null;
}

/** Every rule violation in one production file's comment-stripped source. */
function violationsIn(rel: string, stripped: string): string[] {
  const errs: string[] = [];
  for (const clause of legacyClauses(stripped)) {
    for (const w of WRAPPERS) {
      if (new RegExp(`\\b${w}\\b`).test(clause)) {
        errs.push(`${rel}: ${clause.trim().startsWith("export") ? "re-exports" : "imports"} banned wrapper ${w} from the legacy module`);
      }
    }
  }
  const acq = legacyAcquisition(stripped);
  if (acq) errs.push(`${rel}: ${acq} of the legacy module (aliases/wildcards bypass the named-import ban)`);
  for (const w of WRAPPERS) {
    if (new RegExp(`\\b${w}\\s*\\(`).test(stripped)) {
      errs.push(`${rel}: references banned wrapper ${w}( — audience authority is notificationIntentCommand.ts`);
    }
  }
  return errs;
}

describe("legacy notification wrapper retirement guard", () => {
  // GROUND: PRD N8 — no production module reaches the old generic wrapper in
  // any binding form; the sole audience authority is notificationIntentCommand.
  it("no production module imports, aliases, namespaces, re-exports, dynamically acquires, or calls the retired wrappers", () => {
    const errs = productionFiles().flatMap((rel) => violationsIn(rel, stripComments(readFileSync(join(SRC_ROOT, rel), "utf8"))));
    expect(errs).toEqual([]);
  });

  // GROUND: PRD N10 — discriminating proof; a scanning regression (empty or
  // wrong production set) cannot pass silently.
  it("the production set excludes src/test and the definition module", () => {
    const files = productionFiles();
    expect(files).not.toContain(LEGACY_REL);
    expect(files.every((f) => f.split(/[\\/]/)[0] !== "test")).toBe(true);
    expect(files.length).toBeGreaterThan(0); // a scanning regression cannot pass silently
  });

  // GROUND: PRD N10 — mutation-proof the detectors themselves: every banned
  // acquisition form is flagged and every legal adjacent form is ignored.
  describe("standing matching table (fixtures run through the same detectors)", () => {
    const run = (source: string) => violationsIn("fixture.ts", stripComments(source));
    it("flags a plain named import", () => {
      expect(run(`import { enqueueNotification } from "../services/notificationCommandService.js";`)).toHaveLength(1);
    });
    it("flags an aliased import (as)", () => {
      expect(run(`import { enqueueNotificationForRecipients as send } from "./notificationCommandService.js";`)).toHaveLength(1);
    });
    it("flags a string-named binding", () => {
      expect(run(`import { "getResolvedRecipients" as resolve } from "./notificationCommandService.js";`)).toHaveLength(1);
    });
    it("flags a re-export", () => {
      expect(run(`export { enqueueNotification } from "../services/notificationCommandService.js";`)).toHaveLength(1);
    });
    it("flags a namespace import", () => {
      expect(run(`import * as legacy from "../services/notificationCommandService.js";`)).toHaveLength(1);
    });
    it("flags a wildcard re-export (and a wildcard-namespace re-export)", () => {
      expect(run(`export * from "../services/notificationCommandService.js";`)).toHaveLength(1);
      expect(run(`export * as legacy from "../services/notificationCommandService.js";`)).toHaveLength(1);
    });
    it("flags escaped module specifiers (raw literal cooks to the legacy path)", () => {
      expect(run(`import { enqueueNotification } from "../services/notificatio\\u006eCommandService.js";`)).toHaveLength(1);
      expect(run(`const m = await import("./notification\\x43ommandService.js");`)).toHaveLength(1);
    });
    it("flags dynamic import() and require()", () => {
      expect(run(`const m = await import("../services/notificationCommandService.js");`)).toHaveLength(1);
      expect(run(`const m = require("../services/notificationCommandService.js");`)).toHaveLength(1);
    });
    it("flags a direct call with no visible import (tripwire)", () => {
      expect(run(`declare const f: any; f(enqueueNotificationForRecipients(a));`)).toHaveLength(1);
    });
    it("allows a type-only import of the legacy command/result types", () => {
      expect(run(`import type { EnqueueNotificationCommand } from "../services/notificationCommandService.js";`)).toEqual([]);
    });
    it("ignores wrapper mentions inside comments", () => {
      expect(run(`// enqueueNotification( is retired; use enqueueNotificationWithIntents\nexport const x = 1;`)).toEqual([]);
    });
    it("ignores unrelated imports from other modules whose names merely contain a wrapper substring", () => {
      expect(run(`import { enqueueNotificationWithIntents } from "../services/notificationIntentCommand.js";`)).toEqual([]);
    });
  });
});
