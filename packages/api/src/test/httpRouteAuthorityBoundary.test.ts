/**
 * HTTP route authority boundary (ADR-0049) — structural escape guard.
 *
 * The staged assembly in `httpApp.ts` is the single owner of the production
 * HTTP surface. This test enforces that ownership at the source level, so a
 * route registered outside the authority fails review by construction:
 *
 *   A. only `httpApp.ts` may import the fastify package as a value — bare
 *      specifier or any `fastify/*` subpath (Fastify 5 ships no `exports`
 *      map, so `fastify/fastify` resolves the factory), across static
 *      imports, dynamic `import()`, and `require()` (the constructor is the
 *      registration capability — without it no other production module can
 *      construct an instance at all);
 *   B. only the sanctioned authority modules may even hold a Fastify instance
 *      type (`FastifyInstance`/plugin-callback types); services, repositories,
 *      middleware, and the executable have no business naming one;
 *   C. the executable (`index.ts`) must not mention `fastify` in any form —
 *      it holds the narrow runtime handle and nothing else;
 *   D. route-registration calls (`.get(`/`.post(`/`.register(`/… on
 *      conventional Fastify receiver names) outside the approved registration
 *      modules are flagged — a tripwire for an instance smuggled as `any`
 *      past check B; and
 *   E. `createHttpApplication` has exactly one production caller: the
 *      executable. A second assembly site would fork the authority.
 *
 * Honest scope: the type-stripped TS7 toolchain exposes no JS compiler API,
 * so this is a structured source scan (string/comment-aware), not a typed
 * AST walk. Check A matches every module specifier that resolves into the
 * fastify package (bare and subpath, static/dynamic/require, quoted or
 * backtick-literal — pinned by the standing matching table below); its known
 * residual is any NON-literal specifier — a variable `import(mod)` or an
 * interpolated template head (`import(`${base}/fastify`)`) — which needs
 * dataflow an AST would not catch either. Checks
 * B and C are exact at this precision; check D is a named tripwire. The
 * allowlists below ARE the sanctioned boundary — a new legitimate holder
 * must extend them deliberately, in review-visible diffs.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_ROOT = join(import.meta.dirname, "..");
const EXECUTABLE = join("index.ts");
const ASSEMBLY_MODULE = join("httpApp.ts");

/** Modules sanctioned to hold a Fastify instance (or plugin-callback) type. */
const INSTANCE_TYPE_MODULES: readonly string[] = [
  ASSEMBLY_MODULE,
  join("authPolicy.ts"),
  join("errors", "plugin.ts"),
  join("plugins", "pluginHttpRoutes.ts"),
];

/** Fastify receiver names whose route-verb calls are registration. */
const FASTIFY_RECEIVERS = "(?:fastify|f|app|instance|server|httpApp|application)";
const ROUTE_VERBS = "(?:register|get|post|put|patch|delete|head|options|all|route)";

function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTypeScriptFiles(full));
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Production source files: everything under src/ except src/test/**. */
function productionFiles(): string[] {
  return listTypeScriptFiles(SRC_ROOT)
    .map((file) => relative(SRC_ROOT, file))
    .filter((rel) => rel.split(/[\\/]/)[0] !== "test");
}

/**
 * Replaces comments with spaces so docblocks mentioning Fastify APIs cannot
 * false-positive. String/template contents are preserved (a URL containing
 * `//` must not eat the rest of the line); comments inside template
 * interpolations are not tracked — none exist in this codebase's src/.
 */
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

/**
 * Every `import`/`export … from "fastify…"` clause in the file (bare or any
 * `fastify/*` subpath — Fastify 5 ships no `exports` map, so subpaths resolve
 * package files directly), as raw clause text (between the keyword and
 * `from`). Multi-line imports included.
 */
function fastifyImportClauses(stripped: string): string[] {
  const clauses: string[] = [];
  const re = /(?:import|export)\s+([^;]*?)\s*from\s*(['"])fastify(?:\/[^'"]*)?\2/gs;
  for (const match of stripped.matchAll(re)) {
    clauses.push(match[1]);
  }
  return clauses;
}

/** True when the clause imports at least one binding usable as a value. */
function importsValueBinding(clause: string): boolean {
  const trimmed = clause.trim();
  if (trimmed.startsWith("type ")) return false; // `import type …`
  const braces = trimmed.match(/\{([^}]*)\}/s);
  if (!braces) return true; // default import / `* as ns` — a value
  return braces[1]
    .split(",")
    .map((binding) => binding.trim())
    .filter((binding) => binding.length > 0)
    .some((binding) => !/^type\s/.test(binding));
}

/**
 * Check A's full predicate: true when the (comment-stripped) source obtains
 * the Fastify constructor as a VALUE — a static import/export clause from
 * `fastify` or any `fastify/*` subpath binding at least one value, or a
 * dynamic `import()`/`require()` resolving into the package. Exported for the
 * standing matching table so the scan and the table share one truth.
 */
export function fastifyConstructionImportIn(stripped: string): boolean {
  // Quote class includes backticks: a template-literal specifier (no
  // interpolation) is a plain string to the module loader — `await
  // import(`fastify`)` must be caught like its quoted forms. Interpolated
  // heads (`import(`${base}/fastify`)`) are part of the named residual, not
  // solved here.
  const dynamic =
    new RegExp(`(?:require|import)\\s*\\(\\s*(['"\`])fastify(?:/[^'"\`]*)?\\1`);
  return fastifyImportClauses(stripped).some(importsValueBinding) || dynamic.test(stripped);
}

/** Check B's predicate: the source names a Fastify instance/plugin-callback type. */
export function holdsFastifyInstanceType(stripped: string): boolean {
  return /\bFastify(?:Instance|PluginAsync|PluginCallback)\b/.test(stripped);
}

/** Check D's predicate: a conventional-receiver route-registration call (tripwire). */
export function hasTripwireRegistration(stripped: string): boolean {
  return new RegExp(`\\b${FASTIFY_RECEIVERS}\\s*\\.\\s*${ROUTE_VERBS}\\s*\\(`).test(stripped);
}

/** Check E's predicate: the source calls `createHttpApplication`. */
export function mentionsCreateHttpApplication(stripped: string): boolean {
  return /\bcreateHttpApplication\s*\(/.test(stripped);
}

describe("HTTP route authority boundary (ADR-0049)", () => {
  it("only the assembly module imports fastify as a value (the constructor capability)", () => {
    const offenders: string[] = [];
    for (const rel of productionFiles()) {
      const stripped = stripComments(readFileSync(join(SRC_ROOT, rel), "utf-8"));
      if (fastifyConstructionImportIn(stripped) && rel !== ASSEMBLY_MODULE) offenders.push(rel);
    }
    expect(
      offenders,
      `value imports of fastify outside the authoritative assembly: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("only sanctioned authority modules hold a Fastify instance type", () => {
    const offenders: string[] = [];
    for (const rel of productionFiles()) {
      if (INSTANCE_TYPE_MODULES.includes(rel)) continue;
      if (rel.split(/[\\/]/)[0] === "routes") continue; // approved route modules
      const stripped = stripComments(readFileSync(join(SRC_ROOT, rel), "utf-8"));
      if (holdsFastifyInstanceType(stripped)) offenders.push(rel);
    }
    expect(
      offenders,
      `Fastify instance types held outside the sanctioned authority modules: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("the executable never mentions fastify — it holds only the narrow runtime handle", () => {
    const stripped = stripComments(readFileSync(join(SRC_ROOT, EXECUTABLE), "utf-8"));
    expect(stripped, "src/index.ts must not mention fastify in any form").not.toMatch(/fastify/i);
  });

  it("no route-registration calls outside the approved registration modules (tripwire)", () => {
    const offenders: string[] = [];
    for (const rel of productionFiles()) {
      if (rel === ASSEMBLY_MODULE) continue;
      if (rel.split(/[\\/]/)[0] === "routes") continue;
      if (rel === join("plugins", "pluginHttpRoutes.ts")) continue;
      const stripped = stripComments(readFileSync(join(SRC_ROOT, rel), "utf-8"));
      if (hasTripwireRegistration(stripped)) offenders.push(rel);
    }
    expect(
      offenders,
      `route-registration calls outside the authoritative assembly and route modules: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("createHttpApplication has exactly one production caller: the executable", () => {
    const callers: string[] = [];
    for (const rel of productionFiles()) {
      if (rel === ASSEMBLY_MODULE) continue; // the definition site
      const stripped = stripComments(readFileSync(join(SRC_ROOT, rel), "utf-8"));
      if (mentionsCreateHttpApplication(stripped)) callers.push(rel);
    }
    expect(callers, `createHttpApplication production callers: ${callers.join(", ")}`).toEqual([
      EXECUTABLE,
    ]);
  });
});

describe("HTTP route authority boundary — standing matching table (review F1)", () => {
  const strip = (source: string) => stripComments(source);

  it("flags every value import that resolves into the fastify package — bare and subpath", () => {
    const valueImports = [
      `import Fastify from "fastify";`,
      `import Fastify from "fastify/fastify";`,
      `import { fastify as makeApp } from "fastify/fastify";`,
      `const F = await import("fastify");`,
      `const F = await import("fastify/fastify");`,
      `const F = require("fastify");`,
      `const F = require("fastify/fastify");`,
      // Template-literal specifiers (no interpolation) are plain strings to
      // the module loader — same capability, same flag.
      'const F = await import(`fastify`);',
      'const F = await import(`fastify/fastify`);',
    ];
    for (const snippet of valueImports) {
      expect(fastifyConstructionImportIn(strip(snippet)), snippet).toBe(true);
    }
  });

  it("allows type-only imports and near-miss package specifiers", () => {
    const allowed = [
      `import type { FastifyInstance } from "fastify";`,
      `import { type FastifyInstance, type FastifyRequest } from "fastify";`,
      `import { type FastifyInstance } from "fastify/fastify";`,
      `import cors from "@fastify/cors";`,
      `import helmet from "@fastify/helmet";`,
      `import rawBody from "fastify-raw-body";`,
      `import { ZodTypeProvider } from "fastify-type-provider-zod";`,
      'const C = await import(`@fastify/cors`);',
    ];
    for (const snippet of allowed) {
      expect(fastifyConstructionImportIn(strip(snippet)), snippet).toBe(false);
    }
  });

  it("a realistic subpath bypass fails check A alone — no other check masks it", () => {
    // The exact escape shape review F1 documented: an inferred factory import
    // (no Fastify* type named, so B is silent) and a receiver outside the D
    // tripwire's conventional names, in a non-executable module (C is scoped
    // to index.ts) with no assembly call (E silent). A is the only check
    // that can fire — and it must.
    const bypass = strip(`import { fastify as srvFactory } from "fastify/fastify";
const router = srvFactory({ logger: false });
router.get("/rogue", async () => "x");
export const rogueRouter = router;`);
    expect(fastifyConstructionImportIn(bypass), "check A fires").toBe(true);
    expect(holdsFastifyInstanceType(bypass), "check B stays silent").toBe(false);
    expect(hasTripwireRegistration(bypass), "check D stays silent").toBe(false);
    expect(mentionsCreateHttpApplication(bypass), "check E stays silent").toBe(false);
  });
});
