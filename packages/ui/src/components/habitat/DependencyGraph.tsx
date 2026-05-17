import { useCallback } from 'react';
import {
  ReactFlow,
  Controls,
  MiniMap,
  Background,
  BackgroundVariant,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { FeatureGraphNode } from './MissionGraphNode.js';
import { useDependencyGraph } from '../../hooks/useDependencyGraph.js';
import { useIsMobile } from '../../hooks/useMediaQuery.js';

interface DependencyGraphInnerProps {
  habitatId: string;
  onSelectFeature: (missionId: string) => void;
}

const nodeTypes = { feature: FeatureGraphNode };

function DependencyGraphInner({ habitatId, onSelectFeature }: DependencyGraphInnerProps) {
  const { nodes, edges, isLoading, error, setHighlightedNode, clearHighlight } =
    useDependencyGraph(habitatId);
  const isMobile = useIsMobile();

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: { id: string }) => {
      setHighlightedNode(node.id);
      onSelectFeature(node.id);
    },
    [setHighlightedNode, onSelectFeature]
  );

  const onPaneClick = useCallback(() => {
    clearHighlight();
  }, [clearHighlight]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64 text-error">
        <p>{error}</p>
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-on-surface-variant gap-2">
        <p>No features on this board.</p>
        <p className="text-xs">Add features to see them in the graph.</p>
      </div>
    );
  }

  return (
    <div className="h-[calc(85vh-120px)] md:h-[calc(85vh-120px)] w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.1}
        maxZoom={2}
      >
        <Controls showInteractive={false} />
        {!isMobile && (
        <MiniMap
          nodeStrokeWidth={1}
          zoomable
          pannable
          nodeColor={(node) => {
            const data = node.data as { feature?: { status?: string } } | undefined;
            const status = data?.feature?.status;
            if (status === 'done') return '#22c55e';
            if (status === 'in_progress') return '#a855f7';
            if (status === 'review') return '#f59e0b';
            if (status === 'failed') return '#ef4444';
            if (status === 'not_started') return '#9ca3af';
            return '#9ca3af';
          }}
        />
      )}
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#44484d" />
      </ReactFlow>
    </div>
  );
}

interface DependencyGraphProps {
  habitatId: string;
  onSelectFeature: (missionId: string) => void;
}

export function DependencyGraph({ habitatId, onSelectFeature }: DependencyGraphProps) {
  return (
    <ReactFlowProvider>
      <DependencyGraphInner habitatId={habitatId} onSelectFeature={onSelectFeature} />
    </ReactFlowProvider>
  );
}