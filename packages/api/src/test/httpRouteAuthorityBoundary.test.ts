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
 *      executable. A second assembly site would fork the authority; and
 *   F. no production module may acquire Node's `createRequire` capability —
 *      a per-module CommonJS `require()` loader — from a literal
 *      `node:module`/`module` specifier in any import/export-from, dynamic
 *      `import()`, or `require()` form (epic-review P1: a created loader's
 *      `load("fastify")` constructs an instance none of A–E can see, so the
 *      capability itself is denied). No production module needs it, so the
 *      reviewed allowlist is empty by default.
 *
 * Honest scope: the type-stripped TS7 toolchain exposes no JS compiler API,
 * so this is a structured source scan (string/comment-aware), not a typed
 * AST walk. Check A matches every module specifier whose COOKED value
 * resolves into the fastify package (bare and subpath,
 * static/dynamic/require, quoted or backtick-literal — pinned by the
 * standing matching table below): escape spellings (`"fastify"`,
 * `"fa\<LF>stify"`) cook to the package name and are caught like their plain
 * forms. Comments are stripped string-aware, but matching is NOT
 * token-context-aware: import-/loader-shaped text inside ordinary strings
 * or regex literals (prose, generated source) may fail closed as a FALSE
 * POSITIVE — deliberately retained over grammar emulation, which adversarial
 * review proved needs parser-level token context; the false-positive class
 * itself is fail-closed. Known FALSE-NEGATIVE residuals: any NON-literal
 * specifier — a variable `import(mod)` or an interpolated template head
 * (`import(`${base}/fastify`)`) — which needs dataflow an AST would not
 * catch either; and the comment-stripper's template-interpolation blindness
 * (see `stripComments`), which can erase a real literal acquisition. Check F
 * holds the same
 * literal-specifier precision on the loader side: a non-literal
 * `node:module` specifier, or a `createRequire` binding re-exported
 * indirectly through another module, is the same dataflow residual — the
 * guard denies acquisition at every literal specifier form rather than
 * tracking loader aliases. Literal means COOKED value — for check F's
 * `node:module`/`module` specifiers and, since the RA-4 fixup, for check A's
 * fastify specifiers alike: escape spellings (`"module"`, `"\x6dodule"`,
 * `"fastify"`) and the ES2022 string-named binding form
 * (`import { "createRequire" as cr }`) are literals and are rejected
 * (fixup 01); the clause captures in checks A and F are tempered on the
 * import/export keywords so a semicolon-less preceding statement cannot be
 * swallowed into an acquiring clause. Fixup 02 makes the scan
 * escape-aware end to end: line continuations cook to nothing (`"mod\
 * ule"` is the literal `module`), and quoted module-export names are
 * opaque units — a `,`/`}`/the words import/export inside one (including
 * the `}` of a `\u{…}` escape) are string content, never a delimiter or
 * statement boundary. Shared A/F residuals (documented, not fixed): an
 * ESCAPED module keyword (`\u0069mport { createRequire } from
 * "node:module"`) is not recognized — the scan anchors on the literal
 * keywords, and closing that spelling needs keyword-escape normalization
 * a structured regex does not attempt (fixup 03, R3-4); TOKEN-CONTEXT
 * false positives — neither check knows whether an acquiring clause sits
 * in code or inside ordinary string/regex text, so such text fails closed
 * for A and F alike (the safe direction; revisit only if a legitimate
 * production string/regex ever trips it); and the comment-stripper's
 * TEMPLATE-INTERPOLATION blindness — comments inside `${…}` are not lexed
 * by the prepass, so comment content carrying a backtick or comment-looking
 * tokens can desynchronize it and blank later executable code, a false
 * NEGATIVE shared by everything that reads the prepass (see
 * `stripComments`). Checks
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

/**
 * Production modules reviewed to need Node's `createRequire` capability.
 * EMPTY by design: no production API module needs a CommonJS loader — the
 * assembly imports fastify through normal ESM — and a module holding
 * `createRequire` can construct Fastify outside the authority. A genuine
 * future need extends this list deliberately, in a review-visible diff.
 */
const CREATE_REQUIRE_ALLOWLIST: readonly string[] = [];

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
 * `//` must not eat the rest of the line).
 *
 * FALSE-NEGATIVE residual (pre-existing, accepted): comments inside template
 * `${…}` interpolations are NOT lexed — the whole template is opaque text to
 * this pass. Comment content carrying a backtick or comment-looking tokens
 * desynchronizes it: a backtick inside an interpolation comment reads as the
 * template terminator, and `//`-shaped text in that comment then re-enters
 * code mode as a fresh line comment, blanking later executable source. The
 * final acceptance review's counterexample — a valid literal require placed
 * after such a comment inside an interpolation — scans clean, hidden from
 * every check that reads this prepass. Closing this needs template-lexical
 * context in the prepass — the same parser-level grammar emulation the
 * execution deviation rejected. Accepted with that deviation; revisit if
 * production code ever introduces comments inside template interpolations
 * (none exist in src/ today).
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
 * `from`). Multi-line imports included. The specifier is captured as an
 * arbitrary string literal and compared by its COOKED value, so escaped
 * spellings (`"fa\u0073tify"`, `"fa\<LF>stify"`) are caught like their plain
 * forms — the same literal handling check F already reviewed, through the
 * shared `cookStringLiteral` (no second cooker). Quote class is `'`/`"` only,
 * matching the recorded grammar reasoning: `from` clauses require string
 * literals syntactically, so a backtick specifier cannot occur there.
 * Matching is NOT token-context-aware: import-shaped text inside an
 * ordinary string or regex literal fails closed as a false positive (the
 * shared token-context residual — see the file header). False negatives
 * are the header's named residuals: non-literal specifiers, and the
 * comment-stripper's template-interpolation blindness.
 */
function fastifyImportClauses(stripped: string): string[] {
  const clauses: string[] = [];
  // The clause capture is tempered on the import/export keywords (a real
  // clause can never contain them — reserved), so a semicolon-less preceding
  // import/export statement cannot be swallowed into this clause (fixup 01,
  // finding 3). Quoted module-export names are consumed as opaque units
  // FIRST, so the words import/export inside them — `import { "import" as
  // imp }` — are string content, not a statement boundary (fixup 02, N3).
  const re =
    /(?:import|export)\s+((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?!;|\b(?:import|export)\b)[^;"'])*?)\s*from\s*(['"])((?:\\.|[^\\])*?)\2/gs;
  for (const match of stripped.matchAll(re)) {
    if (namesFastifyPackage(cookStringLiteral(match[3]))) clauses.push(match[1]);
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
  // import(`fastify`)` must be caught like its quoted forms. The specifier is
  // captured as an arbitrary literal body with dot-all behavior (line
  // continuations survive the capture) and compared by its COOKED value —
  // the same loaderForm handling check F already reviewed. Matching is NOT
  // token-context-aware: loader-shaped text inside an ordinary string or
  // regex literal fails closed as a false positive (the shared token-context
  // residual — see the file header). False negatives are the header's named
  // residuals: non-literal/interpolated specifiers, and the
  // comment-stripper's template-interpolation blindness.
  const loaderForm = /(?:require|import)\s*\(\s*(['"`])((?:\\.|[^\\])*?)\1/gs;
  for (const match of stripped.matchAll(loaderForm)) {
    if (namesFastifyPackage(cookStringLiteral(match[2]))) return true;
  }
  return fastifyImportClauses(stripped).some(importsValueBinding);
}

/**
 * Computes the cooked value of a string-literal body (the raw text between
 * the delimiters, backslashes intact). Standard escape forms are decoded by
 * hand — `\uXXXX`, `\u{…}`, `\xXX`, the single-char escapes, and identity for
 * anything else — so `"module"` cooks to `module`. This is the safe
 * literal-cooking mechanism for a structured scan: no eval/Function, no
 * parser dependency (fixup 01, review finding 2). Malformed escapes are kept
 * raw — a file carrying one does not compile, so precision there is moot.
 */
function cookStringLiteral(body: string): string {
  let out = "";
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c !== "\\") {
      out += c;
      i += 1;
      continue;
    }
    const e = body[i + 1];
    if (e === undefined) {
      out += c; // trailing backslash — keep raw
      break;
    }
    // Line continuations cook to NOTHING (LF, CR, CRLF as one unit, U+2028,
    // U+2029) — `"mod\<LF>ule"` cooks to `module` (fixup 02, review N2).
    if (e === "\n" || e === "\u2028" || e === "\u2029") {
      i += 2;
      continue;
    }
    if (e === "\r") {
      i += body[i + 2] === "\n" ? 3 : 2;
      continue;
    }
    switch (e) {
      case "n":
      case "t":
      case "r":
      case "b":
      case "f":
      case "v":
      case "0":
        out += { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" }[e];
        i += 2;
        break;
      case "u": {
        let codePoint = NaN;
        let next = i + 6; // `\uXXXX`
        if (body[i + 2] === "{") {
          const end = body.indexOf("}", i + 3);
          if (end !== -1) {
            codePoint = Number.parseInt(body.slice(i + 3, end), 16);
            next = end + 1;
          }
        } else {
          codePoint = Number.parseInt(body.slice(i + 2, i + 6), 16);
        }
        if (Number.isNaN(codePoint) || codePoint > 0x10ffff) {
          out += e + body.slice(i + 2, next); // malformed — keep raw
        } else {
          out += String.fromCodePoint(codePoint);
        }
        i = next;
        break;
      }
      case "x": {
        const codePoint = Number.parseInt(body.slice(i + 2, i + 4), 16);
        if (Number.isNaN(codePoint)) {
          out += e + body.slice(i + 2, i + 4); // malformed — keep raw
        } else {
          out += String.fromCharCode(codePoint);
        }
        i += 4;
        break;
      }
      default:
        out += e; // `\\`, `\'`, `\"`, and any other escaped char → itself
        i += 2;
    }
  }
  return out;
}

/** True when a cooked module specifier names Node's module builtin. */
function namesNodeModule(cookedSpecifier: string): boolean {
  return cookedSpecifier === "node:module" || cookedSpecifier === "module";
}

/**
 * True when a cooked module specifier resolves into the fastify package: the
 * bare package, or any `fastify/` subpath (Fastify 5 ships no `exports` map,
 * so subpaths resolve package files directly). The prefix test is
 * segment-precise on purpose — `fastify-raw-body` and `@fastify/cors` are
 * different packages and must stay allowed.
 */
function namesFastifyPackage(cookedSpecifier: string): boolean {
  return cookedSpecifier === "fastify" || cookedSpecifier.startsWith("fastify/");
}

/**
 * Every `import`/`export … from "node:module"` (or bare `"module"`) clause in
 * the file, as raw clause text (between the keyword and `from`). The
 * specifier is captured as an arbitrary string literal and compared by its
 * COOKED value, so escaped spellings (`"module"`, `"\x6dodule"`) are
 * rejected like their plain forms (fixup 01, finding 2). The clause capture
 * is tempered on the import/export keywords so a semicolon-less preceding
 * statement cannot be swallowed into the acquiring clause (finding 3). Quote
 * class is `'`/`"` only, matching the fastify static matcher's recorded
 * reasoning: `from` clauses require string literals syntactically, so a
 * backtick specifier cannot occur there.
 */
function nodeModuleImportClauses(stripped: string): string[] {
  const clauses: string[] = [];
  // Clause capture tempered on the import/export keywords (fixup 01,
  // finding 3) with quoted names as opaque units so a quoted "import"/
  // "export" export-name is not mistaken for a statement boundary (fixup
  // 02, N3).
  const re =
    /(?:import|export)\s+((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?!;|\b(?:import|export)\b)[^;"'])*?)\s*from\s*(['"])((?:\\.|[^\\])*?)\2/gs;
  for (const match of stripped.matchAll(re)) {
    if (namesNodeModule(cookStringLiteral(match[3]))) clauses.push(match[1]);
  }
  return clauses;
}

/**
 * True when the clause binds the `createRequire` capability (or the whole
 * namespace/default that reaches it): a `createRequire` binding under any
 * alias, a namespace (`*`/`* as ns`) — `createRequire` is a member — or the
 * default import (`node:module` is CommonJS, so the default IS `module.exports`).
 * A named binding of only non-capability exports (e.g. `isBuiltin`) does not
 * acquire the loader.
 */
function clauseAcquiresCreateRequire(clause: string): boolean {
  const trimmed = clause.trim();
  if (trimmed.startsWith("type ")) return false; // `import type …` — erased
  if (/^\*(\s+as\b)?/.test(trimmed)) return true; // `* as ns` / bare `export *`
  const bindings = splitNamedBindings(trimmed);
  if (bindings === null) return true; // default import — the CJS exports object
  // A default binding before the named list acquires too: `import d, { x }`
  // binds module.exports (createRequire reachable as `d.createRequire`),
  // even when every named binding is a bystander (fixup 03, R3-1).
  if (trimmed.slice(0, trimmed.indexOf("{")).trim() !== "") return true;
  return bindings.some(bindingGrantsCreateRequire);
}

/**
 * Quote-aware named-binding list for a clause's `{…}` span (fixup 02, review
 * N1): walks the span tracking string quotes and escape pairs, so a `}` or
 * `,` inside a quoted module-export name — including the `}` of a
 * `\u{…}` code-point escape — is string content, never a delimiter. Returns
 * null when the clause has no closed braces span (default-import form).
 */
function splitNamedBindings(clause: string): string[] | null {
  const start = clause.indexOf("{");
  if (start === -1) return null;
  let quote: string | null = null;
  let closed = false;
  const bindings: string[] = [];
  let current = "";
  for (let i = start + 1; i < clause.length; i += 1) {
    const c = clause[i];
    if (c === "\\") {
      // an escape never ends the enclosing quote and never terminates the
      // span; a `\u{…}` code-point escape is consumed as ONE unit — inside
      // or outside quotes — so its closing brace cannot terminate the list
      // (fixup 03, R3-2)
      if (clause[i + 1] === "u" && clause[i + 2] === "{") {
        const end = clause.indexOf("}", i + 3);
        const stop = end === -1 ? clause.length : end + 1;
        current += clause.slice(i, stop);
        i = stop - 1; // the loop's i += 1 lands past the escape
        continue;
      }
      current += c + (clause[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (quote !== null) {
      if (c === quote) quote = null;
      current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === "}") {
      closed = true;
      break;
    }
    if (c === ",") {
      bindings.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (!closed) return null;
  bindings.push(current);
  return bindings.map((binding) => binding.trim()).filter((binding) => binding.length > 0);
}

/**
 * True when one import/export binding names the capability: a bare
 * `createRequire`/`default` (under any alias), or the ES2022
 * module-export-name string form — `import { "createRequire" as cr }` —
 * whose name is a quoted literal compared by cooked value (fixup 01,
 * review finding 1). Type-erased bindings never grant anything.
 */
function bindingGrantsCreateRequire(binding: string): boolean {
  if (/^type\s/.test(binding)) return false;
  // Identifier names may be Unicode-escaped — `createRequire`,
  // `\u{63}reateRequire` are valid IdentifierName spellings and classic
  // minifier output — so cook the whole token before the bare-name test
  // (fixup 03, R3-2). Plain tokens cook to themselves.
  if (/^(?:createRequire|default)\b/.test(cookStringLiteral(binding))) return true;
  // `s`: a line continuation inside a quoted name (`"create\<LF>Require"`)
  // must not cut the quoted capture short — the cooker then removes it
  // (fixup 03, R3-3, mirroring loaderForm's N2 fix).
  const quoted = binding.match(/^(['"])((?:\\.|[^\\])*?)\1/s);
  if (!quoted) return false;
  const cooked = cookStringLiteral(quoted[2]);
  return cooked === "createRequire" || cooked === "default";
}

/**
 * Check F's full predicate: true when the (comment-stripped) source acquires
 * Node's `createRequire` loader capability from a literal `node:module`/`module`
 * specifier — a static import/export-from clause binding the capability, or any
 * dynamic `import()`/`require()` of the specifier (both hand over the whole
 * namespace). Exported for the standing matching table so the scan and the
 * table share one truth. Residual: non-literal specifiers and bindings
 * re-exported indirectly through other modules (no dataflow tracking).
 */
export function createRequireCapabilityIn(stripped: string): boolean {
  // Dynamic quote class includes backticks (check A's F6 reasoning): a
  // template-literal specifier without interpolation is a plain string to
  // the module loader — same capability, same flag. Specifiers are compared
  // by COOKED value, so escaped spellings (`"\x6dodule"`) are rejected like
  // their plain forms (fixup 01, finding 2); interpolated template heads
  // stay the documented non-literal residual.
  const loaderForm = /(?:require|import)\s*\(\s*(['"`])((?:\\.|[^\\])*?)\1/gs;
  for (const match of stripped.matchAll(loaderForm)) {
    if (namesNodeModule(cookStringLiteral(match[2]))) return true;
  }
  return nodeModuleImportClauses(stripped).some(clauseAcquiresCreateRequire);
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

  it("no production module acquires Node's createRequire capability (empty reviewed allowlist)", () => {
    const offenders: string[] = [];
    for (const rel of productionFiles()) {
      if (CREATE_REQUIRE_ALLOWLIST.includes(rel)) continue;
      const stripped = stripComments(readFileSync(join(SRC_ROOT, rel), "utf-8"));
      if (createRequireCapabilityIn(stripped)) offenders.push(rel);
    }
    expect(
      offenders,
      `createRequire capability acquired outside the reviewed (empty-by-default) allowlist: ${offenders.join(", ")}`,
    ).toEqual([]);
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
      // A quoted reserved-word export name must not read as a statement
      // boundary and hide the value binding beside it (fixup 02, N3).
      `import { "import" as imp, fastify as f } from "fastify";`,
    ];
    for (const snippet of valueImports) {
      expect(fastifyConstructionImportIn(strip(snippet)), snippet).toBe(true);
    }
  });

  describe("cooked-literal fastify discriminators — family × spelling (all red under raw)", () => {
    // Every case spells the package HEAD in escapes or continuations, so its
    // RAW text is invisible to the old raw comparison — restoring that
    // matcher (mutation record) fails each named case individually. One
    // named test per family × spelling so a missing family or spelling is
    // structurally visible, not hidden behind the first failing assertion.
    const HEAD_SPELLINGS = [
      { name: "Unicode-escape head", specifier: "f\\u0061stify" },
      { name: "hex-escape head", specifier: "fa\\x73tify" },
      { name: "LF-continuation head", specifier: 'fa\\' + "\n" + 'stify' },
      { name: "CRLF-continuation head", specifier: 'fa\\' + "\r\n" + 'stify' },
      { name: "head-escaped subpath", specifier: "fa\\u0073tify/\\u0066astify" },
    ] as const;
    const FAMILIES = [
      { name: "static import", wrap: (specifier: string) => `import Fastify from "${specifier}";` },
      {
        name: "dynamic import()",
        wrap: (specifier: string) => `const F = await import("${specifier}");`,
      },
      { name: "require()", wrap: (specifier: string) => `const F = require("${specifier}");` },
    ] as const;
    for (const family of FAMILIES) {
      for (const spelling of HEAD_SPELLINGS) {
        const source = family.wrap(spelling.specifier);
        it(`${family.name} catches the ${spelling.name}`, () => {
          expect(fastifyConstructionImportIn(strip(source)), source).toBe(true);
        });
      }
    }

    it("preservation: literal raw `fastify/` heads with escaped subpaths stay matched", () => {
      // These three were ALREADY caught by the raw comparison — escapes
      // confined to the subpath behind a literal `fastify/` head. They are
      // deliberately NOT in the red matrix above; cooking must not regress
      // them.
      const preserved = [
        `import Fastify from "fastify/\\u0066astify";`,
        `const F = await import("fastify/\\u0066astify");`,
        `const F = require("fastify/\\u0066astify");`,
      ];
      for (const snippet of preserved) {
        expect(fastifyConstructionImportIn(strip(snippet)), snippet).toBe(true);
      }
    });
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
      // Cooked-literal controls: the predicate must stay segment-precise on
      // cooked values — escapes that cook to scoped packages or hyphenated
      // look-alikes are NOT the fastify package, and a type-only import from
      // a cooked fastify specifier binds no value.
      `import { type FastifyInstance } from "f\\u0061stify";`,
      `import cors from "@\\u0066astify/cors";`,
      `import rawBody from "fa\\u0073tify-raw-body";`,
      `import tools from "fastify\\u002dtools";`,
      'const D = await import(`@\\u0066astify/cors`);',
      // Interpolated template heads remain the documented non-literal
      // residual (shared with check F): there is no cooked value to compare.
      `const F = await import(\`\${base}/fastify\`);`,
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

    // The cooked-literal twin of the same bypass: the specifier spelled in
    // Unicode escapes (cooked value `fastify/fastify`) changes nothing about
    // the capability, and still only check A can see the shape — B/D/E
    // silence is what keeps the discriminator load-bearing.
    const cookedBypass = strip(`import { fastify as srvFactory } from "fa\\u0073tify/fastify";
const router = srvFactory({ logger: false });
router.get("/rogue", async () => "x");
export const rogueRouter = router;`);
    expect(fastifyConstructionImportIn(cookedBypass), "check A fires on the cooked spelling").toBe(true);
    expect(holdsFastifyInstanceType(cookedBypass), "check B stays silent (cooked)").toBe(false);
    expect(hasTripwireRegistration(cookedBypass), "check D stays silent (cooked)").toBe(false);
    expect(mentionsCreateHttpApplication(cookedBypass), "check E stays silent (cooked)").toBe(false);
  });

  it("flags every createRequire capability acquisition from literal node:module/module", () => {
    const acquisitions = [
      `import { createRequire } from "node:module";`,
      `import { createRequire } from "module";`,
      `import { createRequire as cr } from "node:module";`,
      `import * as mod from "node:module";
mod.createRequire(import.meta.url);`,
      `import nodeModule from "node:module";`,
      `import { default as nodeModule } from "node:module";`,
      `export { createRequire } from "node:module";`,
      `export * from "module";`,
      `export * as nodeModule from "node:module";`,
      `const { createRequire } = await import("node:module");`,
      `const mod = await import("node:module");`,
      `const mod2 = await import("module");`,
      `const { createRequire } = require("node:module");`,
      `const mod3 = require("module");`,
      'const mod4 = await import(`node:module`);',
      // ES2022 module-export-name string bindings (fixup 01, finding 1).
      `import { "createRequire" as cr } from "node:module";`,
      `import { 'default' as d } from "node:module";`,
      `export { "createRequire" as cr } from "node:module";`,
      // Escaped literal specifiers — cooked value is module/node:module
      // (fixup 01, finding 2; \\u and \\x spellings across all three forms).
      `import { createRequire } from "node:\\u006dodule";`,
      `import { createRequire } from "\\u006dodule";`,
      `import { createRequire } from "node:\\x6dodule";`,
      `const { createRequire } = require("modu\\x6ce");`,
      `const mod5 = await import("\\u006eode:module");`,
      'const mod6 = await import(`\\u006dodule`);',
      // A semicolon-less preceding import must not swallow the acquiring
      // clause (fixup 01, finding 3).
      `import { left } from "left-pad"
import { createRequire } from "node:module"`,
      // Quoted Unicode code-point escapes in binding names — the `}` of
      // `\u{…}` must not terminate the binding list (fixup 02, N1).
      `import { "\\u{63}reateRequire" as cr } from "node:module";`,
      `export { "\\u{63}reateRequire" as cr } from "node:module";`,
      `import { "\\u{64}efault" as d } from "node:module";`,
      // Line continuations inside literal specifiers cook to NOTHING
      // (fixup 02, N2) — LF, CR, CRLF-as-one-unit, U+2028, U+2029 across
      // static, dynamic, and require forms (composed via interpolation so
      // the snippet carries the real control characters).
      `import { createRequire } from "mod\\${"\n"}ule";`,
      `const { createRequire } = require("mod\\${"\r"}ule");`,
      `const mod7 = await import("node:\\${"\r\n"}module");`,
      `const mod8 = await import("mod\\${"\u2028"}ule");`,
      `import { createRequire } from "mod\\${"\u2029"}ule";`,
      // Quoted reserved-word export names must not read as statement
      // boundaries (fixup 02, N3).
      `import { "import" as imp, "createRequire" as cr } from "node:module";`,
      `export { "export" as ex, "createRequire" as cr } from "node:module";`,
      // Mixed default+named: the default binding acquires module.exports
      // even when every named binding is a bystander (fixup 03, R3-1);
      // default+namespace stays flagged.
      `import nodeModule, { isBuiltin } from "node:module";`,
      `import d, { "isBuiltin" as ib } from "node:module";`,
      `import mod, * as ns from "node:module";`,
      // Unicode-escaped identifier names — valid IdentifierName spellings,
      // classic minifier output (fixup 03, R3-2): \\uXXXX, \\u{…}, escaped
      // `default`, alias-only escape control, and the export-from variant.
      `import { \\u0063reateRequire as cr } from "node:module";`,
      `import { \\u{63}reateRequire as cr } from "node:module";`,
      `import { \\u0064efault as d } from "node:module";`,
      `import { createRequire as \\u0063r } from "node:module";`,
      `export { \\u0063reateRequire as cr } from "node:module";`,
      // Line continuation inside a QUOTED binding name (fixup 03, R3-3).
      `import { "create\\${"\n"}Require" as cr } from "node:module";`,
    ];
    for (const snippet of acquisitions) {
      expect(createRequireCapabilityIn(strip(snippet)), snippet).toBe(true);
    }
  });

  it("allows non-capability node:module bindings, near-miss specifiers, and prose", () => {
    const allowed = [
      `import { isBuiltin } from "node:module";`,
      `import type { createRequire } from "node:module";`,
      `import { type createRequire } from "node:module";`,
      `import { something } from "my-module";`,
      `import { other } from "node:modules";`,
      // String-named and escaped NEAR-MISS forms stay precise: the cooked
      // names are not the capability / not the builtin's specifier.
      `import { "isBuiltin" as ib } from "node:module";`,
      `import { createRequire } from "\\u006dodules";`,
      // No binding, no capability: side-effect-only and empty braces.
      `import "node:module";`,
      `import {} from "node:module";`,
      // Fixup-02 near-misses: quoted escaped names and continuations that
      // cook to something other than the capability/specifier, plus a
      // quoted reserved-word name with no capability alongside.
      `import { "\\u{63}sNotTheCapability" as x } from "node:module";`,
      `import { createRequire } from "mod\\${"\n"}ulers";`,
      `import { "import" as imp, isBuiltin } from "node:module";`,
      `import { \\u0069sBuiltin as ib } from "node:module";`,
      `const util = require("module-utils");`,
      `import fs from "node:fs";`,
      // Mere prose — comments are stripped before matching, so a comment
      // describing the banned pattern cannot flag (same promise as A–E).
      `// load fastify via createRequire(import.meta.url) from "node:module"`,
    ];
    for (const snippet of allowed) {
      expect(createRequireCapabilityIn(strip(snippet)), snippet).toBe(false);
    }
  });

  it("the epic review's realistic createRequire construction fails check F alone — no other check masks it", () => {
    // Review P1's exact shape: Node's CommonJS bridge gives any ESM module a
    // require() loader; load("fastify") has no fastify import clause (A
    // silent), no Fastify* type (B silent), receiver `router` is not a
    // conventional tripwire name (D silent), no assembly call (E silent), and
    // the module is not the executable (C is scoped to index.ts). F is the
    // only check that can fire — and it must.
    const bypass = strip(`import { createRequire } from "node:module";
const load = createRequire(import.meta.url);
const make = load("fastify");
const router = make({ logger: false });
router.get("/rogue", async () => "x");`);
    expect(createRequireCapabilityIn(bypass), "check F fires").toBe(true);
    expect(fastifyConstructionImportIn(bypass), "check A stays silent").toBe(false);
    expect(holdsFastifyInstanceType(bypass), "check B stays silent").toBe(false);
    expect(hasTripwireRegistration(bypass), "check D stays silent").toBe(false);
    expect(mentionsCreateHttpApplication(bypass), "check E stays silent").toBe(false);
  });

  it("a semicolon-less preceding type-only import cannot hide a fastify value import from check A", () => {
    // The check-A half of fixup finding 3 (same clause-capture family as
    // check F): without the keyword-tempered capture, the lazy clause
    // swallows the second statement and the leftmost — type-only — braces
    // hide the real value import below it.
    const swallow = strip(`import { type Left } from "left-pad"
import Fastify from "fastify";`);
    expect(
      fastifyConstructionImportIn(swallow),
      "check A fires on the second statement",
    ).toBe(true);
  });
});
