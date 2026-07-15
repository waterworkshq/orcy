import { useState, useEffect, useMemo, useCallback } from "react";
import type { Node, Edge } from "@xyflow/react";
import dagre from "dagre";
import { api } from "../api/index.js";
import type { MissionWithProgress } from "../types/index.js";

const DAGRE_CONFIG = {
  rankdir: "TB" as const,
  nodesep: 60,
  ranksep: 80,
  marginx: 30,
  marginy: 30,
};

const NODE_WIDTH = 220;
const NODE_HEIGHT = 80;

export type FeatureNodeData = {
  feature: MissionWithProgress;
  isHighlighted: boolean;
  isDimmed: boolean;
  isDependencyMet: boolean;
};

export type FeatureNode = Node<FeatureNodeData, "feature">;

export type DependencyEdge = Edge & {
  data?: { isHighlighted: boolean };
};

export function computeChain(
  highlightedNodeId: string,
  nodes: FeatureNode[],
  edges: DependencyEdge[],
): Set<string> {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const upstream = new Set<string>();
  const downstream = new Set<string>();

  function walkUpstream(nodeId: string) {
    const node = nodeMap.get(nodeId);
    if (!node) return;
    for (const edge of edges) {
      if (edge.target === nodeId) {
        upstream.add(edge.source);
        walkUpstream(edge.source);
      }
    }
  }

  function walkDownstream(nodeId: string) {
    const node = nodeMap.get(nodeId);
    if (!node) return;
    for (const edge of edges) {
      if (edge.source === nodeId) {
        downstream.add(edge.target);
        walkDownstream(edge.target);
      }
    }
  }

  walkUpstream(highlightedNodeId);
  walkDownstream(highlightedNodeId);

  return new Set([highlightedNodeId, ...upstream, ...downstream]);
}

export function computeLayout(features: MissionWithProgress[]): {
  nodes: FeatureNode[];
  edges: DependencyEdge[];
} {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph(DAGRE_CONFIG);

  if (features.length === 0) {
    return { nodes: [], edges: [] };
  }

  for (const feature of features) {
    g.setNode(feature.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  // Edge from dependsOn feature to this feature (dep → dependent)
  const edgeSet = new Set<string>();
  const edges: DependencyEdge[] = [];
  for (const feature of features) {
    for (const depId of feature.dependsOn) {
      if (!features.some((f) => f.id === depId)) continue;
      const edgeId = `e-${depId}-${feature.id}`;
      if (edgeSet.has(edgeId)) continue;
      edgeSet.add(edgeId);
      // Dependency is met when the depended-on feature is done or approved
      const depFeature = features.find((f) => f.id === depId)!;
      const met = depFeature.status === "done";
      edges.push({
        id: edgeId,
        source: depId,
        target: feature.id,
        type: "smoothstep",
        animated: !met,
        data: { isHighlighted: false },
        style: {
          stroke: met ? "#44484d" : "#f59e0b",
          strokeWidth: 1.5,
        },
      });
    }
  }

  dagre.layout(g);

  const nodes: FeatureNode[] = features.map((feature) => {
    const nodePos = g.node(feature.id);
    return {
      id: feature.id,
      type: "feature",
      position: { x: nodePos.x - NODE_WIDTH / 2, y: nodePos.y - NODE_HEIGHT / 2 },
      data: {
        feature,
        isHighlighted: false,
        isDimmed: false,
        isDependencyMet: feature.dependsOn.every((depId) => {
          const dep = features.find((f) => f.id === depId);
          return !dep || dep.status === "done";
        }),
      },
    };
  });

  return { nodes, edges };
}

export function useDependencyGraph(boardId: string) {
  const [features, setFeatures] = useState<MissionWithProgress[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    async function fetchFeatures() {
      try {
        const result = await api.missions.list(boardId);
        if (!cancelled) setFeatures(result.missions);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load features");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchFeatures();
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  const layoutResult = useMemo(() => computeLayout(features), [features]);

  const highlightedChain = useMemo(() => {
    if (!highlightedNodeId) return new Set<string>();
    return computeChain(highlightedNodeId, layoutResult.nodes, layoutResult.edges);
  }, [highlightedNodeId, layoutResult.nodes, layoutResult.edges]);

  const finalNodes = useMemo<FeatureNode[]>(() => {
    if (!highlightedNodeId) return layoutResult.nodes;
    return layoutResult.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        isHighlighted: highlightedChain.has(node.id),
        isDimmed: !highlightedChain.has(node.id),
      },
    }));
  }, [layoutResult.nodes, highlightedNodeId, highlightedChain]);

  const finalEdges = useMemo<DependencyEdge[]>(() => {
    if (!highlightedNodeId) return layoutResult.edges;
    return layoutResult.edges.map((edge) => {
      const bothInChain = highlightedChain.has(edge.source) && highlightedChain.has(edge.target);
      return {
        ...edge,
        data: { isHighlighted: bothInChain },
        style: {
          ...edge.style,
          stroke: bothInChain ? "#b1cad7" : "#44484d",
          strokeWidth: bothInChain ? 2.5 : 1,
          opacity: bothInChain ? 1 : 0.3,
        },
      };
    });
  }, [layoutResult.edges, highlightedNodeId, highlightedChain]);

  const clearHighlight = useCallback(() => setHighlightedNodeId(null), []);

  return {
    nodes: finalNodes,
    edges: finalEdges,
    isLoading,
    error,
    highlightedNodeId,
    setHighlightedNode: setHighlightedNodeId,
    clearHighlight,
    featureCount: features.length,
  };
}
