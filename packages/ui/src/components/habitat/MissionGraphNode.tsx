import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Badge } from '../ui/Badge.js';
import type { MissionWithProgress } from '../../types/index.js';

const priorityColor: Record<string, string> = {
  critical: 'bg-[var(--badge-critical)]',
  high: 'bg-[var(--badge-high)]',
  medium: 'bg-[var(--badge-medium)]',
  low: 'bg-[var(--badge-low)]',
};

const NODE_WIDTH = 220;
const NODE_MIN_HEIGHT = 60;

export type FeatureNodeData = {
  feature: MissionWithProgress;
  isHighlighted: boolean;
  isDimmed: boolean;
  isDependencyMet: boolean;
};

export type FeatureNode = import('@xyflow/react').Node<FeatureNodeData, 'feature'>;

function FeatureGraphNodeComponent({ data }: NodeProps<FeatureNode>) {
  const { feature, isHighlighted, isDimmed, isDependencyMet } = data;

  const borderColor = isHighlighted
    ? 'ring-2 ring-primary/60 border-primary/40'
    : !isDependencyMet
    ? 'border-outline-variant border-dashed'
    : 'border-outline-variant/15';

  const progress = feature.progress;
  const donePercent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <>
      <Handle type="target" position={Position.Top} className="!w-2 !h-2 !bg-on-surface-variant" />
      <div
        className={`glass-card p-2.5 transition-all duration-200 ${borderColor} ${isDimmed ? 'opacity-30' : 'opacity-100'}`}
        style={{ width: NODE_WIDTH, minHeight: NODE_MIN_HEIGHT }}
      >
        <div className="flex items-center gap-2 mb-1.5">
          <div className={`h-2 w-2 rounded-full flex-shrink-0 ${priorityColor[feature.priority] ?? 'bg-[var(--badge-low)]'}`} />
          <span className="text-sm font-medium truncate flex-1 text-on-surface">{feature.title}</span>
        </div>
        <div className="flex items-center justify-between">
          <Badge
            variant={
              feature.status === 'in_progress' ? 'in_progress' :
              feature.status === 'not_started' ? 'pending' :
              feature.status === 'review' ? 'submitted' :
              feature.status === 'done' ? 'done' : 'failed'
            }
            className="text-[10px] px-1.5 py-0"
          >
            {feature.status.replace('_', ' ')}
          </Badge>
          <span className="text-[10px] text-on-surface-variant">
            {progress.done}/{progress.total}
          </span>
        </div>
        {progress.total > 0 && (
          <div className="mt-1.5 h-1 w-full rounded-full bg-surface-container-highest">
            <div
              className="h-1 rounded-full bg-primary transition-all"
              style={{ width: `${donePercent}%` }}
            />
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!w-2 !h-2 !bg-on-surface-variant" />
    </>
  );
}

export const FeatureGraphNode = memo(FeatureGraphNodeComponent);
