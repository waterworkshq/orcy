import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as wikiPageRepo from "../repositories/wikiPage.js";
import * as wikiPageVersionRepo from "../repositories/wikiPageVersion.js";
import * as wikiCoverageRepo from "../repositories/wikiCoverage.js";
import * as wikiService from "../services/wikiService.js";
import {
  habitats,
  columns,
  missions,
  tasks,
  wikiPages,
  wikiPageVersions,
  wikiPageLinks,
  wikiCoverageMarkers,
} from "../db/schema/index.js";

function setupHabitat() {
  const habitat = habitatRepo.createHabitat({ name: "Wiki Service Habitat" });
  const col = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0 });
  return { habitat, col };
}

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(wikiPageLinks).run();
  db.delete(wikiCoverageMarkers).run();
  db.delete(wikiPageVersions).run();
  db.delete(wikiPages).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columns).run();
  db.delete(habitats).run();
});

afterEach(() => {
  closeDb();
});

describe("wikiService.slugifyTitle", () => {
  it("lowercases and hyphenates", () => {
    expect(wikiService.slugifyTitle("Hello World")).toBe("hello-world");
  });

  it("truncates very long titles to 64 chars", () => {
    const long = "a".repeat(200);
    expect(wikiService.slugifyTitle(long).length).toBe(64);
  });

  it("returns 'untitled' for empty/whitespace input", () => {
    expect(wikiService.slugifyTitle("")).toBe("untitled");
    expect(wikiService.slugifyTitle("!!!")).toBe("untitled");
  });
});

describe("wikiService.createPage", () => {
  it("inserts a page + initial version-1 atomically and returns the page", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(
      habitat.id,
      { title: "Hello World", content: "first body" },
      "human-1",
    );

    expect(page.slug).toBe("hello-world");
    expect(page.status).toBe("draft");
    expect(page.currentVersionNumber).toBe(1);
    expect(page.createdBy).toBe("human-1");
    expect(page.lastUpdatedBy).toBe("human-1");

    const versions = wikiPageVersionRepo.listByPage(page.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].versionNumber).toBe(1);
    expect(versions[0].title).toBe("Hello World");
    expect(versions[0].content).toBe("first body");
    expect(versions[0].editSummary).toBe("initial");
  });

  it("appends -2 on slug collision within the same sibling set", () => {
    const { habitat } = setupHabitat();
    const a = wikiService.createPage(habitat.id, { title: "Same", content: "a" }, "human-1");
    const b = wikiService.createPage(habitat.id, { title: "Same", content: "b" }, "human-1");
    expect(a.slug).toBe("same");
    expect(b.slug).toBe("same-2");
  });

  it("does not collide when titles slugify the same under different parents", () => {
    const { habitat } = setupHabitat();
    const root = wikiService.createPage(habitat.id, { title: "Root", content: "" }, "human-1");
    const child = wikiService.createPage(
      habitat.id,
      { title: "Same", content: "", parentId: root.id },
      "human-1",
    );
    expect(child.slug).toBe("same");
  });

  it("accepts tags at creation", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(
      habitat.id,
      { title: "Tagged", content: "", tags: ["alpha", "beta"] },
      "human-1",
    );
    expect(page.tags).toEqual(["alpha", "beta"]);
  });
});

describe("wikiService.getPage", () => {
  it("returns the page with resolved (dangling-tagged) links", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(habitat.id, { title: "P", content: "" }, "human-1");
    wikiPageRepo.create({
      habitatId: habitat.id,
      slug: "other",
      title: "Other",
      content: "",
      createdBy: "human-1",
      lastUpdatedBy: "human-1",
    });

    const fetched = wikiService.getPage(page.id);
    expect(fetched.id).toBe(page.id);
    expect(fetched.links).toEqual([]);
  });

  it("throws 404 when the page is missing", () => {
    expect(() => wikiService.getPage("nonexistent")).toThrow(/not found/i);
  });
});

describe("wikiService.listPages", () => {
  it("delegates to the repo with the provided filters", () => {
    const { habitat } = setupHabitat();
    wikiService.createPage(habitat.id, { title: "A", content: "" }, "human-1");
    const b = wikiService.createPage(habitat.id, { title: "B", content: "" }, "human-1");
    const list = wikiService.listPages(habitat.id, { parentId: null });
    expect(list.map((p) => p.id).sort()).toEqual([b.id, list[0].id].sort());
    expect(list.every((p) => p.parentId === null)).toBe(true);
  });
});

describe("wikiService.deletePage", () => {
  it("plain delete removes the page and its page-type coverage markers", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(habitat.id, { title: "Doomed", content: "" }, "human-1");
    wikiCoverageRepo.create({
      habitatId: habitat.id,
      coverageFrom: "2025-01-01T00:00:00.000Z",
      coverageTo: "2025-01-08T00:00:00.000Z",
      markerType: "page",
      pageId: page.id,
      createdBy: "human-1",
    });

    wikiService.deletePage(page.id, {}, "human-1");

    expect(wikiPageRepo.getById(page.id)).toBeNull();
    expect(wikiCoverageRepo.getByPage(page.id)).toHaveLength(0);
  });

  it("delete with stayGone=true inserts no_update_needed markers covering the page's window", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(habitat.id, { title: "Stay Gone", content: "" }, "human-1");
    wikiCoverageRepo.create({
      habitatId: habitat.id,
      coverageFrom: "2025-01-01T00:00:00.000Z",
      coverageTo: "2025-01-08T00:00:00.000Z",
      markerType: "page",
      pageId: page.id,
      createdBy: "human-1",
    });
    wikiCoverageRepo.create({
      habitatId: habitat.id,
      coverageFrom: "2025-01-08T00:00:00.000Z",
      coverageTo: "2025-01-15T00:00:00.000Z",
      markerType: "page",
      pageId: page.id,
      createdBy: "human-1",
    });

    wikiService.deletePage(page.id, { stayGone: true, reason: "duplicate" }, "human-1");

    expect(wikiPageRepo.getById(page.id)).toBeNull();
    const db = getDb();
    const noUpdate = db
      .select()
      .from(wikiCoverageMarkers)
      .where(eqMark(wikiCoverageMarkers.markerType, "no_update_needed"))
      .all();
    expect(noUpdate).toHaveLength(2);
    expect(noUpdate.every((m) => m.pageId === null)).toBe(true);
    expect(noUpdate.every((m) => m.reason === "duplicate")).toBe(true);
    const toSet = new Set(noUpdate.map((m) => m.coverageTo));
    expect(toSet.has("2025-01-08T00:00:00.000Z")).toBe(true);
    expect(toSet.has("2025-01-15T00:00:00.000Z")).toBe(true);
  });

  it("delete with stayGone=true rolls back no_update markers when page delete would fail (transactional)", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(
      habitat.id,
      { title: "Tx Rollback", content: "" },
      "human-1",
    );
    wikiCoverageRepo.create({
      habitatId: habitat.id,
      coverageFrom: "2025-01-01T00:00:00.000Z",
      coverageTo: "2025-01-08T00:00:00.000Z",
      markerType: "page",
      pageId: page.id,
      createdBy: "human-1",
    });
    // Create a child so the page delete will hit FK ON DELETE NO ACTION
    wikiService.createPage(
      habitat.id,
      { title: "Child", content: "", parentId: page.id },
      "human-1",
    );

    expect(() =>
      wikiService.deletePage(page.id, { stayGone: true, reason: "x" }, "human-1"),
    ).toThrow(/children/i);

    // Page should still exist, no no_update markers should have been inserted.
    expect(wikiPageRepo.getById(page.id)).not.toBeNull();
    const db = getDb();
    const noUpdate = db
      .select()
      .from(wikiCoverageMarkers)
      .where(eqMark(wikiCoverageMarkers.markerType, "no_update_needed"))
      .all();
    expect(noUpdate).toHaveLength(0);
  });

  it("refuses to delete a page that has children (409 conflict)", () => {
    const { habitat } = setupHabitat();
    const parent = wikiService.createPage(habitat.id, { title: "Parent", content: "" }, "human-1");
    wikiService.createPage(
      habitat.id,
      { title: "Child", content: "", parentId: parent.id },
      "human-1",
    );

    expect(() => wikiService.deletePage(parent.id, {}, "human-1")).toThrow(/children/i);
    expect(wikiPageRepo.getById(parent.id)).not.toBeNull();
  });

  it("allows deleting a parent after the child is removed", () => {
    const { habitat } = setupHabitat();
    const parent = wikiService.createPage(habitat.id, { title: "Parent", content: "" }, "human-1");
    const child = wikiService.createPage(
      habitat.id,
      { title: "Child", content: "", parentId: parent.id },
      "human-1",
    );
    wikiService.deletePage(child.id, {}, "human-1");
    expect(() => wikiService.deletePage(parent.id, {}, "human-1")).not.toThrow();
    expect(wikiPageRepo.getById(parent.id)).toBeNull();
  });

  it("throws 404 for a missing page", () => {
    expect(() => wikiService.deletePage("nonexistent", {}, "human-1")).toThrow(/not found/i);
  });
});

describe("wikiService.updatePageMetadata", () => {
  it("draft → published inserts a page-type coverage marker; unpublish removes it", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(habitat.id, { title: "P", content: "" }, "human-1");
    expect(wikiCoverageRepo.getByPage(page.id)).toHaveLength(0);

    const published = wikiService.updatePageMetadata(page.id, { status: "published" }, "human-1");
    expect(published.status).toBe("published");
    const markers = wikiCoverageRepo.getByPage(page.id);
    expect(markers).toHaveLength(1);
    expect(markers[0].markerType).toBe("page");
    expect(markers[0].habitatId).toBe(habitat.id);
    expect(markers[0].createdBy).toBe("human-1");

    const unpublished = wikiService.updatePageMetadata(page.id, { status: "draft" }, "human-1");
    expect(unpublished.status).toBe("draft");
    expect(wikiCoverageRepo.getByPage(page.id)).toHaveLength(0);
  });

  it("publishing again (published → published) does not create an extra marker", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(
      habitat.id,
      { title: "P", content: "", status: "published" },
      "human-1",
    );
    expect(wikiCoverageRepo.getByPage(page.id)).toHaveLength(1);

    wikiService.updatePageMetadata(page.id, { status: "published" }, "human-1");
    expect(wikiCoverageRepo.getByPage(page.id)).toHaveLength(1);
  });

  it("updates tags and lastUpdatedBy without touching title or content", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(habitat.id, { title: "P", content: "body" }, "human-1");
    const before = wikiPageRepo.getById(page.id)!;

    const updated = wikiService.updatePageMetadata(page.id, { tags: ["alpha", "beta"] }, "agent-2");
    expect(updated.tags).toEqual(["alpha", "beta"]);
    expect(updated.lastUpdatedBy).toBe("agent-2");
    expect(updated.title).toBe(before.title);
    expect(updated.content).toBe(before.content);
  });

  it("throws 409 when moving a page under a parent that already has a sibling with the same slug", () => {
    const { habitat } = setupHabitat();
    const parentA = wikiService.createPage(
      habitat.id,
      { title: "Parent A", content: "" },
      "human-1",
    );
    const parentB = wikiService.createPage(
      habitat.id,
      { title: "Parent B", content: "" },
      "human-1",
    );
    const moved = wikiService.createPage(
      habitat.id,
      { title: "Same", content: "", parentId: parentA.id },
      "human-1",
    );
    // Sibling under parentB with the same slug ("same").
    wikiService.createPage(
      habitat.id,
      { title: "Same", content: "", parentId: parentB.id },
      "human-1",
    );

    expect(() =>
      wikiService.updatePageMetadata(moved.id, { parentId: parentB.id }, "human-1"),
    ).toThrow(/sibling.*slug/i);
    // Page is unchanged
    expect(wikiPageRepo.getById(moved.id)?.parentId).toBe(parentA.id);
  });

  it("allows moving when the new parent has no slug collision", () => {
    const { habitat } = setupHabitat();
    const parentA = wikiService.createPage(
      habitat.id,
      { title: "Parent A", content: "" },
      "human-1",
    );
    const parentB = wikiService.createPage(
      habitat.id,
      { title: "Parent B", content: "" },
      "human-1",
    );
    const moved = wikiService.createPage(
      habitat.id,
      { title: "Lone", content: "", parentId: parentA.id },
      "human-1",
    );

    const updated = wikiService.updatePageMetadata(moved.id, { parentId: parentB.id }, "human-1");
    expect(updated.parentId).toBe(parentB.id);
  });

  it("throws 404 for a missing page", () => {
    expect(() => wikiService.updatePageMetadata("nonexistent", { tags: [] }, "human-1")).toThrow(
      /not found/i,
    );
  });
});

// Local helper to import a tiny alias without re-doing the import block.
import { eq as eqMark } from "drizzle-orm";
