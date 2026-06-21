import React, { useMemo } from "react";
import dagre from "dagre";
import type { WorkflowTemplateGate, TaskTemplateEntry } from "../../types/index.js";
import { resolveTaskKey, GATE_TYPE_LABELS } from "./workflowEditorUtils.js";

/** Props for the {@link WorkflowPreviewSvg} component. */
interface WorkflowPreviewSvgProps {
  tasks: TaskTemplateEntry[];
  gates: WorkflowTemplateGate[];
}

const NODE_WIDTH = 160;
const NODE_HEIGHT = 44;
const NODE_SEP = 40;
const RANK_SEP = 80;

/** Renders a read-only SVG DAG of the workflow, with tasks as labeled rectangles and gates as arrowed edges. */
export function WorkflowPreviewSvg({ tasks, gates }: WorkflowPreviewSvgProps) {
  const layout = useMemo(() => {
    if (tasks.length === 0) return null;

    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: 20, marginy: 20 });
    g.setDefaultEdgeLabel(() => ({}));

    const nodeData = new Map<string, { title: string; index: number }>();
    for (let i = 0; i < tasks.length; i++) {
      const key = resolveTaskKey(tasks[i], i);
      const title = tasks[i].title || "(untitled)";
      g.setNode(key, { width: NODE_WIDTH, height: NODE_HEIGHT });
      nodeData.set(key, { title, index: i });
    }

    for (const gate of gates) {
      if (g.hasNode(gate.upstreamTaskKey) && g.hasNode(gate.downstreamTaskKey)) {
        g.setEdge(gate.upstreamTaskKey, gate.downstreamTaskKey, {
          label: gate.gateType,
        });
      }
    }

    dagre.layout(g);

    const nodes = g.nodes().map((id) => {
      const node = g.node(id);
      const data = nodeData.get(id);
      return {
        id,
        x: node.x,
        y: node.y,
        title: data?.title ?? id,
        index: data?.index ?? 0,
      };
    });

    const edges = g.edges().map((eObj, i) => {
      const edge = g.edge(eObj);
      const gate = gates[i];
      return {
        id: `${eObj.v}-${eObj.w}-${i}`,
        points: edge.points ?? [],
        label: gate ? (GATE_TYPE_LABELS[gate.gateType] ?? gate.gateType) : "",
        gateType: gate?.gateType ?? "",
      };
    });

    const graph = g.graph();
    return {
      nodes,
      edges,
      width: graph?.width ?? 0,
      height: graph?.height ?? 0,
    };
  }, [tasks, gates]);

  if (!layout || layout.nodes.length === 0) {
    return (
      <div
        data-testid="workflow-preview-empty"
        className="flex items-center justify-center rounded-md border border-dashed border-border p-8 text-sm text-muted-foreground"
      >
        Add tasks and gates to see the workflow preview
      </div>
    );
  }

  return (
    <div
      data-testid="workflow-preview-svg"
      className="overflow-auto rounded-md border border-border p-2"
    >
      <svg width={layout.width} height={layout.height} style={{ minWidth: "100%" }}>
        <defs>
          <marker
            id="arrowhead"
            markerWidth="10"
            markerHeight="7"
            refX="9"
            refY="3.5"
            orient="auto"
          >
            <polygon points="0 0, 10 3.5, 0 7" fill="hsl(var(--muted-foreground))" />
          </marker>
        </defs>

        {layout.edges.map((edge) => {
          if (edge.points.length < 2) return null;
          const path = edge.points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
          const midIndex = Math.floor(edge.points.length / 2);
          const midPoint = edge.points[midIndex] ?? edge.points[0];
          return (
            <g key={edge.id}>
              <path
                d={path}
                fill="none"
                stroke="hsl(var(--muted-foreground))"
                strokeWidth={1.5}
                markerEnd="url(#arrowhead)"
              />
              <text
                x={midPoint.x}
                y={(midPoint.y ?? 0) - 6}
                textAnchor="middle"
                className="fill-muted-foreground"
                style={{ fontSize: "9px", fontStyle: "italic" }}
              >
                {edge.label}
              </text>
            </g>
          );
        })}

        {layout.nodes.map((node) => (
          <g key={node.id}>
            <rect
              x={node.x - NODE_WIDTH / 2}
              y={node.y - NODE_HEIGHT / 2}
              width={NODE_WIDTH}
              height={NODE_HEIGHT}
              rx={6}
              ry={6}
              fill="hsl(var(--card))"
              stroke="hsl(var(--border))"
              strokeWidth={1.5}
            />
            <text
              x={node.x}
              y={node.y - 4}
              textAnchor="middle"
              className="fill-foreground"
              style={{ fontSize: "11px", fontWeight: 600 }}
            >
              {node.id}
            </text>
            <text
              x={node.x}
              y={node.y + 10}
              textAnchor="middle"
              className="fill-muted-foreground"
              style={{ fontSize: "9px" }}
            >
              {node.title.length > 20 ? `${node.title.slice(0, 20)}…` : node.title}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
