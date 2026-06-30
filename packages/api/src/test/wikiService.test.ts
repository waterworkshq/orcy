import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
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

function seedMission(habitatId: string, columnId: string) {
  return missionRepo.createMission({
    habitatId,
    columnId,
    title: "Test Mission",
    createdBy: "human-1",
  });
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
  vi.useRealTimers();
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

  it("createPage published with explicit coverage window uses that window for the marker", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(
      habitat.id,
      {
        title: "Chunk page",
        content: "",
        status: "published",
        coverageFrom: "2026-01-01T00:00:00.000Z",
        coverageTo: "2026-02-01T00:00:00.000Z",
      },
      "human-1",
    );
    const markers = wikiCoverageRepo.getByPage(page.id);
    expect(markers).toHaveLength(1);
    expect(markers[0].coverageFrom).toBe("2026-01-01T00:00:00.000Z");
    expect(markers[0].coverageTo).toBe("2026-02-01T00:00:00.000Z");
  });

  it("createPage published without an explicit coverage window falls back to a zero-width [createdAt, createdAt] marker (does not leap the watermark to now)", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(
      habitat.id,
      { title: "Adhoc page", content: "", status: "published" },
      "human-1",
    );
    const markers = wikiCoverageRepo.getByPage(page.id);
    expect(markers).toHaveLength(1);
    expect(markers[0].coverageFrom).toBe(page.createdAt);
    expect(markers[0].coverageTo).toBe(page.createdAt);
    // The fallback is a zero-width window at creation — it must NOT span to `now` (which would
    // leap the habitat watermark forward past unevaluated history). Zero-width <=> from === to.
    expect(markers[0].coverageFrom).toBe(markers[0].coverageTo);
  });

  it("updatePageMetadata publish with explicit coverage window uses that window", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(habitat.id, { title: "P", content: "" }, "human-1");
    wikiService.updatePageMetadata(
      page.id,
      {
        status: "published",
        coverageFrom: "2026-03-01T00:00:00.000Z",
        coverageTo: "2026-03-15T00:00:00.000Z",
      },
      "human-1",
    );
    const markers = wikiCoverageRepo.getByPage(page.id);
    expect(markers).toHaveLength(1);
    expect(markers[0].coverageFrom).toBe("2026-03-01T00:00:00.000Z");
    expect(markers[0].coverageTo).toBe("2026-03-15T00:00:00.000Z");
  });

  it("updatePageMetadata publish without explicit coverage window falls back to zero-width [createdAt, createdAt]", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(habitat.id, { title: "P", content: "" }, "human-1");
    wikiService.updatePageMetadata(page.id, { status: "published" }, "human-1");
    const markers = wikiCoverageRepo.getByPage(page.id);
    expect(markers).toHaveLength(1);
    expect(markers[0].coverageFrom).toBe(page.createdAt);
    expect(markers[0].coverageTo).toBe(page.createdAt);
  });

  it("rejects publishing with coverageFrom but no coverageTo (and vice versa)", () => {
    const { habitat } = setupHabitat();
    expect(() =>
      wikiService.createPage(
        habitat.id,
        { title: "P", content: "", status: "published", coverageFrom: "2026-01-01T00:00:00.000Z" },
        "human-1",
      ),
    ).toThrow(/together/i);
    expect(() =>
      wikiService.updatePageMetadata(
        wikiService.createPage(habitat.id, { title: "P", content: "" }, "human-1").id,
        { status: "published", coverageTo: "2026-01-08T00:00:00.000Z" },
        "human-1",
      ),
    ).toThrow(/together/i);
  });

  it("rejects a coverage window where from > to or to is in the future", () => {
    const { habitat } = setupHabitat();
    expect(() =>
      wikiService.createPage(
        habitat.id,
        {
          title: "P",
          content: "",
          status: "published",
          coverageFrom: "2026-02-01T00:00:00.000Z",
          coverageTo: "2026-01-01T00:00:00.000Z",
        },
        "human-1",
      ),
    ).toThrow(/earlier than|coverageFrom/i);
    expect(() =>
      wikiService.createPage(
        habitat.id,
        {
          title: "P",
          content: "",
          status: "published",
          coverageFrom: "2026-01-01T00:00:00.000Z",
          coverageTo: "9999-12-31T23:59:59Z",
        },
        "human-1",
      ),
    ).toThrow(/future/i);
  });

  it("postNoUpdateNeeded rejects malformed windows (from > to, future to, unparseable)", () => {
    const { habitat } = setupHabitat();
    expect(() =>
      wikiService.postNoUpdateNeeded(
        habitat.id,
        { from: "2026-02-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" },
        "human-1",
      ),
    ).toThrow(/earlier than|coverageFrom/i);
    expect(() =>
      wikiService.postNoUpdateNeeded(
        habitat.id,
        { from: "2026-01-01T00:00:00.000Z", to: "9999-12-31T23:59:59Z" },
        "human-1",
      ),
    ).toThrow(/future/i);
    expect(() =>
      wikiService.postNoUpdateNeeded(
        habitat.id,
        { from: "not-a-date", to: "2026-01-01T00:00:00.000Z" },
        "human-1",
      ),
    ).toThrow(/valid datetime/i);
  });

  it("postNoUpdateNeeded accepts a valid window and advances the watermark", () => {
    const { habitat } = setupHabitat();
    const marker = wikiService.postNoUpdateNeeded(
      habitat.id,
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-08T00:00:00.000Z", reason: "low signal" },
      "human-1",
    );
    expect(marker.markerType).toBe("no_update_needed");
    expect(marker.coverageFrom).toBe("2026-01-01T00:00:00.000Z");
    expect(marker.coverageTo).toBe("2026-01-08T00:00:00.000Z");
    expect(marker.reason).toBe("low signal");
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

  it("rejects creating a page under a parent from a different habitat (cross-habitat isolation)", () => {
    const { habitat } = setupHabitat();
    const otherHabitat = habitatRepo.createHabitat({ name: "Other Habitat" });
    const foreignParent = wikiService.createPage(
      otherHabitat.id,
      { title: "Foreign Parent", content: "" },
      "human-1",
    );

    expect(() =>
      wikiService.createPage(
        habitat.id,
        { title: "Child", content: "", parentId: foreignParent.id },
        "human-1",
      ),
    ).toThrow(/different habitat/i);
  });

  it("rejects moving a page under a parent from a different habitat", () => {
    const { habitat } = setupHabitat();
    const otherHabitat = habitatRepo.createHabitat({ name: "Other Habitat" });
    const foreignParent = wikiService.createPage(
      otherHabitat.id,
      { title: "Foreign Parent", content: "" },
      "human-1",
    );
    const page = wikiService.createPage(habitat.id, { title: "Page", content: "" }, "human-1");

    expect(() =>
      wikiService.updatePageMetadata(page.id, { parentId: foreignParent.id }, "human-1"),
    ).toThrow(/different habitat/i);
    expect(wikiPageRepo.getById(page.id)?.parentId).toBeNull();
  });

  it("rejects moving a page under one of its own descendants (cycle prevention)", () => {
    const { habitat } = setupHabitat();
    const root = wikiService.createPage(habitat.id, { title: "Root", content: "" }, "human-1");
    const child = wikiService.createPage(
      habitat.id,
      { title: "Child", content: "", parentId: root.id },
      "human-1",
    );
    const grandchild = wikiService.createPage(
      habitat.id,
      { title: "Grandchild", content: "", parentId: child.id },
      "human-1",
    );

    // Moving root under grandchild would create root → child → grandchild → root.
    expect(() =>
      wikiService.updatePageMetadata(root.id, { parentId: grandchild.id }, "human-1"),
    ).toThrow(/cycle|descendant/i);
    expect(wikiPageRepo.getById(root.id)?.parentId).toBeNull();
  });

  it("rejects moving a page under itself", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(habitat.id, { title: "Self", content: "" }, "human-1");

    expect(() => wikiService.updatePageMetadata(page.id, { parentId: page.id }, "human-1")).toThrow(
      /own parent/i,
    );
  });
});

describe("wikiService.saveVersion", () => {
  it("appends a new version, increments currentVersionNumber, and rewrites denormalized title/content", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(habitat.id, { title: "V1", content: "body v1" }, "human-1");

    const v2 = wikiService.saveVersion(
      page.id,
      { title: "V2", content: "body v2", editSummary: "first edit" },
      "agent-1",
    );
    expect(v2.currentVersionNumber).toBe(2);
    expect(v2.title).toBe("V2");
    expect(v2.content).toBe("body v2");
    expect(v2.lastUpdatedBy).toBe("agent-1");

    const v3 = wikiService.saveVersion(page.id, { title: "V3", content: "body v3" }, "agent-1");
    expect(v3.currentVersionNumber).toBe(3);
    expect(v3.title).toBe("V3");
    expect(v3.content).toBe("body v3");

    const v4 = wikiService.saveVersion(
      page.id,
      { title: "V4", content: "body v4", editSummary: "third edit" },
      "human-1",
    );
    expect(v4.currentVersionNumber).toBe(4);
    expect(v4.title).toBe("V4");
    expect(v4.content).toBe("body v4");

    const versions = wikiPageVersionRepo.listByPage(page.id);
    expect(versions).toHaveLength(4);
    expect(versions.map((v) => v.versionNumber).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    const v4Row = versions.find((v) => v.versionNumber === 4)!;
    expect(v4Row.title).toBe("V4");
    expect(v4Row.content).toBe("body v4");
    expect(v4Row.editSummary).toBe("third edit");
    expect(v4Row.editedBy).toBe("human-1");
  });

  it("extends the page-type coverage marker coverage_to when the page is published", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(
      habitat.id,
      { title: "P", content: "v1", status: "published" },
      "human-1",
    );
    const markerBefore = wikiCoverageRepo.getByPage(page.id);
    expect(markerBefore).toHaveLength(1);
    const originalTo = markerBefore[0].coverageTo;
    const originalFrom = markerBefore[0].coverageFrom;

    // Advance the fake clock past page creation so saveVersion produces a strictly later coverage_to.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 2));
    const after = new Date().toISOString();

    wikiService.saveVersion(
      page.id,
      { title: "P", content: "v2", editSummary: "refresh" },
      "agent-1",
    );

    const markerAfter = wikiCoverageRepo.getByPage(page.id);
    expect(markerAfter).toHaveLength(1);
    expect(markerAfter[0].coverageFrom).toBe(originalFrom);
    expect(markerAfter[0].coverageTo >= after).toBe(true);
    expect(markerAfter[0].coverageTo >= originalTo).toBe(true);
  });

  it("does not touch coverage markers when the page is a draft", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(habitat.id, { title: "D", content: "v1" }, "human-1");
    expect(wikiCoverageRepo.getByPage(page.id)).toHaveLength(0);

    wikiService.saveVersion(page.id, { title: "D", content: "v2" }, "human-1");

    expect(wikiCoverageRepo.getByPage(page.id)).toHaveLength(0);
  });

  it("throws 404 for a missing page", () => {
    expect(() =>
      wikiService.saveVersion("nonexistent", { title: "X", content: "X" }, "human-1"),
    ).toThrow(/not found/i);
  });
});

describe("wikiService.restoreVersion", () => {
  it("creates a new version copying the source version's title and content with a 'Restored from version N' summary", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(habitat.id, { title: "V1", content: "body v1" }, "human-1");
    wikiService.saveVersion(page.id, { title: "V2", content: "body v2" }, "agent-1");
    wikiService.saveVersion(page.id, { title: "V3", content: "body v3" }, "agent-1");

    const restored = wikiService.restoreVersion(page.id, 1, "human-1");
    expect(restored.currentVersionNumber).toBe(4);
    expect(restored.title).toBe("V1");
    expect(restored.content).toBe("body v1");
    expect(restored.lastUpdatedBy).toBe("human-1");

    const versions = wikiPageVersionRepo.listByPage(page.id);
    expect(versions).toHaveLength(4);
    const v4 = versions.find((v) => v.versionNumber === 4)!;
    expect(v4.title).toBe("V1");
    expect(v4.content).toBe("body v1");
    expect(v4.editSummary).toBe("Restored from version 1");
    expect(v4.editedBy).toBe("human-1");

    // The source version row is untouched.
    const v1 = versions.find((v) => v.versionNumber === 1)!;
    expect(v1.title).toBe("V1");
    expect(v1.content).toBe("body v1");
    expect(v1.editSummary).toBe("initial");
  });

  it("extends the page-type coverage marker coverage_to when the page is published", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(
      habitat.id,
      { title: "P", content: "v1", status: "published" },
      "human-1",
    );
    wikiService.saveVersion(page.id, { title: "P", content: "v2" }, "agent-1");
    const markerBefore = wikiCoverageRepo.getByPage(page.id);
    expect(markerBefore).toHaveLength(1);

    // Advance the fake clock past prior saves so restoreVersion produces a strictly later coverage_to.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 2));
    const before = new Date().toISOString();

    wikiService.restoreVersion(page.id, 1, "human-1");

    const markerAfter = wikiCoverageRepo.getByPage(page.id);
    expect(markerAfter).toHaveLength(1);
    expect(markerAfter[0].coverageTo >= before).toBe(true);
  });

  it("throws 404 for a missing page", () => {
    expect(() => wikiService.restoreVersion("nonexistent", 1, "human-1")).toThrow(/not found/i);
  });

  it("throws 404 for a missing version", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(habitat.id, { title: "V1", content: "v1" }, "human-1");
    expect(() => wikiService.restoreVersion(page.id, 99, "human-1")).toThrow(/not found/i);
  });
});

describe("wikiService.addLink", () => {
  it("inserts a link with a valid targetType and returns it", () => {
    const { habitat, col } = setupHabitat();
    const mission = seedMission(habitat.id, col.id);
    const page = wikiService.createPage(habitat.id, { title: "P", content: "" }, "human-1");

    const link = wikiService.addLink(
      page.id,
      { targetType: "mission", targetId: mission.id, note: "covers" },
      "agent-1",
    );

    expect(link.pageId).toBe(page.id);
    expect(link.targetType).toBe("mission");
    expect(link.targetId).toBe(mission.id);
    expect(link.linkNote).toBe("covers");
    expect(link.createdBy).toBe("agent-1");
  });

  it("inserts a link to a non-existent target (no FK; dangling detection runs at read time)", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(habitat.id, { title: "P", content: "" }, "human-1");

    // No mission with this id exists; addLink does not validate target existence.
    const link = wikiService.addLink(
      page.id,
      { targetType: "mission", targetId: "nonexistent-mission" },
      "human-1",
    );
    expect(link.targetId).toBe("nonexistent-mission");

    const listed = wikiService.listLinks(page.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].dangling).toBe(true);
  });

  it("throws 400 for an invalid targetType", () => {
    const { habitat, col } = setupHabitat();
    const mission = seedMission(habitat.id, col.id);
    const page = wikiService.createPage(habitat.id, { title: "P", content: "" }, "human-1");

    expect(() =>
      wikiService.addLink(
        page.id,
        // Bypass the TS type guard to simulate a runtime-invalid value.
        { targetType: "bogus_type" as never, targetId: mission.id },
        "human-1",
      ),
    ).toThrow(/invalid targettype/i);
  });

  it("throws 404 for a missing page", () => {
    expect(() =>
      wikiService.addLink("nonexistent-page", { targetType: "mission", targetId: "m1" }, "human-1"),
    ).toThrow(/not found/i);
  });

  it("throws 409 for a duplicate (pageId, targetType, targetId) citation", () => {
    const { habitat, col } = setupHabitat();
    const mission = seedMission(habitat.id, col.id);
    const page = wikiService.createPage(habitat.id, { title: "P", content: "" }, "human-1");

    wikiService.addLink(page.id, { targetType: "mission", targetId: mission.id }, "human-1");

    expect(() =>
      wikiService.addLink(page.id, { targetType: "mission", targetId: mission.id }, "human-1"),
    ).toThrow(/already exists/i);
  });

  it("allows the same target from a different page", () => {
    const { habitat, col } = setupHabitat();
    const mission = seedMission(habitat.id, col.id);
    const pageA = wikiService.createPage(habitat.id, { title: "A", content: "" }, "human-1");
    const pageB = wikiService.createPage(habitat.id, { title: "B", content: "" }, "human-1");

    wikiService.addLink(pageA.id, { targetType: "mission", targetId: mission.id }, "human-1");
    expect(() =>
      wikiService.addLink(pageB.id, { targetType: "mission", targetId: mission.id }, "human-1"),
    ).not.toThrow();
  });
});

describe("wikiService.removeLink", () => {
  it("removes a link and the list shrinks", () => {
    const { habitat, col } = setupHabitat();
    const mission = seedMission(habitat.id, col.id);
    const page = wikiService.createPage(habitat.id, { title: "P", content: "" }, "human-1");
    const link = wikiService.addLink(
      page.id,
      { targetType: "mission", targetId: mission.id },
      "human-1",
    );

    wikiService.removeLink(page.id, link.id);
    expect(wikiService.listLinks(page.id)).toHaveLength(0);
  });

  it("throws 404 for a missing link id", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(habitat.id, { title: "P", content: "" }, "human-1");

    expect(() => wikiService.removeLink(page.id, "nonexistent-link")).toThrow(/not found/i);
  });

  it("throws 404 when the link belongs to a different page", () => {
    const { habitat, col } = setupHabitat();
    const mission = seedMission(habitat.id, col.id);
    const pageA = wikiService.createPage(habitat.id, { title: "A", content: "" }, "human-1");
    const pageB = wikiService.createPage(habitat.id, { title: "B", content: "" }, "human-1");
    const link = wikiService.addLink(
      pageA.id,
      { targetType: "mission", targetId: mission.id },
      "human-1",
    );

    expect(() => wikiService.removeLink(pageB.id, link.id)).toThrow(/not found/i);
    // Link still present on pageA.
    expect(wikiService.listLinks(pageA.id)).toHaveLength(1);
  });

  it("throws 404 for a missing page", () => {
    expect(() => wikiService.removeLink("nonexistent-page", "any-link")).toThrow(/not found/i);
  });
});

describe("wikiService.listLinks", () => {
  it("returns an empty array for a page with no links", () => {
    const { habitat } = setupHabitat();
    const page = wikiService.createPage(habitat.id, { title: "P", content: "" }, "human-1");
    expect(wikiService.listLinks(page.id)).toEqual([]);
  });

  it("attaches dangling=false for links to live targets", () => {
    const { habitat, col } = setupHabitat();
    const mission = seedMission(habitat.id, col.id);
    const page = wikiService.createPage(habitat.id, { title: "P", content: "" }, "human-1");
    wikiService.addLink(page.id, { targetType: "mission", targetId: mission.id }, "human-1");

    const listed = wikiService.listLinks(page.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].dangling).toBe(false);
  });

  it("flips dangling=true after the target row is deleted (read-time detection)", () => {
    const { habitat, col } = setupHabitat();
    const mission = seedMission(habitat.id, col.id);
    const page = wikiService.createPage(habitat.id, { title: "P", content: "" }, "human-1");
    wikiService.addLink(page.id, { targetType: "mission", targetId: mission.id }, "human-1");

    expect(wikiService.listLinks(page.id)[0].dangling).toBe(false);

    // Delete the target row directly (bypassing the service to simulate the real-world case).
    getDb().delete(missions).where(eqMark(missions.id, mission.id)).run();

    expect(wikiService.listLinks(page.id)[0].dangling).toBe(true);
  });

  it("throws 404 for a missing page", () => {
    expect(() => wikiService.listLinks("nonexistent-page")).toThrow(/not found/i);
  });
});

// Local helper to import a tiny alias without re-doing the import block.
import { eq as eqMark } from "drizzle-orm";
