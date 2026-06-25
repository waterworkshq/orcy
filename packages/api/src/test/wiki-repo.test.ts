import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import * as wikiPageRepo from "../repositories/wikiPage.js";
import * as wikiPageVersionRepo from "../repositories/wikiPageVersion.js";
import * as wikiPageLinkRepo from "../repositories/wikiPageLink.js";
import * as wikiCoverageRepo from "../repositories/wikiCoverage.js";
import {
  habitats,
  columns,
  missions,
  tasks,
  wikiPages,
  wikiPageLinks,
  wikiCoverageMarkers,
} from "../db/schema/index.js";

function setupHabitat() {
  const habitat = habitatRepo.createHabitat({ name: "Wiki Habitat" });
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

function seedTask(missionId: string) {
  return taskRepo.createTask({ missionId, title: "Test Task", createdBy: "human-1" });
}

function makePage(
  habitatId: string,
  overrides: Partial<Parameters<typeof wikiPageRepo.create>[0]> = {},
) {
  return wikiPageRepo.create({
    habitatId,
    slug: overrides.slug ?? "root-page",
    title: overrides.title ?? "Root Page",
    content: overrides.content ?? "Initial body",
    parentId: overrides.parentId,
    tags: overrides.tags,
    status: overrides.status,
    createdBy: "human-1",
    lastUpdatedBy: "human-1",
  });
}

beforeEach(async () => {
  await initTestDb();
});

afterEach(() => {
  closeDb();
});

describe("wikiPage repo", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(wikiPageLinks).run();
    db.delete(wikiCoverageMarkers).run();
    db.delete(wikiPages).run();
    db.delete(tasks).run();
    db.delete(missions).run();
    db.delete(columns).run();
    db.delete(habitats).run();
  });

  describe("create + getById", () => {
    it("inserts and returns a page", () => {
      const { habitat } = setupHabitat();
      const page = makePage(habitat.id, { slug: "hello", title: "Hello" });

      const fetched = wikiPageRepo.getById(page.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.slug).toBe("hello");
      expect(fetched!.title).toBe("Hello");
      expect(fetched!.status).toBe("draft");
      expect(fetched!.content).toBe("Initial body");
      expect(fetched!.currentVersionNumber).toBe(1);
    });

    it("returns null for a missing id", () => {
      expect(wikiPageRepo.getById("nonexistent")).toBeNull();
    });
  });

  describe("listByHabitat", () => {
    it("filters by parentId null (root pages only)", () => {
      const { habitat } = setupHabitat();
      const root = makePage(habitat.id, { slug: "root" });
      const child = makePage(habitat.id, { slug: "child", parentId: root.id });

      const roots = wikiPageRepo.listByHabitat(habitat.id, { parentId: null });
      expect(roots.map((p) => p.id)).toEqual([root.id]);

      const children = wikiPageRepo.listByHabitat(habitat.id, { parentId: root.id });
      expect(children.map((p) => p.id)).toEqual([child.id]);
    });

    it("filters by tag using JSON-array contains", () => {
      const { habitat } = setupHabitat();
      const tagged = makePage(habitat.id, { slug: "tagged", tags: ["architecture", "core"] });
      makePage(habitat.id, { slug: "untagged" });

      const filtered = wikiPageRepo.listByHabitat(habitat.id, { tag: "architecture" });
      expect(filtered.map((p) => p.id)).toEqual([tagged.id]);
    });

    it("filters by status", () => {
      const { habitat } = setupHabitat();
      const draft = makePage(habitat.id, { slug: "draft", status: "draft" });
      const published = makePage(habitat.id, { slug: "pub", status: "published" });

      const drafts = wikiPageRepo.listByHabitat(habitat.id, { status: "draft" });
      expect(drafts.map((p) => p.id)).toEqual([draft.id]);

      const pubs = wikiPageRepo.listByHabitat(habitat.id, { status: "published" });
      expect(pubs.map((p) => p.id)).toEqual([published.id]);
    });
  });

  describe("getByHabitatAndSlug", () => {
    it("finds root pages (parentId = null) by slug", () => {
      const { habitat } = setupHabitat();
      const root = makePage(habitat.id, { slug: "intro" });
      makePage(habitat.id, { slug: "intro", parentId: root.id });

      const found = wikiPageRepo.getByHabitatAndSlug(habitat.id, "intro");
      expect(found?.id).toBe(root.id);
    });

    it("finds child pages by slug under their parent", () => {
      const { habitat } = setupHabitat();
      const root = makePage(habitat.id, { slug: "root" });
      const child = makePage(habitat.id, { slug: "child", parentId: root.id });

      const found = wikiPageRepo.getByHabitatAndSlug(habitat.id, "child", root.id);
      expect(found?.id).toBe(child.id);
      const missing = wikiPageRepo.getByHabitatAndSlug(habitat.id, "child", "other-parent");
      expect(missing).toBeNull();
    });
  });

  describe("updateMetadata", () => {
    it("updates parentId, tags, status, lastUpdatedBy without touching title/content", () => {
      const { habitat } = setupHabitat();
      const root = makePage(habitat.id, { slug: "root" });
      const other = makePage(habitat.id, { slug: "other" });
      const before = wikiPageRepo.getById(root.id)!;

      wikiPageRepo.updateMetadata(root.id, {
        parentId: other.id,
        tags: ["moved"],
        status: "published",
        lastUpdatedBy: "agent-2",
      });

      const after = wikiPageRepo.getById(root.id)!;
      expect(after.parentId).toBe(other.id);
      expect(after.tags).toEqual(["moved"]);
      expect(after.status).toBe("published");
      expect(after.lastUpdatedBy).toBe("agent-2");
      expect(after.title).toBe(before.title);
      expect(after.content).toBe(before.content);
      expect(after.lastUpdatedAt >= before.lastUpdatedAt).toBe(true);
    });
  });

  describe("deletePage", () => {
    it("removes a page and returns true", () => {
      const { habitat } = setupHabitat();
      const page = makePage(habitat.id, { slug: "doomed" });
      expect(wikiPageRepo.deletePage(page.id)).toBe(true);
      expect(wikiPageRepo.getById(page.id)).toBeNull();
    });

    it("returns false when the page does not exist", () => {
      expect(wikiPageRepo.deletePage("nonexistent")).toBe(false);
    });
  });

  describe("search (FTS5 / LIKE fallback)", () => {
    it("finds published pages by title and content via the LIKE fallback path", () => {
      const { habitat } = setupHabitat();
      wikiPageRepo.create({
        habitatId: habitat.id,
        slug: "alpha",
        title: "Alpha guide",
        content: "explains the alpha subsystem",
        status: "published",
        createdBy: "human-1",
        lastUpdatedBy: "human-1",
      });
      wikiPageRepo.create({
        habitatId: habitat.id,
        slug: "beta",
        title: "Beta guide",
        content: "explains the beta subsystem",
        status: "published",
        createdBy: "human-1",
        lastUpdatedBy: "human-1",
      });
      wikiPageRepo.create({
        habitatId: habitat.id,
        slug: "draft-alpha",
        title: "Alpha draft",
        content: "in progress",
        status: "draft",
        createdBy: "human-1",
        lastUpdatedBy: "human-1",
      });

      const results = wikiPageRepo.search(habitat.id, "alpha");
      expect(results.length).toBe(1);
      expect(results[0].slug).toBe("alpha");
    });

    it("returns an empty array when nothing matches", () => {
      const { habitat } = setupHabitat();
      const results = wikiPageRepo.search(habitat.id, "nothere");
      expect(results).toEqual([]);
    });

    it("matches content-only (term appears in content but not title)", () => {
      const { habitat } = setupHabitat();
      wikiPageRepo.create({
        habitatId: habitat.id,
        slug: "incident-42",
        title: "Q3 retrospective",
        content: "on-call rotation missed a paging escalation",
        status: "published",
        createdBy: "human-1",
        lastUpdatedBy: "human-1",
      });
      wikiPageRepo.create({
        habitatId: habitat.id,
        slug: "other",
        title: "Quarterly OKRs",
        content: "ambitious targets set in July",
        status: "published",
        createdBy: "human-1",
        lastUpdatedBy: "human-1",
      });

      const results = wikiPageRepo.search(habitat.id, "paging");
      expect(results).toHaveLength(1);
      expect(results[0].slug).toBe("incident-42");
    });

    it("does not return pages from a different habitat", () => {
      const habitatA = habitatRepo.createHabitat({ name: "Habitat A" });
      columnRepo.createColumn({ habitatId: habitatA.id, name: "Todo", order: 0 });
      const habitatB = habitatRepo.createHabitat({ name: "Habitat B" });
      columnRepo.createColumn({ habitatId: habitatB.id, name: "Todo", order: 0 });

      wikiPageRepo.create({
        habitatId: habitatA.id,
        slug: "shared-term-a",
        title: "Habitat A alpha",
        content: "uses the alpha term",
        status: "published",
        createdBy: "human-1",
        lastUpdatedBy: "human-1",
      });
      wikiPageRepo.create({
        habitatId: habitatB.id,
        slug: "shared-term-b",
        title: "Habitat B alpha",
        content: "uses the alpha term",
        status: "published",
        createdBy: "human-1",
        lastUpdatedBy: "human-1",
      });

      const resultsA = wikiPageRepo.search(habitatA.id, "alpha");
      expect(resultsA).toHaveLength(1);
      expect(resultsA[0].slug).toBe("shared-term-a");

      const resultsB = wikiPageRepo.search(habitatB.id, "alpha");
      expect(resultsB).toHaveLength(1);
      expect(resultsB[0].slug).toBe("shared-term-b");
    });

    it("honors limit and offset", () => {
      const { habitat } = setupHabitat();
      for (let i = 0; i < 5; i++) {
        wikiPageRepo.create({
          habitatId: habitat.id,
          slug: `page-${i}`,
          title: `Shared ${i}`,
          content: "common content",
          status: "published",
          createdBy: "human-1",
          lastUpdatedBy: "human-1",
        });
      }

      const first2 = wikiPageRepo.search(habitat.id, "Shared", { limit: 2, offset: 0 });
      expect(first2).toHaveLength(2);

      const next2 = wikiPageRepo.search(habitat.id, "Shared", { limit: 2, offset: 2 });
      expect(next2).toHaveLength(2);

      const idsFirst = new Set(first2.map((r) => r.id));
      const idsNext = new Set(next2.map((r) => r.id));
      for (const id of idsNext) {
        expect(idsFirst.has(id)).toBe(false);
      }
    });

    it("returns rank=0 and a 160-char excerpt in the LIKE fallback path", () => {
      const { habitat } = setupHabitat();
      const longContent = "x".repeat(500);
      wikiPageRepo.create({
        habitatId: habitat.id,
        slug: "long",
        title: "Long",
        content: longContent,
        status: "published",
        createdBy: "human-1",
        lastUpdatedBy: "human-1",
      });

      const results = wikiPageRepo.search(habitat.id, "Long");
      expect(results).toHaveLength(1);
      expect(results[0].rank).toBe(0);
      expect(results[0].excerpt.length).toBeLessThanOrEqual(160);
    });

    it("excludes draft pages even when the term matches", () => {
      const { habitat } = setupHabitat();
      wikiPageRepo.create({
        habitatId: habitat.id,
        slug: "published-match",
        title: "Common term",
        content: "common body",
        status: "published",
        createdBy: "human-1",
        lastUpdatedBy: "human-1",
      });
      wikiPageRepo.create({
        habitatId: habitat.id,
        slug: "draft-match",
        title: "Common term",
        content: "common body",
        status: "draft",
        createdBy: "human-1",
        lastUpdatedBy: "human-1",
      });

      const results = wikiPageRepo.search(habitat.id, "common");
      expect(results).toHaveLength(1);
      expect(results[0].slug).toBe("published-match");
    });
  });
});

describe("wikiPageVersion repo", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(wikiPageLinks).run();
    db.delete(wikiCoverageMarkers).run();
    db.delete(wikiPages).run();
    db.delete(tasks).run();
    db.delete(missions).run();
    db.delete(columns).run();
    db.delete(habitats).run();
  });

  it("inserts and retrieves a version by page + number", () => {
    const { habitat } = setupHabitat();
    const page = makePage(habitat.id);

    const v = wikiPageVersionRepo.create({
      pageId: page.id,
      versionNumber: 1,
      title: "v1 title",
      content: "v1 body",
      editedBy: "human-1",
      editSummary: "first",
    });
    expect(v.versionNumber).toBe(1);
    expect(v.editSummary).toBe("first");

    const fetched = wikiPageVersionRepo.getByPageAndNumber(page.id, 1);
    expect(fetched?.id).toBe(v.id);
    expect(fetched?.title).toBe("v1 title");
  });

  it("lists versions for a page ordered by versionNumber descending", () => {
    const { habitat } = setupHabitat();
    const page = makePage(habitat.id);
    for (const n of [1, 2, 3]) {
      wikiPageVersionRepo.create({
        pageId: page.id,
        versionNumber: n,
        title: `v${n}`,
        content: `body v${n}`,
        editedBy: "human-1",
      });
    }
    const list = wikiPageVersionRepo.listByPage(page.id);
    expect(list.map((v) => v.versionNumber)).toEqual([3, 2, 1]);
  });

  it("getByPageAndNumber returns null for a missing version", () => {
    const { habitat } = setupHabitat();
    const page = makePage(habitat.id);
    expect(wikiPageVersionRepo.getByPageAndNumber(page.id, 99)).toBeNull();
  });

  it("getLatest returns the version matching the page's currentVersionNumber", () => {
    const { habitat } = setupHabitat();
    const page = makePage(habitat.id);
    wikiPageVersionRepo.create({
      pageId: page.id,
      versionNumber: 1,
      title: "v1",
      content: "v1",
      editedBy: "human-1",
    });
    wikiPageVersionRepo.create({
      pageId: page.id,
      versionNumber: 2,
      title: "v2",
      content: "v2",
      editedBy: "human-1",
    });
    // currentVersionNumber still 1 on the page row (not auto-advanced)
    const latest = wikiPageVersionRepo.getLatest(page.id);
    expect(latest?.versionNumber).toBe(1);
  });
});

describe("wikiPageLink repo", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(wikiPageLinks).run();
    db.delete(wikiCoverageMarkers).run();
    db.delete(wikiPages).run();
    db.delete(tasks).run();
    db.delete(missions).run();
    db.delete(columns).run();
    db.delete(habitats).run();
  });

  it("create + listByPage + remove lifecycle", () => {
    const { habitat, col } = setupHabitat();
    const mission = seedMission(habitat.id, col.id);
    const page = makePage(habitat.id);
    const link = wikiPageLinkRepo.create({
      pageId: page.id,
      targetType: "mission",
      targetId: mission.id,
      linkNote: "covers",
      createdBy: "human-1",
    });
    expect(link.targetType).toBe("mission");

    const list = wikiPageLinkRepo.listByPage(page.id);
    expect(list).toHaveLength(1);

    expect(wikiPageLinkRepo.remove(link.id)).toBe(true);
    expect(wikiPageLinkRepo.listByPage(page.id)).toHaveLength(0);
  });

  it("remove returns false for a missing link", () => {
    expect(wikiPageLinkRepo.remove("nonexistent")).toBe(false);
  });

  describe("resolveDangling", () => {
    it("flags links whose target does not exist; keeps links to live targets", () => {
      const { habitat, col } = setupHabitat();
      const liveMission = seedMission(habitat.id, col.id);
      const seedMissionForTask = seedMission(habitat.id, col.id);
      const task = seedTask(seedMissionForTask.id);
      const page = makePage(habitat.id);
      const l1 = wikiPageLinkRepo.create({
        pageId: page.id,
        targetType: "mission",
        targetId: liveMission.id,
        createdBy: "human-1",
      });
      const l2 = wikiPageLinkRepo.create({
        pageId: page.id,
        targetType: "mission",
        targetId: "mission-deleted",
        createdBy: "human-1",
      });
      const l3 = wikiPageLinkRepo.create({
        pageId: page.id,
        targetType: "task",
        targetId: task.id,
        createdBy: "human-1",
      });

      const resolved = wikiPageLinkRepo.resolveDangling(wikiPageLinkRepo.listByPage(page.id));
      const byId = new Map(resolved.map((r) => [r.id, r]));
      expect(byId.get(l1.id)?.dangling).toBe(false);
      expect(byId.get(l2.id)?.dangling).toBe(true);
      expect(byId.get(l3.id)?.dangling).toBe(false);
    });

    it("returns empty array for empty input", () => {
      expect(wikiPageLinkRepo.resolveDangling([])).toEqual([]);
    });
  });
});

describe("wikiCoverage repo", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(wikiPageLinks).run();
    db.delete(wikiCoverageMarkers).run();
    db.delete(wikiPages).run();
    db.delete(tasks).run();
    db.delete(missions).run();
    db.delete(columns).run();
    db.delete(habitats).run();
  });

  it("create + getByPage", () => {
    const { habitat } = setupHabitat();
    const page = makePage(habitat.id);
    const m = wikiCoverageRepo.create({
      habitatId: habitat.id,
      coverageFrom: "2025-01-01T00:00:00.000Z",
      coverageTo: "2025-01-08T00:00:00.000Z",
      markerType: "page",
      pageId: page.id,
      createdBy: "human-1",
    });
    const list = wikiCoverageRepo.getByPage(page.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(m.id);
  });

  describe("getWatermark", () => {
    it("returns null when no markers exist for the habitat", () => {
      const { habitat } = setupHabitat();
      expect(wikiCoverageRepo.getWatermark(habitat.id)).toBeNull();
    });

    it("returns the single marker's coverage_to", () => {
      const { habitat } = setupHabitat();
      wikiCoverageRepo.create({
        habitatId: habitat.id,
        coverageFrom: "2025-01-01T00:00:00.000Z",
        coverageTo: "2025-01-08T00:00:00.000Z",
        markerType: "no_update_needed",
        createdBy: "human-1",
      });
      expect(wikiCoverageRepo.getWatermark(habitat.id)).toBe("2025-01-08T00:00:00.000Z");
    });

    it("returns the maximum coverage_to across multiple markers", () => {
      const { habitat } = setupHabitat();
      wikiCoverageRepo.create({
        habitatId: habitat.id,
        coverageFrom: "2025-01-01T00:00:00.000Z",
        coverageTo: "2025-01-08T00:00:00.000Z",
        markerType: "no_update_needed",
        createdBy: "human-1",
      });
      wikiCoverageRepo.create({
        habitatId: habitat.id,
        coverageFrom: "2025-01-08T00:00:00.000Z",
        coverageTo: "2025-01-15T00:00:00.000Z",
        markerType: "no_update_needed",
        createdBy: "human-1",
      });
      wikiCoverageRepo.create({
        habitatId: habitat.id,
        coverageFrom: "2024-12-25T00:00:00.000Z",
        coverageTo: "2025-01-01T00:00:00.000Z",
        markerType: "no_update_needed",
        createdBy: "human-1",
      });
      expect(wikiCoverageRepo.getWatermark(habitat.id)).toBe("2025-01-15T00:00:00.000Z");
    });
  });

  describe("replacePageMarkersWithNoUpdate", () => {
    it("inserts no_update_needed markers covering the same windows as the page's page-type markers", () => {
      const { habitat } = setupHabitat();
      const page = makePage(habitat.id);
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

      const inserted = wikiCoverageRepo.replacePageMarkersWithNoUpdate(page.id, {
        reason: "erroneous",
        createdBy: "human-2",
      });
      expect(inserted).toHaveLength(2);
      expect(inserted.every((m) => m.markerType === "no_update_needed")).toBe(true);
      expect(inserted.every((m) => m.pageId === null)).toBe(true);
      expect(inserted.every((m) => m.reason === "erroneous")).toBe(true);
      expect(inserted.every((m) => m.createdBy === "human-2")).toBe(true);
    });

    it("returns an empty array when the page has no page-type markers", () => {
      const { habitat } = setupHabitat();
      const page = makePage(habitat.id);
      const inserted = wikiCoverageRepo.replacePageMarkersWithNoUpdate(page.id, { createdBy: "x" });
      expect(inserted).toEqual([]);
    });
  });
});
