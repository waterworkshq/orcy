import { describe, it, expect, vi } from "vitest";
import type { MissionWithProgress } from "../types/index.js";

vi.mock("../api/index.js", () => ({
  api: {
    features: {
      list: vi.fn(),
    },
  },
}));

import { computeLayout, computeChain } from "./useDependencyGraph.js";

function makeFeatureWithProgress(overrides: {
  id: string;
  dependsOn?: string[];
  status?: MissionWithProgress["status"];
}): MissionWithProgress {
  return {
    id: overrides.id,
    habitatId: "board-1",
    columnId: "col-1",
    title: `Feature ${overrides.id}`,
    description: "",
    acceptanceCriteria: "",
    priority: "medium",
    labels: [],
    status: overrides.status ?? "not_started",
    displayOrder: 0,
    dependsOn: overrides.dependsOn ?? [],
    blocks: [],
    dueAt: null,
    slaMinutes: null,
    slaDeadlineAt: null,
    createdBy: "user-1",
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
    version: 1,
    isArchived: false,
    sprintId: null,
    releaseGateType: null,
    releaseGateVersion: null,
  releaseDeadlineType: null,
  releaseDeadlineVersion: null,
    actualMinutes: null,
    plannedMinutes: null,
    planningAccuracy: null,
    completedAt: null,
    progress: {
      total: 3,
      pending: 2,
      claimed: 0,
      inProgress: 0,
      submitted: 0,
      approved: 0,
      done: 1,
      failed: 0,
      rejected: 0,
      percentage: 0,
    },
  };
}

describe("computeLayout", () => {
  it("returns empty nodes and edges when no features", () => {
    const result = computeLayout([]);
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it("returns nodes without edges when no feature dependencies", () => {
    const features = [
      makeFeatureWithProgress({ id: "feat-1" }),
      makeFeatureWithProgress({ id: "feat-2" }),
      makeFeatureWithProgress({ id: "feat-3" }),
    ];
    const result = computeLayout(features);
    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toHaveLength(0);
  });

  it("creates edges from feature dependsOn relationships", () => {
    const features = [
      makeFeatureWithProgress({ id: "feat-1" }),
      makeFeatureWithProgress({ id: "feat-2", dependsOn: ["feat-1"] }),
      makeFeatureWithProgress({ id: "feat-3", dependsOn: ["feat-2"] }),
    ];
    const result = computeLayout(features);

    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toHaveLength(2);

    const edgeIds = result.edges.map((e) => e.id);
    expect(edgeIds).toContain("e-feat-1-feat-2");
    expect(edgeIds).toContain("e-feat-2-feat-3");
  });

  it("marks edges as animated when dependency is not met", () => {
    const features = [
      makeFeatureWithProgress({ id: "feat-1", status: "not_started" }),
      makeFeatureWithProgress({ id: "feat-2", dependsOn: ["feat-1"] }),
    ];
    const result = computeLayout(features);

    const edge = result.edges.find((e) => e.id === "e-feat-1-feat-2");
    expect(edge?.animated).toBe(true);
  });

  it("marks edges as non-animated when dependency is met (done)", () => {
    const features = [
      makeFeatureWithProgress({ id: "feat-1", status: "done" }),
      makeFeatureWithProgress({ id: "feat-2", dependsOn: ["feat-1"] }),
    ];
    const result = computeLayout(features);

    const edge = result.edges.find((e) => e.id === "e-feat-1-feat-2");
    expect(edge?.animated).toBe(false);
  });

  it("marks edges as animated when dependency is not done (review)", () => {
    const features = [
      makeFeatureWithProgress({ id: "feat-1", status: "review" }),
      makeFeatureWithProgress({ id: "feat-2", dependsOn: ["feat-1"] }),
    ];
    const result = computeLayout(features);

    const edge = result.edges.find((e) => e.id === "e-feat-1-feat-2");
    expect(edge?.animated).toBe(true);
  });

  it("positions nodes using dagre layout", () => {
    const features = [
      makeFeatureWithProgress({ id: "feat-1" }),
      makeFeatureWithProgress({ id: "feat-2", dependsOn: ["feat-1"] }),
    ];
    const result = computeLayout(features);

    expect(result.nodes).toHaveLength(2);
    for (const node of result.nodes) {
      expect(node.position.x).toBeGreaterThanOrEqual(0);
      expect(node.position.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("skips edges for dangling feature dependsOn IDs", () => {
    const features = [
      makeFeatureWithProgress({ id: "feat-1", dependsOn: ["nonexistent"] }),
      makeFeatureWithProgress({ id: "feat-2" }),
    ];
    const result = computeLayout(features);

    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(0);
  });
});

describe("computeChain", () => {
  it("returns only the node itself for an isolated node with no edges", () => {
    const features = [makeFeatureWithProgress({ id: "feat-1" })];
    const { nodes, edges } = computeLayout(features);
    const chain = computeChain("feat-1", nodes, edges);
    expect(chain).toEqual(new Set(["feat-1"]));
  });

  it("finds full upstream chain", () => {
    const features = [
      makeFeatureWithProgress({ id: "feat-1" }),
      makeFeatureWithProgress({ id: "feat-2", dependsOn: ["feat-1"] }),
      makeFeatureWithProgress({ id: "feat-3", dependsOn: ["feat-2"] }),
    ];
    const { nodes, edges } = computeLayout(features);
    const chain = computeChain("feat-3", nodes, edges);
    expect(chain).toEqual(new Set(["feat-1", "feat-2", "feat-3"]));
  });

  it("finds full downstream chain", () => {
    const features = [
      makeFeatureWithProgress({ id: "feat-1" }),
      makeFeatureWithProgress({ id: "feat-2", dependsOn: ["feat-1"] }),
      makeFeatureWithProgress({ id: "feat-3", dependsOn: ["feat-2"] }),
    ];
    const { nodes, edges } = computeLayout(features);
    const chain = computeChain("feat-1", nodes, edges);
    expect(chain).toEqual(new Set(["feat-1", "feat-2", "feat-3"]));
  });

  it("does not include disconnected nodes", () => {
    const features = [
      makeFeatureWithProgress({ id: "feat-1" }),
      makeFeatureWithProgress({ id: "feat-2", dependsOn: ["feat-1"] }),
      makeFeatureWithProgress({ id: "feat-3" }),
      makeFeatureWithProgress({ id: "feat-4", dependsOn: ["feat-3"] }),
    ];
    const { nodes, edges } = computeLayout(features);
    const chain = computeChain("feat-1", nodes, edges);
    expect(chain).toEqual(new Set(["feat-1", "feat-2"]));
  });
});
