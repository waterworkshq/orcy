/**
 * Unbounded-array guard for request schemas.
 *
 * Zod validates every element of an array before it reports, so an array
 * schema with no upper bound lets a request's shape drive validation work.
 * The central request collection cap (`middleware/requestCollectionCap.ts`)
 * bounds what reaches validation. Every unbounded array a schema declares
 * must be counted on the explicit list below — so a new unbounded array is a
 * review decision, never an accident. Schema-level upper bounds for the
 * listed arrays are not planned (#232): a bound limits one collection at a
 * time, like the cap, and the repository states no limit for those arrays
 * that a bound could encode.
 *
 * Scope: every production `.ts`/`.tsx` file under `packages/api/src` and
 * `packages/shared/src` (test directories excluded). That is a superset of
 * what any route can reach, so nothing reachable from a route escapes. An
 * upper bound is a `.max(`, `.length(`, or `.size(` in the method chain
 * directly after the `z.array(...)` call; a bound inside the element schema
 * does not count.
 *
 * Honest scope (TS7 exposes no JS compiler API — the constraint
 * `httpRouteAuthorityBoundary.test.ts` records): this is a comment-, string-,
 * and regex-literal-aware source scan, not a typed AST walk. Two fail-closed
 * checks back the lexer up. It must end every file in code state, which valid
 * source always does. And every raw array call whose line reads as a property
 * or declaration must have been classified as code. One residual stays: a
 * lexer that loses sync and re-syncs before end of file, on a line that does
 * not read as an assignment, can hide a site.
 *
 * Site identity is `<file>::<anchor>` — the property, declaration, or callee
 * the array is assigned to — with a count of such sites. No line numbers are
 * pinned: moving code never changes the list, while adding, bounding,
 * renaming, or moving an unbounded array between files does.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const SOURCE_SCOPES = ["packages/api/src", "packages/shared/src"] as const;
const TEST_DIRECTORIES = new Set(["test", "__tests__", "__mocks__"]);

/** `z.array(...)` and the method form `.array()`; never a namespace member such as `pkg.z.array(`. */
const ARRAY_CALL = /(?<![\w$.])z\s*\.\s*array\s*\(|\.\s*array\s*\(\s*\)/g;
const UPPER_BOUNDS = new Set(["max", "length", "size"]);

/**
 * Unbounded array schemas accepted on purpose. The central request collection
 * cap limits the elements in each; the request body limit bounds the payload.
 * Key `<file>::<anchor>`, value the number of such sites. To change it: bound
 * the array in its schema (`.max(n)`) when a product limit warrants it and
 * remove the entry, or add the entry deliberately in a review-visible diff.
 */
const KNOWN_UNBOUNDED_ARRAY_SITES: Readonly<Record<string, number>> = {
  "packages/api/src/models/automationConditionSchema.ts::children": 1,
  "packages/api/src/models/automationConditionSchema.ts::statuses": 1,
  "packages/api/src/models/automationRuleSchema.ts::channels": 1,
  "packages/api/src/models/automationRuleSchema.ts::recipients": 1,
  "packages/api/src/models/schemas.ts::agentStatuses": 1,
  "packages/api/src/models/schemas.ts::artifacts": 4,
  "packages/api/src/models/schemas.ts::blocks": 3,
  "packages/api/src/models/schemas.ts::capabilities": 2,
  "packages/api/src/models/schemas.ts::columns": 1,
  "packages/api/src/models/schemas.ts::comments": 1,
  "packages/api/src/models/schemas.ts::dependsOn": 5,
  "packages/api/src/models/schemas.ts::desiredOrder": 1,
  "packages/api/src/models/schemas.ts::detectedClis": 1,
  "packages/api/src/models/schemas.ts::events": 1,
  "packages/api/src/models/schemas.ts::expectedOrder": 1,
  "packages/api/src/models/schemas.ts::habitatIds": 1,
  "packages/api/src/models/schemas.ts::labels": 6,
  "packages/api/src/models/schemas.ts::missions": 1,
  "packages/api/src/models/schemas.ts::requiredCapabilities": 7,
  "packages/api/src/models/schemas.ts::retryOnStatuses": 1,
  "packages/api/src/models/schemas.ts::selectedDependencies": 1,
  "packages/api/src/models/schemas.ts::sessionProgresses": 1,
  "packages/api/src/models/schemas.ts::subtasks": 1,
  "packages/api/src/models/schemas.ts::tasks": 1,
  "packages/api/src/models/schemas.ts::templates": 1,
  "packages/api/src/models/schemas.ts::webhooks": 1,
  "packages/api/src/routes/codeEvidence/shared.ts::changedFiles": 1,
  "packages/api/src/routes/codeEvidence/shared.ts::commits": 1,
  "packages/api/src/routes/codeEvidence/shared.ts::externalUrls": 1,
  "packages/api/src/routes/codeEvidence/shared.ts::trailers": 1,
  "packages/api/src/routes/extraction.ts::sourceTypes": 2,
  "packages/api/src/routes/notifications.ts::channels": 2,
  "packages/api/src/routes/notifications.ts::deliveryIds": 1,
  "packages/api/src/routes/prioritization.ts::conditions": 2,
  "packages/api/src/routes/prioritization.ts::labels": 1,
  "packages/api/src/routes/prioritization.ts::rules": 1,
  "packages/api/src/routes/remoteAccess.ts::baselineScopes": 1,
  "packages/api/src/routes/reviewRules.ts::fixedReviewerIds": 2,
  "packages/api/src/routes/reviewRules.ts::matchLabels": 2,
  "packages/api/src/routes/roleAdmin.ts::permissionsSchema": 1,
  "packages/api/src/routes/scheduledTasks.ts::missionLabels": 2,
  "packages/api/src/routes/scheduledTasks.ts::requiredCapabilities": 2,
  "packages/api/src/routes/scheduledTasks.ts::tasksTemplate": 2,
  "packages/api/src/routes/templates.ts::labels": 3,
  "packages/api/src/routes/templates.ts::requiredCapabilities": 2,
  "packages/api/src/routes/templates.ts::tasksTemplate": 2,
  "packages/api/src/routes/wiki.ts::tags": 2,
  "packages/api/src/routes/workflow.ts::gates": 1,
  "packages/api/src/routes/workflow.ts::requiredCapabilities": 2,
  "packages/api/src/routes/workflow.ts::variables": 1,
  "packages/shared/src/types/settings.ts::githubRepositories": 1,
  "packages/shared/src/types/settings.ts::gitlabProjects": 1,
  "packages/shared/src/types/signal.ts::validateField": 1,
  "packages/shared/src/types/signal.ts::stringArraySchema": 1,
};

type LexState = "code" | "line" | "block" | "single" | "double" | "template" | "regex";

interface Lexed {
  /** Same-length copy of the source with every non-code character blanked (newlines kept). */
  code: string;
  /** True when the scan ends inside a comment or literal. */
  unterminated: boolean;
}

/** After these, a `/` can only open a regex literal, never division. */
const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "instanceof",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "yield",
  "await",
]);

/**
 * Blanks comments and the text of string, template, and regex literals.
 * Interpolation code inside template literals stays code. A `/` is division
 * after a value (identifier, number, closing bracket, or literal) and a regex
 * opener otherwise; after a closing parenthesis it is a regex only when the
 * parenthesis closed the head of `if`, `while`, `for`, or `with`.
 */
function blankNonCode(source: string): Lexed {
  const out = source.split("");
  const templateBraces: number[] = [];
  let i = 0;
  let state: LexState = "code";
  let lastSignificant = "";
  let lastSignificantAt = -1;
  let inCharacterClass = false;

  const blank = (count: number): void => {
    for (let k = 0; k < count; k += 1) {
      if (out[i + k] !== "\n") out[i + k] = " ";
    }
  };
  const closesValue = (): void => {
    state = "code";
    // A literal never precedes a regex, and neither can `"`.
    lastSignificant = '"';
  };
  const opensRegex = (): boolean => {
    if (/[\w$]/.test(lastSignificant)) {
      const keyword = /([A-Za-z_$][\w$]*)\s*$/.exec(source.slice(0, i))?.[1];
      return keyword !== undefined && REGEX_KEYWORDS.has(keyword);
    }
    // After a closing parenthesis a regex opens only when that parenthesis
    // closed the head of a control statement (`if (…) /re/`), never after a
    // call or a plain group (`f() / 2`).
    if (lastSignificant === ")") {
      let depth = 1;
      for (let j = lastSignificantAt - 1; j >= 0; j -= 1) {
        if (source[j] === ")") depth += 1;
        else if (source[j] === "(" && --depth === 0) {
          return /\b(?:if|while|for|with)\s*$/.test(source.slice(Math.max(0, j - 6), j));
        }
      }
      return false;
    }
    return !/[\d\]"]/.test(lastSignificant);
  };

  while (i < source.length) {
    const char = source[i] as string;
    const next = source[i + 1];
    switch (state) {
      case "code":
        if (char === "/" && next === "/") {
          blank(2);
          i += 2;
          state = "line";
        } else if (char === "/" && next === "*") {
          blank(2);
          i += 2;
          state = "block";
        } else if (char === "/" && opensRegex()) {
          blank(1);
          i += 1;
          state = "regex";
          inCharacterClass = false;
        } else if (char === "'" || char === '"') {
          blank(1);
          i += 1;
          state = char === "'" ? "single" : "double";
        } else if (char === "`") {
          blank(1);
          i += 1;
          state = "template";
        } else {
          if (!/\s/.test(char)) {
            lastSignificant = char;
            lastSignificantAt = i;
          }
          if (templateBraces.length > 0) {
            const depth = templateBraces.length - 1;
            if (char === "{") templateBraces[depth] += 1;
            else if (char === "}") {
              if (templateBraces[depth] === 0) {
                templateBraces.pop();
                blank(1);
                state = "template";
              } else {
                templateBraces[depth] -= 1;
              }
            }
          }
          i += 1;
        }
        break;
      case "line":
        if (char === "\n") state = "code";
        else blank(1);
        i += 1;
        break;
      case "block":
        if (char === "*" && next === "/") {
          blank(2);
          i += 2;
          state = "code";
        } else {
          blank(1);
          i += 1;
        }
        break;
      case "single":
      case "double":
        if (char === "\\") {
          blank(2);
          i += 2;
        } else {
          if ((state === "single" && char === "'") || (state === "double" && char === '"')) {
            closesValue();
          }
          blank(1);
          i += 1;
        }
        break;
      case "template":
        if (char === "\\") {
          blank(2);
          i += 2;
        } else if (char === "`") {
          blank(1);
          i += 1;
          closesValue();
        } else if (char === "$" && next === "{") {
          blank(1);
          i += 2;
          templateBraces.push(0);
          state = "code";
          lastSignificant = "{";
        } else {
          blank(1);
          i += 1;
        }
        break;
      case "regex":
        if (char === "\\") {
          blank(2);
          i += 2;
        } else if (char === "[" || char === "]") {
          inCharacterClass = char === "[";
          blank(1);
          i += 1;
        } else if (char === "/" && !inCharacterClass) {
          blank(1);
          i += 1;
          closesValue();
        } else {
          blank(1);
          i += 1;
        }
        break;
    }
  }
  return { code: out.join(""), unterminated: state !== "code" || templateBraces.length > 0 };
}

/** Index of the `)` closing the `(` at `open`; -1 when the source never closes it. */
function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** True when the method chain directly after `from` applies an upper bound. */
function chainHasUpperBound(code: string, from: number): boolean {
  let at = from;
  for (;;) {
    while (/\s/.test(code[at] ?? "")) at += 1;
    const link = /^\.([A-Za-z_$][\w$]*)\s*\(/.exec(code.slice(at));
    if (!link) return false;
    if (UPPER_BOUNDS.has(link[1])) return true;
    const close = matchingParen(code, at + link[0].length - 1);
    if (close === -1) return false;
    at = close + 1;
  }
}

/** Name of the property, declaration, or callee the token at `at` is assigned to. */
function anchorOf(code: string, at: number): string {
  const nameBefore = (index: number): string | undefined =>
    /([A-Za-z_$][\w$]*)\s*$/.exec(code.slice(Math.max(0, index - 128), index))?.[1];
  let depth = 0;
  for (let i = at - 1; i >= 0; i -= 1) {
    const char = code[i];
    if (char === ")" || char === "]" || char === "}") depth += 1;
    else if (char === "(" || char === "[" || char === "{") {
      // An opening bracket outside every bracket of the token's own call:
      // a `(` names its callee, anything else is anonymous.
      if (depth > 0) depth -= 1;
      else return char === "(" ? (nameBefore(i) ?? "(top)") : "(top)";
    } else if (depth === 0 && (char === ":" || char === "=")) {
      const name = nameBefore(i);
      if (name !== undefined) return name;
    }
  }
  return "(top)";
}

interface ArraySite {
  /** `<file>::<anchor>` — stable across line moves. */
  id: string;
  anchor: string;
  /** 1-based source line — failure messages only, never identity. */
  line: number;
  bounded: boolean;
}

interface Scan {
  sites: ArraySite[];
  /** Fail-closed findings: the scan cannot trust its own classification. */
  desync: string[];
}

function scanSource(relativePath: string, source: string): Scan {
  const { code, unterminated } = blankNonCode(source);
  const sites: ArraySite[] = [];
  const desync = unterminated ? [`${relativePath}: ends inside a comment or literal`] : [];

  for (const match of source.matchAll(ARRAY_CALL)) {
    const at = match.index;
    const line = source.slice(0, at).split("\n").length;
    if (!code.startsWith(match[0], at)) {
      // A line that reads as `name: z.array(` or `const name = z.array(` is
      // code, whatever state the lexer was in.
      const before = source.slice(source.lastIndexOf("\n", at - 1) + 1, at);
      if (/^(?:export\s+)?(?:(?:const|let|var)\s+)?[A-Za-z_$][\w$]*\s*(?::|=)\s*$/.test(before)) {
        desync.push(`${relativePath}:${line}: array call read as non-code`);
      }
      continue;
    }
    const close = matchingParen(code, at + match[0].lastIndexOf("("));
    const anchor = anchorOf(code, at);
    sites.push({
      id: `${relativePath}::${anchor}`,
      anchor,
      line,
      bounded: close !== -1 && chainHasUpperBound(code, close + 1),
    });
  }
  return { sites, desync };
}

function productionSourceFiles(): string[] {
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === "node_modules" || entry.name === "dist") return [];
      const full = join(directory, entry.name);
      return entry.isDirectory() ? walk(full) : /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  return SOURCE_SCOPES.flatMap((scope) => walk(join(REPO_ROOT, scope))).filter((file) => {
    const segments = relative(REPO_ROOT, file).split(/[\\/]/);
    return (
      !segments.slice(0, -1).some((segment) => TEST_DIRECTORIES.has(segment)) &&
      !/\.test\.tsx?$/.test(segments.at(-1) as string)
    );
  });
}

function scanProductionSource(): Scan {
  return productionSourceFiles().reduce<Scan>(
    (all, file) => {
      const scan = scanSource(relative(REPO_ROOT, file), readFileSync(file, "utf-8"));
      return { sites: [...all.sites, ...scan.sites], desync: [...all.desync, ...scan.desync] };
    },
    { sites: [], desync: [] },
  );
}

describe("unbounded-array guard for request schemas", () => {
  const howTo =
    "Bound the array in its schema (`.max(n)`) and drop the list entry, or — when " +
    "the request collection cap alone is enough — add the site to " +
    "KNOWN_UNBOUNDED_ARRAY_SITES in this test as a deliberate review decision.";

  it("every unbounded array schema in production source is counted on the explicit list", () => {
    const unbounded = scanProductionSource().sites.filter((site) => !site.bounded);
    const countOf = (id: string): number => unbounded.filter((site) => site.id === id).length;
    const actualIds = new Set(unbounded.map((site) => site.id));

    const introduced = [...actualIds]
      .filter((id) => countOf(id) !== KNOWN_UNBOUNDED_ARRAY_SITES[id])
      .sort()
      .map(
        (id) =>
          `${id} ×${countOf(id)} (list: ${KNOWN_UNBOUNDED_ARRAY_SITES[id] ?? 0}; ` +
          `first at line ${unbounded.find((site) => site.id === id)?.line})`,
      );
    const resolved = Object.keys(KNOWN_UNBOUNDED_ARRAY_SITES).filter((id) => !actualIds.has(id));

    expect(introduced, `Unbounded array schemas that are new or changed count. ${howTo}`).toEqual(
      [],
    );
    expect(resolved, `List entries that are no longer unbounded — remove them. ${howTo}`).toEqual(
      [],
    );
  });

  it("the source scan stays in sync with every file it reads", () => {
    expect(scanProductionSource().desync).toEqual([]);
  });
});

describe("unbounded-array guard — what the scan reads", () => {
  const scan = (source: string): Scan => scanSource("sample.ts", source);
  const anchors = (sites: ArraySite[], bounded: boolean): string[] =>
    sites.filter((site) => site.bounded === bounded).map((site) => site.anchor);

  const cases: [string, string, boolean][] = [
    ["a plain array", "const a = z.array(z.string());", false],
    ["an upper bound in the chain", "const a = z.array(z.string()).max(3);", true],
    ["an exact length is an upper bound", "const a = z.array(z.string()).length(3);", true],
    ["a bound after wrappers", "const a = z.array(z.string()).optional().default([]).max(3);", true],
    ["the method form", "const a = z.string().array().max(3);", true],
    ["a lower bound only", "const a = z.array(z.string()).min(1);", false],
    ["nonempty only", "const a = z.array(z.string()).nonempty();", false],
    ["the method form without a bound", "const a = z.string().array();", false],
    ["a bound inside the element schema", "const a = z.array(z.string().max(5));", false],
    [
      "a bound on a piped schema",
      "const a = z.array(z.string()).pipe(z.array(z.string()).max(3));",
      false,
    ],
    [
      "a multi-line chain",
      "const a = z\n  .array(\n    z.object({ title: z.string() }),\n  )\n  .optional()\n  .default([]);",
      false,
    ],
  ];
  it.each(cases)("%s", (_label, source, bounded) => {
    const sites = scan(source).sites;
    expect(anchors(sites, !bounded), "sites read as the opposite").not.toContain("a");
    expect(
      anchors(sites, bounded),
      `anchor "a" was not read as ${bounded ? "bounded" : "unbounded"}`,
    ).toContain("a");
  });

  it("reads prose as prose and interpolation as code", () => {
    const source = [
      "// labels: z.array(z.string()) in a comment",
      "/* const a = z.array(z.string()) */ const keep = 1;",
      'const doc = "labels: z.array(z.string())";',
      "const re = /z.array(/;",
      // A regex that opens right after the head of a control statement.
      "if (ok) /z.array(/.test(s);",
      // Division after a plain group must not open a regex and swallow it.
      "const ratio = (a + b) / 2; const kept = z.array(z.string());",
      "const text = `z.array(${z.array(z.string())})`;",
    ].join("\n");
    const { sites, desync } = scan(source);
    expect(desync).toEqual([]);
    expect(sites.map((site) => site.anchor)).toEqual(["kept", "(top)"]);
  });

  it("names a new unbounded array by file and anchor, never by line", () => {
    const first = scan("export const s = z.object({\n  tags: z.array(z.string()),\n});\n");
    expect(first.sites.map((site) => site.id)).toEqual(["sample.ts::tags"]);

    const later = scan(
      "\n\nexport const s = z.object({\n\n  tags: z.array(z.string()).max(3),\n  owners: z.array(z.string()),\n});\n",
    );
    // Same site moved down: unchanged id. The new unbounded site: a new id.
    expect(later.sites.map((site) => site.id)).toEqual(["sample.ts::tags", "sample.ts::owners"]);
    expect(anchors(later.sites, false)).toEqual(["owners"]);
  });

  it("fails closed when it cannot trust its own classification", () => {
    const unterminated = scan("const a = z.array(z.string());\n/* never closed\n");
    expect(unterminated.desync).toEqual(["sample.ts: ends inside a comment or literal"]);

    // An unterminated literal swallows the next line: the assignment-shaped
    // line must still be reported, not silently skipped.
    const swallowed = scan(
      "const s = `never closed\nconst b = z.array(z.string());\n",
    );
    expect(swallowed.sites).toEqual([]);
    expect(swallowed.desync).toEqual([
      "sample.ts: ends inside a comment or literal",
      "sample.ts:2: array call read as non-code",
    ]);
  });
});
