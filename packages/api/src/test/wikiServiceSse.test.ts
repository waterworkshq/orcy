import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPublish } = vi.hoisted(() => ({
  mockPublish: vi.fn(),
}));

vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: mockPublish },
}));

vi.mock("../db/index.js", () => ({
  getDb: vi.fn(),
}));

const { mockCreate, mockGetById, mockListByPage, mockResolveDangling } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockGetById: vi.fn(),
  mockListByPage: vi.fn(),
  mockResolveDangling: vi.fn((links: unknown[]) => links),
}));

const { mockListByPageVersions, mockGetByPageAndNumber } = vi.hoisted(() => ({
  mockListByPageVersions: vi.fn(),
  mockGetByPageAndNumber: vi.fn(),
}));

const { mockCreateLink, mockRemoveLink, mockListByPageLinks } = vi.hoisted(() => ({
  mockCreateLink: vi.fn(),
  mockRemoveLink: vi.fn(),
  mockListByPageLinks: vi.fn(),
}));

const { mockCreateCoverage, mockGetWatermark, mockGetByPageCoverage, mockReplacePageMarkers } =
  vi.hoisted(() => ({
    mockCreateCoverage: vi.fn(),
    mockGetWatermark: vi.fn(),
    mockGetByPageCoverage: vi.fn(),
    mockReplacePageMarkers: vi.fn(),
  }));

vi.mock("../repositories/wikiPage.js", () => ({
  getById: mockGetById,
  listByHabitat: vi.fn(),
  getByHabitatAndSlug: vi.fn(),
  search: vi.fn(),
}));

vi.mock("../repositories/wikiPageVersion.js", () => ({
  create: mockCreate,
  listByPage: mockListByPageVersions,
  getByPageAndNumber: mockGetByPageAndNumber,
  getLatest: vi.fn(),
}));

vi.mock("../repositories/wikiPageLink.js", () => ({
  create: mockCreateLink,
  remove: mockRemoveLink,
  listByPage: mockListByPageLinks,
  resolveDangling: mockResolveDangling,
}));

vi.mock("../repositories/wikiCoverage.js", () => ({
  create: mockCreateCoverage,
  getWatermark: mockGetWatermark,
  getByPage: mockGetByPageCoverage,
  replacePageMarkersWithNoUpdate: mockReplacePageMarkers,
}));

vi.mock("../errors.js", () => ({
  notFound: (msg: string) => new Error(`NOT_FOUND: ${msg}`),
  conflict: (msg: string) => new Error(`CONFLICT: ${msg}`),
  badRequest: (msg: string) => new Error(`BAD_REQUEST: ${msg}`),
}));

vi.mock("../errors/sqlite.js", () => ({
  isSqliteError: () => false,
}));

// eslint-disable-next-line import/first, @typescript-eslint/no-require-imports
const wikiService = await import("../services/wikiService.js");

const txMock: any = {
  insert: vi.fn(() => ({ values: vi.fn(() => ({ run: vi.fn() })) })),
  update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
  delete: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })),
  select: vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(() => null) })) })),
  })),
};

function fakeDb() {
  return {
    transaction: (fn: (tx: any) => void) => fn(txMock),
    ...txMock,
  };
}

const page = {
  id: "p1",
  habitatId: "h1",
  parentId: null,
  slug: "p",
  title: "T",
  content: "C",
  status: "draft" as const,
  tags: [],
  currentVersionNumber: 1,
  createdBy: "u1",
  lastUpdatedBy: "u1",
  lastUpdatedAt: "2024-01-01T00:00:00Z",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const getDb = (await import("../db/index.js")).getDb as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetById.mockReturnValue(page);
  mockGetWatermark.mockReturnValue("2024-01-02T00:00:00Z");
  getDb.mockImplementation(fakeDb);
});

describe("wikiService SSE broadcasts", () => {
  it("createPage publishes wiki_page_created (and coverage event when published)", () => {
    const created = wikiService.createPage(
      "h1",
      { title: "T", content: "C", status: "published" },
      "u1",
    );

    expect(mockPublish).toHaveBeenCalledWith(
      "h1",
      expect.objectContaining({ type: "wiki_page_created" }),
    );
    const createdCall = (mockPublish.mock.calls as Array<[string, any]>).find(
      ([_hid, ev]) => ev.type === "wiki_page_created",
    );
    expect(createdCall).toBeDefined();
    const [, event] = createdCall!;
    expect(event.data).toMatchObject({
      pageId: "p1",
      habitatId: "h1",
      title: "T",
      status: "draft",
      parentId: null,
    });

    expect(mockPublish).toHaveBeenCalledWith(
      "h1",
      expect.objectContaining({ type: "wiki_coverage_changed" }),
    );

    expect(created.id).toBe("p1");
  });

  it("createPage does NOT publish coverage event for draft", () => {
    wikiService.createPage("h1", { title: "T", content: "C" }, "u1");
    const coverageCalls = (mockPublish.mock.calls as Array<[string, any]>).filter(
      ([_hid, ev]) => ev.type === "wiki_coverage_changed",
    );
    expect(coverageCalls).toHaveLength(0);
  });

  it("updatePageMetadata (publish) publishes wiki_page_updated + wiki_coverage_changed", () => {
    const getByIdMock = mockGetById;
    getByIdMock.mockReturnValueOnce({ ...page, status: "draft" });
    getByIdMock.mockReturnValueOnce({ ...page, status: "published" });

    wikiService.updatePageMetadata("p1", { status: "published" }, "u1");

    expect(mockPublish).toHaveBeenCalledWith(
      "h1",
      expect.objectContaining({ type: "wiki_page_updated" }),
    );
    expect(mockPublish).toHaveBeenCalledWith(
      "h1",
      expect.objectContaining({ type: "wiki_coverage_changed" }),
    );
  });

  it("updatePageMetadata (unpublish) publishes wiki_page_updated + wiki_coverage_changed", () => {
    const getByIdMock = mockGetById;
    getByIdMock.mockReturnValueOnce({ ...page, status: "published" });
    getByIdMock.mockReturnValueOnce({ ...page, status: "draft" });

    wikiService.updatePageMetadata("p1", { status: "draft" }, "u1");

    expect(mockPublish).toHaveBeenCalledWith(
      "h1",
      expect.objectContaining({ type: "wiki_page_updated" }),
    );
    expect(mockPublish).toHaveBeenCalledWith(
      "h1",
      expect.objectContaining({ type: "wiki_coverage_changed" }),
    );
  });

  it("updatePageMetadata without status change does NOT publish any event", () => {
    wikiService.updatePageMetadata("p1", { tags: ["a"] }, "u1");
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("deletePage publishes wiki_page_deleted always", () => {
    wikiService.deletePage("p1", {}, "u1");
    expect(mockPublish).toHaveBeenCalledWith(
      "h1",
      expect.objectContaining({ type: "wiki_page_deleted" }),
    );
  });

  it("deletePage with stayGone publishes wiki_page_deleted + wiki_coverage_changed", () => {
    mockGetByPageCoverage.mockReturnValue([
      {
        id: "m1",
        habitatId: "h1",
        coverageFrom: "2024-01-01T00:00:00Z",
        coverageTo: "2024-01-02T00:00:00Z",
        markerType: "page",
        pageId: "p1",
        reason: null,
        createdBy: "u1",
        createdAt: "2024-01-01T00:00:00Z",
      },
    ]);
    wikiService.deletePage("p1", { stayGone: true, reason: "obsolete" }, "u1");
    expect(mockPublish).toHaveBeenCalledWith(
      "h1",
      expect.objectContaining({ type: "wiki_page_deleted" }),
    );
    expect(mockPublish).toHaveBeenCalledWith(
      "h1",
      expect.objectContaining({ type: "wiki_coverage_changed" }),
    );
  });

  it("saveVersion publishes wiki_page_updated", () => {
    const getByIdMock = mockGetById;
    getByIdMock.mockReturnValueOnce({ ...page, currentVersionNumber: 1, status: "published" });
    getByIdMock.mockReturnValueOnce({ ...page, currentVersionNumber: 2, status: "published" });

    wikiService.saveVersion("p1", { title: "T2", content: "C2" }, "u1");

    expect(mockPublish).toHaveBeenCalledWith(
      "h1",
      expect.objectContaining({ type: "wiki_page_updated" }),
    );
  });

  it("postNoUpdateNeeded publishes wiki_coverage_changed with no_update_needed markerType", () => {
    mockCreateCoverage.mockReturnValue({
      id: "m1",
      habitatId: "h1",
      coverageFrom: "2024-01-01T00:00:00Z",
      coverageTo: "2024-01-02T00:00:00Z",
      markerType: "no_update_needed",
      pageId: null,
      reason: "covered",
      createdBy: "u1",
      createdAt: "2024-01-01T00:00:00Z",
    });

    wikiService.postNoUpdateNeeded(
      "h1",
      { from: "2024-01-01T00:00:00Z", to: "2024-01-02T00:00:00Z", reason: "covered" },
      "u1",
    );

    expect(mockPublish).toHaveBeenCalledWith(
      "h1",
      expect.objectContaining({ type: "wiki_coverage_changed" }),
    );
    const coverageCall = (mockPublish.mock.calls as Array<[string, any]>).find(
      ([_hid, ev]) => ev.type === "wiki_coverage_changed",
    );
    expect(coverageCall).toBeDefined();
    const [, event] = coverageCall!;
    expect(event.data).toMatchObject({
      habitatId: "h1",
      watermark: "2024-01-02T00:00:00Z",
      markerType: "no_update_needed",
    });
  });
});
