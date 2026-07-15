import React from 'react';
import { DetailCard } from '../ui/DetailCard.js';
import { FileStack } from 'lucide-react';
import { FEATURE_STATUS_BADGE, getStatusBadge } from '../../lib/status-maps.js';

interface MissionContextData {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  priority: string;
  status: string;
}

interface MissionContextSectionProps {
  mission: MissionContextData | null;
  onSelectMission?: (missionId: string) => void;
}

export function MissionContextSection({ mission, onSelectMission }: MissionContextSectionProps) {
  if (!mission) return null;

  return (
    <DetailCard icon={FileStack} title="Mission Context" className="mb-4">
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => onSelectMission?.(mission.id)}
          className="text-left w-full hover:opacity-80"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">{mission.title}</span>
            <span className={`text-xs px-2 py-0.5 rounded ${getStatusBadge(FEATURE_STATUS_BADGE, mission.status)}`}>
              {mission.status.replace('_', ' ')}
            </span>
          </div>
        </button>
        {mission.description && (
          <p className="text-xs text-muted-foreground">{mission.description}</p>
        )}
        {mission.acceptanceCriteria && (
          <div className="mt-2">
            <span className="text-xs font-medium text-muted-foreground">Acceptance Criteria:</span>
            <p className="text-xs text-muted-foreground mt-1">{mission.acceptanceCriteria}</p>
          </div>
        )}
      </div>
    </DetailCard>
  );
}
