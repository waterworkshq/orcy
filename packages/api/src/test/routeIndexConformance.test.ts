import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "../../../..");
const routes = JSON.parse(
  readFileSync(resolve(ROOT, "packages/api/src/test/fixtures/routeBaseline/apiOnly.json"), "utf8"),
).routes as Array<{ method: string; path: string; source: string; generatedTwin: boolean }>;
const doc = readFileSync(resolve(ROOT, "docs/API.md"), "utf8");
const normalize = (path: string) =>
  path.replace(/:[A-Za-z][A-Za-z0-9_]*/g, ":param").replace(/\/$/, "") || "/";

function checkHeadings(markdown: string): string[] {
  const served = new Set(
    routes
      .filter((r) => !r.generatedTwin && r.source !== "framework")
      .map((r) => `${r.method} ${normalize(r.path)}`),
  );
  const retired = new Set(["POST /triage/findings/:param/promote"]);
  const headings = new Set<string>();
  const groups = new Set<string>();
  for (const [index, line] of markdown.split("\n").entries()) {
    if (!/^#{2,4}\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\b/.test(line)) continue;
    const match =
      /^#{2,4}\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s]*)(?:\s+—\s+[^\n]+)?\s*$/.exec(
        line,
      );
    if (!match) throw new Error(`Malformed HTTP heading at line ${index + 1}: ${line}`);
    const path = normalize(match[2].replace(/[?#].*$/, ""));
    const key = `${match[1]} ${path}`;
    if (headings.has(key)) throw new Error(`Duplicate HTTP heading: ${key}`);
    headings.add(key);
    if (retired.has(key)) {
      if (!line.includes("— RETIRED")) throw new Error(`Missing RETIRED marker: ${key}`);
      continue;
    }
    const candidates = path.startsWith("/api/")
      ? [path]
      : path === "/health" || path === "/" || path.startsWith("/sse/")
        ? [path]
        : [`/api/v1${path}`, `/api${path}`];
    if (!candidates.some((candidate) => served.has(`${match[1]} ${candidate}`)))
      throw new Error(`Unserved HTTP heading: ${key}`);
    groups.add(path.split("/").filter(Boolean)[0] ?? "platform");
  }
  if (!headings.size) throw new Error("No API.md route headings");
  for (const group of ["habitats", "missions", "tasks", "agents", "webhooks", "triage"]) {
    if (!groups.has(group)) throw new Error(`Missing route group: ${group}`);
  }
  return [...headings];
}

describe("Route documentation conformance", () => {
  it("maps API.md HTTP headings to served API-only routes", () => {
    expect(checkHeadings(doc).length).toBeGreaterThan(0);
  });

  it("rejects fake, malformed, and unmarked retired headings", () => {
    expect(() => checkHeadings(`${doc}\n### GET /not-served\n`)).toThrow("Unserved HTTP heading");
    expect(() => checkHeadings(`${doc}\n### POST /not-served — detail\n`)).toThrow(
      "Unserved HTTP heading",
    );
    expect(() => checkHeadings(`${doc}\n### GET /not-served extra\n`)).toThrow(
      "Malformed HTTP heading",
    );
    expect(() => checkHeadings(`${doc}\n### TRACE /habitats\n`)).toThrow("Malformed HTTP heading");
    expect(() =>
      checkHeadings(
        doc.replace(
          "#### POST /triage/findings/:id/promote — RETIRED",
          "#### POST /triage/findings/:id/promote",
        ),
      ),
    ).toThrow("Missing RETIRED marker");
  });

  it("matches the pure index output byte-for-byte and detects drift", async () => {
    const { buildRouteIndex } = await import(
      pathToFileURL(resolve(ROOT, "scripts/generate-route-index.mjs")).href
    );
    const expected = buildRouteIndex(routes);
    const actual = readFileSync(resolve(ROOT, "docs/API-ROUTES.md"), "utf8");
    expect(actual).toBe(expected);
    expect(`${actual}wrong`).not.toBe(expected);
    const missing = routes.filter((route) => route.path !== "/api/shared/credentials/current");
    expect(buildRouteIndex(missing)).not.toBe(actual);
  });
});
