import { DependencyGraph } from './DependencyGraph.js';
import { Button } from '../ui/Button.js';
import { X, GitBranch } from 'lucide-react';
import { FEATURE_STATUS_DOT } from '../../lib/status-maps.js';

interface DependencyGraphModalProps {
  habitatId: string;
  onClose: () => void;
  onSelectMission: (missionId: string) => void;
}

const statusLegend = [
  { label: 'Pending', color: FEATURE_STATUS_DOT.not_started },
  { label: 'In Progress', color: FEATURE_STATUS_DOT.in_progress },
  { label: 'Review', color: FEATURE_STATUS_DOT.review },
  { label: 'Done', color: FEATURE_STATUS_DOT.done },
  { label: 'Failed', color: FEATURE_STATUS_DOT.failed },
  { label: 'Unmet dep.', color: 'border-2 border-dashed border-[var(--badge-review)] bg-transparent' },
];

export function DependencyGraphModal({ habitatId, onClose, onSelectMission }: DependencyGraphModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in">
      <div className="glass-modal w-full max-w-6xl max-h-[85vh] md:max-h-[90vh] overflow-hidden flex flex-col mobile-dialog-full" data-testid="dependency-graph-modal">
        <div className="cool-glow flex items-center justify-between p-4 ghost-border-b relative">
          <div className="flex items-center gap-2 relative z-10">
            <GitBranch className="h-4 w-4 text-on-surface-variant" />
            <h2 className="text-lg font-semibold text-on-surface">Dependency Graph</h2>
          </div>
          <div className="flex items-center gap-4 relative z-10">
            <div className="hidden md:flex items-center gap-3">
              {statusLegend.map((s) => (
                <div key={s.label} className="flex items-center gap-1.5">
                  <div className={`h-3 w-3 rounded-full ${s.color}`} />
                  <span className="text-xs text-on-surface-variant">{s.label}</span>
                </div>
              ))}
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} data-testid="close-button">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="flex-1 overflow-hidden">
          <DependencyGraph habitatId={habitatId} onSelectMission={onSelectMission} />
        </div>
      </div>
    </div>
  );
}
