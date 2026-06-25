import { describe, it, expect, beforeEach } from "vitest";
import { createMockWikiClient } from "../__fixtures__/mock-domains.js";
import { WIKI_DISPATCH_TOOL, WIKI_ACTIONS } from "../../tools/wiki-dispatch.js";
import * as wiki from "../../tools/wiki.js";

describe("WIKI_DISPATCH_TOOL", () => {
  it("has the correct name", () => {
    expect(WIKI_DISPATCH_TOOL.name).toBe("orcy_wiki");
  });

  it("includes all 12 actions in the enum", () => {
    const actionProp = WIKI_DISPATCH_TOOL.inputSchema.properties!.action as { enum?: string[] };
    expect(actionProp.enum).toEqual([
      "search",
      "get_page",
      "list_pages",
      "get_authoring_context",
      "create_page",
      "save_version",
      "restore_version",
      "update_metadata",
      "add_link",
      "remove_link",
      "mark_no_update_needed",
      "trigger_refresh",
    ]);
  });

  it("requires action", () => {
    expect(WIKI_DISPATCH_TOOL.inputSchema.required).toContain("action");
  });

  it("exposes habitatId, pageId, query, title, content, targetType, linkId, from, to as shared params", () => {
    const props = WIKI_DISPATCH_TOOL.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("habitatId");
    expect(props).toHaveProperty("pageId");
    expect(props).toHaveProperty("query");
    expect(props).toHaveProperty("title");
    expect(props).toHaveProperty("content");
    expect(props).toHaveProperty("targetType");
    expect(props).toHaveProperty("linkId");
    expect(props).toHaveProperty("from");
    expect(props).toHaveProperty("to");
  });
});

describe("WIKI_ACTIONS — action routing", () => {
  it("routes search to wikiSearch", () => {
    expect(WIKI_ACTIONS["search"]).toBe(wiki.wikiSearch);
  });
  it("routes get_page to wikiGetPage", () => {
    expect(WIKI_ACTIONS["get_page"]).toBe(wiki.wikiGetPage);
  });
  it("routes list_pages to wikiListPages", () => {
    expect(WIKI_ACTIONS["list_pages"]).toBe(wiki.wikiListPages);
  });
  it("routes get_authoring_context to wikiGetAuthoringContext", () => {
    expect(WIKI_ACTIONS["get_authoring_context"]).toBe(wiki.wikiGetAuthoringContext);
  });
  it("routes create_page to wikiCreatePage", () => {
    expect(WIKI_ACTIONS["create_page"]).toBe(wiki.wikiCreatePage);
  });
  it("routes save_version to wikiSaveVersion", () => {
    expect(WIKI_ACTIONS["save_version"]).toBe(wiki.wikiSaveVersion);
  });
  it("routes restore_version to wikiRestoreVersion", () => {
    expect(WIKI_ACTIONS["restore_version"]).toBe(wiki.wikiRestoreVersion);
  });
  it("routes update_metadata to wikiUpdateMetadata", () => {
    expect(WIKI_ACTIONS["update_metadata"]).toBe(wiki.wikiUpdateMetadata);
  });
  it("routes add_link to wikiAddLink", () => {
    expect(WIKI_ACTIONS["add_link"]).toBe(wiki.wikiAddLink);
  });
  it("routes remove_link to wikiRemoveLink", () => {
    expect(WIKI_ACTIONS["remove_link"]).toBe(wiki.wikiRemoveLink);
  });
  it("routes mark_no_update_needed to wikiMarkNoUpdateNeeded", () => {
    expect(WIKI_ACTIONS["mark_no_update_needed"]).toBe(wiki.wikiMarkNoUpdateNeeded);
  });
  it("routes trigger_refresh to wikiTriggerRefresh", () => {
    expect(WIKI_ACTIONS["trigger_refresh"]).toBe(wiki.wikiTriggerRefresh);
  });

  it("has exactly 12 actions", () => {
    expect(Object.keys(WIKI_ACTIONS)).toHaveLength(12);
  });

  it("every action maps to a function", () => {
    for (const handler of Object.values(WIKI_ACTIONS)) {
      expect(typeof handler).toBe("function");
    }
  });
});

describe("wiki action handlers — delegation to WikiClient", () => {
  let client: ReturnType<typeof createMockWikiClient>;

  beforeEach(() => {
    client = createMockWikiClient();
  });

  it("search → client.searchWiki with habitatId, query, and limit/offset", async () => {
    client.searchWiki.mockResolvedValue([
      { id: "p1", slug: "intro", title: "Intro", excerpt: "...", rank: 1.0 },
    ]);
    const result = await wiki.wikiSearch(client, {
      habitatId: "h-1",
      query: "alpha",
      limit: 10,
      offset: 5,
    });
    expect(client.searchWiki).toHaveBeenCalledWith("h-1", "alpha", { limit: 10, offset: 5 });
    expect(result).toEqual([
      { id: "p1", slug: "intro", title: "Intro", excerpt: "...", rank: 1.0 },
    ]);
  });

  it("search returns error when habitatId missing", async () => {
    const result = await wiki.wikiSearch(client, { query: "x" });
    expect(result).toEqual({ error: "Missing required parameter: habitatId" });
    expect(client.searchWiki).not.toHaveBeenCalled();
  });

  it("search returns error when query missing", async () => {
    const result = await wiki.wikiSearch(client, { habitatId: "h-1" });
    expect(result).toEqual({ error: "Missing required parameter: query" });
    expect(client.searchWiki).not.toHaveBeenCalled();
  });

  it("get_page → client.getWikiPage with habitatId, pageId", async () => {
    client.getWikiPage.mockResolvedValue({ id: "p1", links: [] } as never);
    await wiki.wikiGetPage(client, { habitatId: "h-1", pageId: "p-1" });
    expect(client.getWikiPage).toHaveBeenCalledWith("h-1", "p-1");
  });

  it("get_page returns error when pageId missing", async () => {
    const result = await wiki.wikiGetPage(client, { habitatId: "h-1" });
    expect(result).toEqual({ error: "Missing required parameter: pageId" });
  });

  it("list_pages → client.listWikiPages with filters", async () => {
    client.listWikiPages.mockResolvedValue([]);
    await wiki.wikiListPages(client, {
      habitatId: "h-1",
      parentId: "p-1",
      tag: "design",
      status: "draft",
    });
    expect(client.listWikiPages).toHaveBeenCalledWith("h-1", {
      parentId: "p-1",
      tag: "design",
      status: "draft",
    });
  });

  it("list_pages works with no filters", async () => {
    client.listWikiPages.mockResolvedValue([]);
    await wiki.wikiListPages(client, { habitatId: "h-1" });
    expect(client.listWikiPages).toHaveBeenCalledWith("h-1", {});
  });

  it("get_authoring_context returns stub error without calling client", async () => {
    const result = await wiki.wikiGetAuthoringContext(client, { habitatId: "h-1", pageId: "p-1" });
    expect(result).toMatchObject({ error: expect.stringMatching(/not yet implemented/i) });
    expect(client.listWikiPages).not.toHaveBeenCalled();
  });

  it("create_page → client.createWikiPage with title, content, parentId, tags", async () => {
    client.createWikiPage.mockResolvedValue({ id: "p-new" } as never);
    await wiki.wikiCreatePage(client, {
      habitatId: "h-1",
      title: "New page",
      content: "body",
      parentId: "p-1",
      tags: ["design", "draft"],
    });
    expect(client.createWikiPage).toHaveBeenCalledWith("h-1", {
      title: "New page",
      content: "body",
      parentId: "p-1",
      tags: ["design", "draft"],
    });
  });

  it("create_page returns error when title missing", async () => {
    const result = await wiki.wikiCreatePage(client, { habitatId: "h-1", content: "x" });
    expect(result).toEqual({ error: "Missing required parameter: title" });
  });

  it("create_page returns error when content missing", async () => {
    const result = await wiki.wikiCreatePage(client, { habitatId: "h-1", title: "t" });
    expect(result).toEqual({ error: "Missing required parameter: content" });
  });

  it("save_version → client.saveWikiVersion with editSummary", async () => {
    client.saveWikiVersion.mockResolvedValue({ id: "p-1" } as never);
    await wiki.wikiSaveVersion(client, {
      habitatId: "h-1",
      pageId: "p-1",
      title: "Updated",
      content: "new body",
      editSummary: "fixed typo",
    });
    expect(client.saveWikiVersion).toHaveBeenCalledWith("h-1", "p-1", {
      title: "Updated",
      content: "new body",
      editSummary: "fixed typo",
    });
  });

  it("restore_version → client.restoreWikiVersion with versionNumber coerced to number", async () => {
    client.restoreWikiVersion.mockResolvedValue({ id: "p-1" } as never);
    await wiki.wikiRestoreVersion(client, {
      habitatId: "h-1",
      pageId: "p-1",
      versionNumber: "3",
    });
    expect(client.restoreWikiVersion).toHaveBeenCalledWith("h-1", "p-1", 3);
  });

  it("restore_version returns error when versionNumber missing", async () => {
    const result = await wiki.wikiRestoreVersion(client, { habitatId: "h-1", pageId: "p-1" });
    expect(result).toEqual({ error: "Missing required parameter: versionNumber" });
  });

  it("update_metadata → client.updateWikiPageMetadata with status validation", async () => {
    client.updateWikiPageMetadata.mockResolvedValue({ id: "p-1" } as never);
    await wiki.wikiUpdateMetadata(client, {
      habitatId: "h-1",
      pageId: "p-1",
      status: "published",
    });
    expect(client.updateWikiPageMetadata).toHaveBeenCalledWith("h-1", "p-1", {
      status: "published",
    });
  });

  it("update_metadata returns error for invalid status", async () => {
    const result = await wiki.wikiUpdateMetadata(client, {
      habitatId: "h-1",
      pageId: "p-1",
      status: "bogus",
    });
    expect(result).toEqual({
      error: "Invalid status. Must be one of: draft, published",
    });
    expect(client.updateWikiPageMetadata).not.toHaveBeenCalled();
  });

  it("update_metadata returns error when no patch fields provided", async () => {
    const result = await wiki.wikiUpdateMetadata(client, { habitatId: "h-1", pageId: "p-1" });
    expect(result).toEqual({ error: "At least one of parentId, tags, status is required" });
  });

  it("add_link → client.addWikiPageLink with valid targetType", async () => {
    client.addWikiPageLink.mockResolvedValue({ id: "l-1" } as never);
    await wiki.wikiAddLink(client, {
      habitatId: "h-1",
      pageId: "p-1",
      targetType: "mission",
      targetId: "m-1",
      note: "see also",
    });
    expect(client.addWikiPageLink).toHaveBeenCalledWith("h-1", "p-1", {
      targetType: "mission",
      targetId: "m-1",
      note: "see also",
    });
  });

  it("add_link returns error for invalid targetType", async () => {
    const result = await wiki.wikiAddLink(client, {
      habitatId: "h-1",
      pageId: "p-1",
      targetType: "nonsense",
      targetId: "x",
    });
    expect(result.error).toMatch(/Invalid targetType/);
    expect(client.addWikiPageLink).not.toHaveBeenCalled();
  });

  it("add_link returns error when targetId missing", async () => {
    const result = await wiki.wikiAddLink(client, {
      habitatId: "h-1",
      pageId: "p-1",
      targetType: "mission",
    });
    expect(result).toEqual({ error: "Missing required parameter: targetId" });
  });

  it("remove_link → client.removeWikiPageLink with habitatId, pageId, linkId", async () => {
    client.removeWikiPageLink.mockResolvedValue({ deleted: true } as never);
    await wiki.wikiRemoveLink(client, { habitatId: "h-1", pageId: "p-1", linkId: "l-1" });
    expect(client.removeWikiPageLink).toHaveBeenCalledWith("h-1", "p-1", "l-1");
  });

  it("remove_link returns error when linkId missing", async () => {
    const result = await wiki.wikiRemoveLink(client, { habitatId: "h-1", pageId: "p-1" });
    expect(result).toEqual({ error: "Missing required parameter: linkId" });
  });

  it("mark_no_update_needed → client.markNoUpdateNeeded with from, to, reason", async () => {
    client.markNoUpdateNeeded.mockResolvedValue({ created: true } as never);
    await wiki.wikiMarkNoUpdateNeeded(client, {
      habitatId: "h-1",
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-08T00:00:00Z",
      reason: "no new primitives",
    });
    expect(client.markNoUpdateNeeded).toHaveBeenCalledWith("h-1", {
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-08T00:00:00Z",
      reason: "no new primitives",
    });
  });

  it("mark_no_update_needed returns error when from missing", async () => {
    const result = await wiki.wikiMarkNoUpdateNeeded(client, {
      habitatId: "h-1",
      to: "2026-01-08T00:00:00Z",
    });
    expect(result).toEqual({ error: "Missing required parameter: from" });
  });

  it("trigger_refresh returns stub error without calling client", async () => {
    const result = await wiki.wikiTriggerRefresh(client, { habitatId: "h-1" });
    expect(result).toMatchObject({ error: expect.stringMatching(/not yet implemented/i) });
  });
});
