import { describe, it, expect, vi, beforeEach } from "vitest";
import { wikiRoutes } from "../routes/wiki.js";
import * as wikiService from "../services/wikiService.js";
import * as wikiPageVersionRepo from "../repositories/wikiPageVersion.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as signalSurfaceService from "../services/wikiSignalSurfaceService.js";
import { sseBroadcaster } from "../sse/broadcaster.js";

interface CapturedRoute {
  method: string;
  path: string;
  preHandler: any[];
  handler: any;
}

function captureRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    get: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({
        method: "GET",
        path,
        preHandler: Array.isArray(opts?.preHandler)
          ? opts.preHandler
          : opts?.preHandler
            ? [opts.preHandler]
            : [],
        handler,
      });
    }),
    post: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({
        method: "POST",
        path,
        preHandler: Array.isArray(opts?.preHandler)
          ? opts.preHandler
          : opts?.preHandler
            ? [opts.preHandler]
            : [],
        handler,
      });
    }),
    patch: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({
        method: "PATCH",
        path,
        preHandler: Array.isArray(opts?.preHandler)
          ? opts.preHandler
          : opts?.preHandler
            ? [opts.preHandler]
            : [],
        handler,
      });
    }),
    delete: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({
        method: "DELETE",
        path,
        preHandler: Array.isArray(opts?.preHandler)
          ? opts.preHandler
          : opts?.preHandler
            ? [opts.preHandler]
            : [],
        handler,
      });
    }),
    put: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({
        method: "PUT",
        path,
        preHandler: Array.isArray(opts?.preHandler)
          ? opts.preHandler
          : opts?.preHandler
            ? [opts.preHandler]
            : [],
        handler,
      });
    }),
  };
  wikiRoutes(fakeFastify);
  return routes;
}

function makeReply() {
  const reply: any = { statusCode: 200 };
  reply.status = vi.fn((code: number) => {
    reply.statusCode = code;
    return reply;
  });
  reply.code = vi.fn((code: number) => {
    reply.statusCode = code;
    return reply;
  });
  reply.send = vi.fn((data: any) => {
    reply.data = data;
    return reply;
  });
  return reply;
}

const mockHabitat = { id: "habitat-1", name: "Test" };
const mockPage = {
  id: "page-1",
  habitatId: "habitat-1",
  parentId: null,
  slug: "test-page",
  title: "Test",
  content: "Hello",
  status: "draft" as const,
  tags: [],
  currentVersionNumber: 1,
  createdBy: "agent-1",
  lastUpdatedBy: "agent-1",
  lastUpdatedAt: "2024-01-01T00:00:00Z",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};
const mockLink = {
  id: "link-1",
  pageId: "page-1",
  targetType: "pulse" as const,
  targetId: "pulse-1",
  linkNote: null,
  createdBy: "agent-1",
  createdAt: "2024-01-01T00:00:00Z",
};
const mockVersion = {
  id: "version-1",
  pageId: "page-1",
  versionNumber: 1,
  title: "Test",
  content: "Hello",
  editSummary: null,
  editedBy: "agent-1",
  createdAt: "2024-01-01T00:00:00Z",
};
const mockMarker = {
  id: "marker-1",
  habitatId: "habitat-1",
  coverageFrom: "2024-01-01T00:00:00Z",
  coverageTo: "2024-01-02T00:00:00Z",
  markerType: "no_update_needed" as const,
  pageId: null,
  reason: "covered by external doc",
  createdBy: "agent-1",
  createdAt: "2024-01-01T00:00:00Z",
};

const {
  mockListPages,
  mockCreatePage,
  mockGetPage,
  mockUpdatePageMetadata,
  mockDeletePage,
  mockSaveVersion,
  mockRestoreVersion,
  mockAddLink,
  mockRemoveLink,
  mockListLinks,
  mockSearchPages,
  mockPostNoUpdateNeeded,
} = vi.hoisted(() => ({
  mockListPages: vi.fn(),
  mockCreatePage: vi.fn(),
  mockGetPage: vi.fn(),
  mockUpdatePageMetadata: vi.fn(),
  mockDeletePage: vi.fn(),
  mockSaveVersion: vi.fn(),
  mockRestoreVersion: vi.fn(),
  mockAddLink: vi.fn(),
  mockRemoveLink: vi.fn(),
  mockListLinks: vi.fn(),
  mockSearchPages: vi.fn(),
  mockPostNoUpdateNeeded: vi.fn(),
}));

const { mockGetSignalSurfaceForAgent } = vi.hoisted(() => ({
  mockGetSignalSurfaceForAgent: vi.fn(),
}));

const { mockListByPage, mockGetByPageAndNumber } = vi.hoisted(() => ({
  mockListByPage: vi.fn(),
  mockGetByPageAndNumber: vi.fn(),
}));

const { mockGetHabitatById } = vi.hoisted(() => ({
  mockGetHabitatById: vi.fn(),
}));

const { mockPublish } = vi.hoisted(() => ({
  mockPublish: vi.fn(),
}));

vi.mock("../services/wikiService.js", () => ({
  listPages: mockListPages,
  createPage: mockCreatePage,
  getPage: mockGetPage,
  updatePageMetadata: mockUpdatePageMetadata,
  deletePage: mockDeletePage,
  saveVersion: mockSaveVersion,
  restoreVersion: mockRestoreVersion,
  addLink: mockAddLink,
  removeLink: mockRemoveLink,
  listLinks: mockListLinks,
  searchPages: mockSearchPages,
  postNoUpdateNeeded: mockPostNoUpdateNeeded,
  slugifyTitle: (t: string) => t,
}));

vi.mock("../repositories/wikiPageVersion.js", () => ({
  listByPage: mockListByPage,
  getByPageAndNumber: mockGetByPageAndNumber,
}));

vi.mock("../repositories/wikiPage.js", () => ({
  getById: (id: string) => ({ id, habitatId: "habitat-1" }),
  search: mockSearchPages,
}));

vi.mock("../repositories/habitat.js", () => ({
  getHabitatById: mockGetHabitatById,
}));

vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: mockPublish },
}));

vi.mock("../services/wikiSignalSurfaceService.js", () => ({
  getSignalSurfaceForAgent: mockGetSignalSurfaceForAgent,
}));

function resetMocks() {
  vi.clearAllMocks();
  mockGetHabitatById.mockReturnValue(mockHabitat);
  mockListPages.mockReturnValue([mockPage]);
  mockCreatePage.mockReturnValue(mockPage);
  mockGetPage.mockReturnValue({ ...mockPage, links: [] });
  mockUpdatePageMetadata.mockReturnValue({ ...mockPage, status: "published" });
  mockDeletePage.mockReturnValue(undefined);
  mockSaveVersion.mockReturnValue({ ...mockPage, currentVersionNumber: 2 });
  mockRestoreVersion.mockReturnValue({ ...mockPage, currentVersionNumber: 3 });
  mockAddLink.mockReturnValue(mockLink);
  mockRemoveLink.mockReturnValue(undefined);
  mockListLinks.mockReturnValue([{ ...mockLink, dangling: false }]);
  mockSearchPages.mockReturnValue([
    { id: "p1", slug: "test-page", title: "Test", excerpt: "...", rank: 0 },
  ]);
  mockPostNoUpdateNeeded.mockReturnValue(mockMarker);
  mockListByPage.mockReturnValue([mockVersion]);
  mockGetByPageAndNumber.mockReturnValue(mockVersion);
  mockPublish.mockReturnValue(undefined);
  mockGetSignalSurfaceForAgent.mockReturnValue({
    experiencePatterns: [],
    findings: [],
    unstructuredFindings: [],
  });
}

function findRoute(routes: CapturedRoute[], method: string, pathPattern: RegExp): CapturedRoute {
  const match = routes.find((r) => r.method === method && pathPattern.test(r.path));
  if (!match) {
    throw new Error(
      `No route found for ${method} ${pathPattern} — got: ${routes.map((r) => `${r.method} ${r.path}`).join(", ")}`,
    );
  }
  return match;
}

describe("wikiRoutes — registration", () => {
  beforeEach(resetMocks);
  const routes = captureRoutes();

  it("registers exactly 22 routes", () => {
    expect(routes).toHaveLength(22);
  });

  it.each([
    ["GET", "/habitats/:habitatId/wiki/pages"],
    ["POST", "/habitats/:habitatId/wiki/pages"],
    ["GET", "/habitats/:habitatId/wiki/pages/:pageId"],
    ["PATCH", "/habitats/:habitatId/wiki/pages/:pageId"],
    ["DELETE", "/habitats/:habitatId/wiki/pages/:pageId"],
    ["GET", "/habitats/:habitatId/wiki/pages/:pageId/versions"],
    ["GET", "/habitats/:habitatId/wiki/pages/:pageId/versions/:n"],
    ["POST", "/habitats/:habitatId/wiki/pages/:pageId/versions"],
    ["POST", "/habitats/:habitatId/wiki/pages/:pageId/versions/:n/restore"],
    ["GET", "/habitats/:habitatId/wiki/pages/:pageId/links"],
    ["POST", "/habitats/:habitatId/wiki/pages/:pageId/links"],
    ["DELETE", "/habitats/:habitatId/wiki/pages/:pageId/links/:linkId"],
    ["GET", "/habitats/:habitatId/wiki/search"],
    ["POST", "/habitats/:habitatId/wiki/coverage/no-update-needed"],
    ["GET", "/habitats/:habitatId/wiki/pages/:pageId/authoring-context"],
    ["POST", "/habitats/:habitatId/wiki/authoring-context"],
    ["GET", "/habitats/:habitatId/wiki/cadence"],
    ["PUT", "/habitats/:habitatId/wiki/cadence"],
    ["DELETE", "/habitats/:habitatId/wiki/cadence"],
    ["POST", "/habitats/:habitatId/wiki/bootstrap"],
    ["POST", "/habitats/:habitatId/wiki/refresh"],
    ["GET", "/habitats/:habitatId/wiki/signal-surface"],
  ] as const)("registers %s %s", (method, path) => {
    const r = routes.find((x) => x.method === method && x.path === path);
    expect(r, `${method} ${path} not registered`).toBeDefined();
  });

  it("every route uses agentOrHumanAuth + requireHabitatAccess preHandler", () => {
    for (const r of routes) {
      expect(r.preHandler, `${r.method} ${r.path} has no preHandler`).toHaveLength(2);
    }
  });
});

describe("wikiRoutes — pages", () => {
  beforeEach(resetMocks);
  const routes = captureRoutes();

  it("GET /habitats/:habitatId/wiki/pages returns 200 with pages list", async () => {
    const r = findRoute(routes, "GET", /^\/habitats\/:habitatId\/wiki\/pages$/);
    const reply = makeReply();
    const result = await r.handler(
      {
        params: { habitatId: "habitat-1" },
        query: {},
        body: {},
        agent: { id: "agent-1" },
        user: null,
      },
      reply,
    );
    expect(mockListPages).toHaveBeenCalledWith("habitat-1", {});
    expect(result).toEqual({ pages: [mockPage] });
  });

  it("GET /pages forwards query filters to listPages", async () => {
    const r = findRoute(routes, "GET", /^\/habitats\/:habitatId\/wiki\/pages$/);
    await r.handler(
      {
        params: { habitatId: "habitat-1" },
        query: { parentId: "p-1", tag: "arch", status: "published" },
        body: {},
        agent: { id: "agent-1" },
        user: null,
      },
      makeReply(),
    );
    expect(mockListPages).toHaveBeenCalledWith("habitat-1", {
      parentId: "p-1",
      tag: "arch",
      status: "published",
    });
  });

  it("GET /pages returns 400 on invalid query", async () => {
    const r = findRoute(routes, "GET", /^\/habitats\/:habitatId\/wiki\/pages$/);
    await expect(
      r.handler(
        {
          params: { habitatId: "habitat-1" },
          query: { status: "garbage" },
          body: {},
          agent: { id: "agent-1" },
          user: null,
        },
        makeReply(),
      ),
    ).rejects.toThrow();
  });

  it("GET /pages returns 404 when habitat missing", async () => {
    mockGetHabitatById.mockReturnValue(null);
    const r = findRoute(routes, "GET", /^\/habitats\/:habitatId\/wiki\/pages$/);
    await expect(
      r.handler(
        {
          params: { habitatId: "habitat-x" },
          query: {},
          body: {},
          agent: { id: "agent-1" },
          user: null,
        },
        makeReply(),
      ),
    ).rejects.toThrow("Habitat not found");
  });

  it("POST /pages returns 201 with created page and forwards orcy id", async () => {
    const r = findRoute(routes, "POST", /^\/habitats\/:habitatId\/wiki\/pages$/);
    const reply = makeReply();
    await r.handler(
      {
        params: { habitatId: "habitat-1" },
        body: { title: "Hello", content: "World", tags: ["intro"] },
        agent: { id: "agent-1" },
        user: null,
      },
      reply,
    );
    expect(mockCreatePage).toHaveBeenCalledWith(
      "habitat-1",
      { title: "Hello", content: "World", tags: ["intro"] },
      "agent-1",
    );
    expect(reply.statusCode).toBe(201);
    expect(reply.data).toEqual({ page: mockPage });
  });

  it("POST /pages uses user.id when no agent (human auth)", async () => {
    const r = findRoute(routes, "POST", /^\/habitats\/:habitatId\/wiki\/pages$/);
    await r.handler(
      {
        params: { habitatId: "habitat-1" },
        body: { title: "Hello", content: "World" },
        agent: undefined,
        user: { id: "human-1", username: "v", role: "editor", type: "human" },
      },
      makeReply(),
    );
    expect(mockCreatePage).toHaveBeenCalledWith(
      "habitat-1",
      { title: "Hello", content: "World" },
      "human-1",
    );
  });

  it("POST /pages returns 400 on missing title", async () => {
    const r = findRoute(routes, "POST", /^\/habitats\/:habitatId\/wiki\/pages$/);
    await expect(
      r.handler(
        {
          params: { habitatId: "habitat-1" },
          body: { content: "x" },
          agent: { id: "agent-1" },
          user: null,
        },
        makeReply(),
      ),
    ).rejects.toThrow();
  });

  it("GET /pages/:pageId returns 200 with page", async () => {
    const r = findRoute(routes, "GET", /^\/habitats\/:habitatId\/wiki\/pages\/:pageId$/);
    const result = await r.handler(
      {
        params: { habitatId: "habitat-1", pageId: "page-1" },
        query: {},
        body: {},
        agent: { id: "agent-1" },
        user: null,
      },
      makeReply(),
    );
    expect(mockGetPage).toHaveBeenCalledWith("page-1");
    expect(result).toEqual({ page: { ...mockPage, links: [] } });
  });

  it("PATCH /pages/:pageId forwards patch and editedBy", async () => {
    const r = findRoute(routes, "PATCH", /^\/habitats\/:habitatId\/wiki\/pages\/:pageId$/);
    await r.handler(
      {
        params: { habitatId: "habitat-1", pageId: "page-1" },
        body: { status: "published", tags: ["final"] },
        agent: { id: "agent-1" },
        user: null,
      },
      makeReply(),
    );
    expect(mockUpdatePageMetadata).toHaveBeenCalledWith(
      "page-1",
      { status: "published", tags: ["final"] },
      "agent-1",
    );
  });

  it("DELETE /pages/:pageId returns 200 success", async () => {
    const r = findRoute(routes, "DELETE", /^\/habitats\/:habitatId\/wiki\/pages\/:pageId$/);
    const reply = makeReply();
    await r.handler(
      {
        params: { habitatId: "habitat-1", pageId: "page-1" },
        body: { stayGone: true, reason: "obsolete" },
        agent: { id: "agent-1" },
        user: null,
      },
      reply,
    );
    expect(mockDeletePage).toHaveBeenCalledWith(
      "page-1",
      { stayGone: true, reason: "obsolete" },
      "agent-1",
    );
    expect(reply.statusCode).toBe(200);
    expect(reply.data).toEqual({ success: true });
  });
});

describe("wikiRoutes — versions", () => {
  beforeEach(resetMocks);
  const routes = captureRoutes();

  it("GET /pages/:pageId/versions returns 200 with list", async () => {
    const r = findRoute(routes, "GET", /^\/habitats\/:habitatId\/wiki\/pages\/:pageId\/versions$/);
    const result = await r.handler(
      {
        params: { habitatId: "habitat-1", pageId: "page-1" },
        query: {},
        body: {},
        agent: { id: "agent-1" },
        user: null,
      },
      makeReply(),
    );
    expect(mockListByPage).toHaveBeenCalledWith("page-1");
    expect(result).toEqual({ versions: [mockVersion] });
  });

  it("GET /pages/:pageId/versions/:n returns 200 when version found", async () => {
    const r = findRoute(
      routes,
      "GET",
      /^\/habitats\/:habitatId\/wiki\/pages\/:pageId\/versions\/:n$/,
    );
    const result = await r.handler(
      {
        params: { habitatId: "habitat-1", pageId: "page-1", n: 1 },
        query: {},
        body: {},
        agent: { id: "agent-1" },
        user: null,
      },
      makeReply(),
    );
    expect(mockGetByPageAndNumber).toHaveBeenCalledWith("page-1", 1);
    expect(result).toEqual({ version: mockVersion });
  });

  it("GET /pages/:pageId/versions/:n returns 404 when version missing", async () => {
    mockGetByPageAndNumber.mockReturnValue(null);
    const r = findRoute(
      routes,
      "GET",
      /^\/habitats\/:habitatId\/wiki\/pages\/:pageId\/versions\/:n$/,
    );
    await expect(
      r.handler(
        {
          params: { habitatId: "habitat-1", pageId: "page-1", n: 99 },
          query: {},
          body: {},
          agent: { id: "agent-1" },
          user: null,
        },
        makeReply(),
      ),
    ).rejects.toThrow("Wiki page version not found");
  });

  it("POST /pages/:pageId/versions forwards body and editedBy", async () => {
    const r = findRoute(routes, "POST", /^\/habitats\/:habitatId\/wiki\/pages\/:pageId\/versions$/);
    await r.handler(
      {
        params: { habitatId: "habitat-1", pageId: "page-1" },
        body: { title: "v2", content: "new", editSummary: "fixed typo" },
        agent: { id: "agent-1" },
        user: null,
      },
      makeReply(),
    );
    expect(mockSaveVersion).toHaveBeenCalledWith(
      "page-1",
      { title: "v2", content: "new", editSummary: "fixed typo" },
      "agent-1",
    );
  });

  it("POST /pages/:pageId/versions/:n/restore restores the named version", async () => {
    const r = findRoute(routes, "POST", /\/versions\/:n\/restore$/);
    await r.handler(
      {
        params: { habitatId: "habitat-1", pageId: "page-1", n: 1 },
        query: {},
        body: {},
        agent: { id: "agent-1" },
        user: null,
      },
      makeReply(),
    );
    expect(mockRestoreVersion).toHaveBeenCalledWith("page-1", 1, "agent-1");
  });
});

describe("wikiRoutes — links", () => {
  beforeEach(resetMocks);
  const routes = captureRoutes();

  it("GET /pages/:pageId/links returns 200 with dangling-tagged links", async () => {
    const r = findRoute(routes, "GET", /^\/habitats\/:habitatId\/wiki\/pages\/:pageId\/links$/);
    const result = await r.handler(
      {
        params: { habitatId: "habitat-1", pageId: "page-1" },
        query: {},
        body: {},
        agent: { id: "agent-1" },
        user: null,
      },
      makeReply(),
    );
    expect(mockListLinks).toHaveBeenCalledWith("page-1");
    expect(result).toEqual({ links: [{ ...mockLink, dangling: false }] });
  });

  it("POST /pages/:pageId/links returns 201 on success", async () => {
    const r = findRoute(routes, "POST", /^\/habitats\/:habitatId\/wiki\/pages\/:pageId\/links$/);
    const reply = makeReply();
    await r.handler(
      {
        params: { habitatId: "habitat-1", pageId: "page-1" },
        body: { targetType: "pulse", targetId: "pulse-1", note: "see" },
        agent: { id: "agent-1" },
        user: null,
      },
      reply,
    );
    expect(mockAddLink).toHaveBeenCalledWith(
      "page-1",
      { targetType: "pulse", targetId: "pulse-1", note: "see" },
      "agent-1",
    );
    expect(reply.statusCode).toBe(201);
  });

  it("POST /pages/:pageId/links returns 400 on invalid targetType (Zod)", async () => {
    const r = findRoute(routes, "POST", /^\/habitats\/:habitatId\/wiki\/pages\/:pageId\/links$/);
    await expect(
      r.handler(
        {
          params: { habitatId: "habitat-1", pageId: "page-1" },
          body: { targetType: "invalid_type", targetId: "x" },
          agent: { id: "agent-1" },
          user: null,
        },
        makeReply(),
      ),
    ).rejects.toThrow();
  });

  it("POST /pages/:pageId/links surfaces 409 from service on duplicate", async () => {
    const { conflict } = await import("../errors.js");
    mockAddLink.mockImplementation(() => {
      throw conflict("Link already exists.");
    });
    const r = findRoute(routes, "POST", /^\/habitats\/:habitatId\/wiki\/pages\/:pageId\/links$/);
    await expect(
      r.handler(
        {
          params: { habitatId: "habitat-1", pageId: "page-1" },
          body: { targetType: "pulse", targetId: "pulse-1" },
          agent: { id: "agent-1" },
          user: null,
        },
        makeReply(),
      ),
    ).rejects.toThrow("Link already exists.");
  });

  it("DELETE /pages/:pageId/links/:linkId returns 200 success", async () => {
    const r = findRoute(
      routes,
      "DELETE",
      /^\/habitats\/:habitatId\/wiki\/pages\/:pageId\/links\/:linkId$/,
    );
    const reply = makeReply();
    await r.handler(
      {
        params: { habitatId: "habitat-1", pageId: "page-1", linkId: "link-1" },
        query: {},
        body: {},
        agent: { id: "agent-1" },
        user: null,
      },
      reply,
    );
    expect(mockRemoveLink).toHaveBeenCalledWith("page-1", "link-1");
    expect(reply.statusCode).toBe(200);
  });
});

describe("wikiRoutes — search & coverage", () => {
  beforeEach(resetMocks);
  const routes = captureRoutes();

  it("GET /search returns 200 with results", async () => {
    const r = findRoute(routes, "GET", /^\/habitats\/:habitatId\/wiki\/search$/);
    const result = await r.handler(
      {
        params: { habitatId: "habitat-1" },
        query: { q: "alpha", limit: 5, offset: 0 },
        body: {},
        agent: { id: "agent-1" },
        user: null,
      },
      makeReply(),
    );
    expect(mockSearchPages).toHaveBeenCalledWith("habitat-1", "alpha", { limit: 5, offset: 0 });
    expect(result).toEqual({
      results: [{ id: "p1", slug: "test-page", title: "Test", excerpt: "...", rank: 0 }],
    });
  });

  it("GET /search applies default limit/offset when missing", async () => {
    const r = findRoute(routes, "GET", /^\/habitats\/:habitatId\/wiki\/search$/);
    await r.handler(
      {
        params: { habitatId: "habitat-1" },
        query: { q: "alpha" },
        body: {},
        agent: { id: "agent-1" },
        user: null,
      },
      makeReply(),
    );
    expect(mockSearchPages).toHaveBeenCalledWith("habitat-1", "alpha", { limit: 20, offset: 0 });
  });

  it("GET /search returns 400 when q is empty", async () => {
    const r = findRoute(routes, "GET", /^\/habitats\/:habitatId\/wiki\/search$/);
    await expect(
      r.handler(
        {
          params: { habitatId: "habitat-1" },
          query: { q: "" },
          body: {},
          agent: { id: "agent-1" },
          user: null,
        },
        makeReply(),
      ),
    ).rejects.toThrow();
  });

  it("GET /search returns 400 when limit > 100", async () => {
    const r = findRoute(routes, "GET", /^\/habitats\/:habitatId\/wiki\/search$/);
    await expect(
      r.handler(
        {
          params: { habitatId: "habitat-1" },
          query: { q: "x", limit: 999 },
          body: {},
          agent: { id: "agent-1" },
          user: null,
        },
        makeReply(),
      ),
    ).rejects.toThrow();
  });

  it("GET /search returns 404 when habitat missing", async () => {
    mockGetHabitatById.mockReturnValue(null);
    const r = findRoute(routes, "GET", /^\/habitats\/:habitatId\/wiki\/search$/);
    await expect(
      r.handler(
        {
          params: { habitatId: "habitat-x" },
          query: { q: "x" },
          body: {},
          agent: { id: "agent-1" },
          user: null,
        },
        makeReply(),
      ),
    ).rejects.toThrow("Habitat not found");
  });

  it("POST /coverage/no-update-needed returns 201 with marker", async () => {
    const r = findRoute(routes, "POST", /\/coverage\/no-update-needed$/);
    const reply = makeReply();
    await r.handler(
      {
        params: { habitatId: "habitat-1" },
        body: { from: "2024-01-01T00:00:00Z", to: "2024-01-02T00:00:00Z", reason: "covered" },
        agent: { id: "agent-1" },
        user: null,
      },
      reply,
    );
    expect(mockPostNoUpdateNeeded).toHaveBeenCalledWith(
      "habitat-1",
      { from: "2024-01-01T00:00:00Z", to: "2024-01-02T00:00:00Z", reason: "covered" },
      "agent-1",
    );
    expect(reply.statusCode).toBe(201);
    expect(reply.data).toEqual({ marker: mockMarker });
  });

  it("POST /coverage/no-update-needed returns 400 on missing from/to", async () => {
    const r = findRoute(routes, "POST", /\/coverage\/no-update-needed$/);
    await expect(
      r.handler(
        {
          params: { habitatId: "habitat-1" },
          body: { from: "x" },
          agent: { id: "agent-1" },
          user: null,
        },
        makeReply(),
      ),
    ).rejects.toThrow();
  });
});

describe("wikiRoutes — signal surface", () => {
  beforeEach(resetMocks);
  const routes = captureRoutes();

  it("GET /signal-surface calls getSignalSurfaceForAgent with 'both' when no signalClass supplied", async () => {
    const r = findRoute(routes, "GET", /\/signal-surface$/);
    mockGetSignalSurfaceForAgent.mockReturnValue({ experiencePatterns: [], findings: [] });
    const result = await r.handler(
      {
        params: { habitatId: "habitat-1" },
        query: {},
        body: {},
        agent: { id: "agent-1" },
        user: null,
      },
      makeReply(),
    );
    expect(mockGetSignalSurfaceForAgent).toHaveBeenCalledWith("habitat-1", { signalClass: "both" });
    expect(result).toEqual({ experiencePatterns: [], findings: [] });
  });

  it("GET /signal-surface forwards signalClass and timeWindow", async () => {
    const r = findRoute(routes, "GET", /\/signal-surface$/);
    mockGetSignalSurfaceForAgent.mockReturnValue({ experiencePatterns: [] });
    await r.handler(
      {
        params: { habitatId: "habitat-1" },
        query: { signalClass: "experience", timeWindow: "7 days" },
        body: {},
        agent: { id: "agent-1" },
        user: null,
      },
      makeReply(),
    );
    expect(mockGetSignalSurfaceForAgent).toHaveBeenCalledWith("habitat-1", {
      timeWindow: "7 days",
      signalClass: "experience",
    });
  });

  it("GET /signal-surface forwards domain filter", async () => {
    const r = findRoute(routes, "GET", /\/signal-surface$/);
    mockGetSignalSurfaceForAgent.mockReturnValue({ experiencePatterns: [], findings: [] });
    await r.handler(
      {
        params: { habitatId: "habitat-1" },
        query: { domain: "backend", signalClass: "both" },
        body: {},
        agent: { id: "agent-1" },
        user: null,
      },
      makeReply(),
    );
    expect(mockGetSignalSurfaceForAgent).toHaveBeenCalledWith("habitat-1", {
      domain: "backend",
      signalClass: "both",
    });
  });

  it("GET /signal-surface returns 400 on invalid signalClass", async () => {
    const r = findRoute(routes, "GET", /\/signal-surface$/);
    await expect(
      r.handler(
        {
          params: { habitatId: "habitat-1" },
          query: { signalClass: "garbage" },
          body: {},
          agent: { id: "agent-1" },
          user: null,
        },
        makeReply(),
      ),
    ).rejects.toThrow();
  });
});
