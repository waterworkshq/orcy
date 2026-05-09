import React from 'react';
import { DetailCard } from '../ui/DetailCard.js';
import { FileStack, Layers } from 'lucide-react';

interface FeatureContextData {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  priority: string;
  status: string;
}

interface FeatureContextSectionProps {
  feature: FeatureContextData | null;
  onSelectFeature?: (featureId: string) => void;
}

export function FeatureContextSection({ feature, onSelectFeature }: FeatureContextSectionProps) {
  if (!feature) return null;

  return (
    <DetailCard icon={FileStack} title="Mission Context" className="mb-4">
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => onSelectFeature?.(feature.id)}
          className="text-left w-full hover:opacity-80"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">{feature.title}</span>
            <span className={`text-xs px-2 py-0.5 rounded ${
              feature.status === 'done' ? 'glass-badge glass-badge-done' :
              feature.status === 'in_progress' ? 'glass-badge glass-badge-active' :
              feature.status === 'review' ? 'glass-badge glass-badge-review' :
              feature.status === 'failed' ? 'glass-badge glass-badge-blocked' :
              'glass-badge glass-badge-low'
            }`}>
              {feature.status.replace('_', ' ')}
            </span>
          </div>
        </button>
        {feature.description && (
          <p className="text-xs text-muted-foreground">{feature.description}</p>
        )}
        {feature.acceptanceCriteria && (
          <div className="mt-2">
            <span className="text-xs font-medium text-muted-foreground">Acceptance Criteria:</span>
            <p className="text-xs text-muted-foreground mt-1">{feature.acceptanceCriteria}</p>
          </div>
        )}
      </div>
    </DetailCard>
  );
}
