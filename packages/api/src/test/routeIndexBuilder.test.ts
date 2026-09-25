import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { buildRouteIndex } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../../scripts/generate-route-index.mjs")).href
);

const route = (
  method: string,
  path: string,
  surface = "api-v1",
  authKind = "human",
  generatedTwin = false,
) => ({ method, path, surface, authKind, generatedTwin, source: "core" });

describe("API-only route index builder", () => {
  it("is permutation-stable and preserves separate methods while pairing only true twins", () => {
    const routes = ["GET", "POST", "DELETE"].flatMap((method) => [
      route(method, "/api/v1/chat/speaker-mappings"),
      route(method, "/api/chat/speaker-mappings", "api-deprecated"),
    ]);
    const first = buildRouteIndex(routes);
    expect(buildRouteIndex(routes.toReversed())).toBe(first);
    expect(first.match(/chat\/speaker-mappings/g)).toHaveLength(3);
    expect(first).toContain("3 across 1 families");
  });

  it("keeps the independent shared API apart from paired manual invites", () => {
    const index = buildRouteIndex([
      route("POST", "/api/shared/participants", "api-shared", "remote_participant"),
      route("POST", "/api/v1/shared/invites/accept", "api-v1", "manual_invite"),
      route("POST", "/api/shared/invites/accept", "api-deprecated", "manual_invite"),
    ]);
    expect(index).toContain(
      "`/api/shared/participants` | `remote_participant` | Remote Participant API",
    );
    expect(index).toContain(
      "`/shared/invites/accept` | `manual_invite` | current + deprecated twin",
    );
    expect(index).toContain("2 across 2 families");
    const collision = buildRouteIndex([
      route("GET", "/api/v1/api/shared/foo"),
      route("GET", "/api/shared/foo", "api-shared", "remote_participant"),
    ]);
    expect(collision.match(/`\/api\/shared\/foo`/g)).toHaveLength(2);
    expect(collision.indexOf("`human`")).toBeLessThan(collision.indexOf("`remote_participant`"));
    expect(
      buildRouteIndex([
        route("GET", "/api/shared/foo", "api-shared", "remote_participant"),
        route("GET", "/api/v1/api/shared/foo"),
      ]),
    ).toBe(collision);
  });

  it("rejects conflicting policies, bad surfaces, and malformed records", () => {
    expect(() =>
      buildRouteIndex([
        route("GET", "/api/v1/foo"),
        route("GET", "/api/foo", "api-deprecated", "agent"),
      ]),
    ).toThrow("Conflicting auth policy");
    expect(() => buildRouteIndex([route("GET", "/api/shared/foo", "api-deprecated")])).toThrow(
      "Path/surface mismatch",
    );
    expect(() => buildRouteIndex([route("BREW", "/api/v1/foo")])).toThrow("Malformed route");
    expect(() => buildRouteIndex([])).toThrow("nonempty routes");
    expect(() => buildRouteIndex([route("GET", "/api/v1/foo?query=1")])).toThrow(
      "Malformed route path",
    );
    expect(() =>
      buildRouteIndex([route("GET", "/api/v1/foo"), route("GET", "/api/v1/foo")]),
    ).toThrow("Duplicate route");
  });

  it("omits generated HEAD only with GET and retains explicit HEAD and OPTIONS", () => {
    const index = buildRouteIndex([
      route("GET", "/api/v1/foo"),
      route("HEAD", "/api/v1/foo", "api-v1", "human", true),
      route("HEAD", "/api/v1/bar"),
      route("OPTIONS", "/api/v1/bar"),
    ]);
    expect(index).not.toContain("| HEAD | `/foo`");
    expect(index).toContain("| HEAD | `/bar`");
    expect(index).toContain("| OPTIONS | `/bar`");
    expect(() => buildRouteIndex([route("HEAD", "/api/v1/foo", "api-v1", "human", true)])).toThrow(
      "without GET",
    );
    expect(() =>
      buildRouteIndex([
        route("GET", "/api/v1/foo"),
        route("HEAD", "/api/v1/foo", "api-v1", "agent", true),
      ]),
    ).toThrow("policy mismatch");
  });

  it("rejects unrepresentable route paths instead of emitting unsafe markdown", () => {
    expect(() => buildRouteIndex([route("GET", "/api/v1/foo|bar")])).toThrow(
      "Malformed route path",
    );
  });
});
