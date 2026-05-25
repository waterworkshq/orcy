import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Drawer } from '../ui/Drawer.js';
import { Button } from '../ui/Button.js';
import { api } from '../../api/index.js';
import { Archive, ChevronRight } from 'lucide-react';
import { Badge } from '../ui/Badge.js';
import type { MissionWithProgress } from '../../types/index.js';

interface ArchivedFeaturesPanelProps {
  habitatId: string;
  onClose: () => void;
}

const taskStatusVariant: Record<string, string> = {
  pending: 'pending',
  claimed: 'claimed',
  in_progress: 'in_progress',
  submitted: 'submitted',
  approved: 'approved',
  rejected: 'rejected',
  done: 'done',
  failed: 'failed',
};

export function ArchivedFeaturesPanel({ habitatId, onClose }: ArchivedFeaturesPanelProps) {
  const navigate = useNavigate();
  const [features, setFeatures] = useState<MissionWithProgress[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [_total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  const limit = 50;

  const loadFeatures = useCallback(async (reset = false) => {
    setIsLoading(true);
    try {
      const newOffset = reset ? 0 : offset;
      const { features: loadedFeatures, total: totalCount } = await api.missions.list(habitatId, {
        limit,
        offset: newOffset,
        isArchived: true,
      });
      if (reset) {
        setFeatures(loadedFeatures);
        setOffset(limit);
      } else {
        setFeatures([...features, ...loadedFeatures]);
        setOffset(newOffset + limit);
      }
      setTotal(totalCount);
      setHasMore(newOffset + loadedFeatures.length < totalCount);
    } catch (err) {
      console.warn('Failed to load archived features:', err);
    } finally {
      setIsLoading(false);
    }
  }, [habitatId, offset, features]);

  useEffect(() => {
    loadFeatures(true);
  }, [habitatId]);

  const handleFeatureClick = (missionId: string) => {
    onClose();
    navigate(`/features/${missionId}`);
  };

  return (
    <Drawer open={true} onClose={onClose} className="w-full max-w-md flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-2">
          <Archive className="h-5 w-5 text-muted-foreground" />
          <h2 className="font-semibold">Archived Features</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {features.length === 0 && !isLoading ? (
          <div className="flex flex-col items-center justify-center h-32 text-muted-foreground text-sm gap-2">
            <Archive className="h-8 w-8 opacity-20" />
            <p>No archived features</p>
          </div>
        ) : (
          <div className="space-y-2">
            {features.map((feature) => (
              <button
                key={feature.id}
                type="button"
                onClick={() => handleFeatureClick(feature.id)}
                className="w-full flex flex-col gap-1 rounded-md border p-3 text-left hover:bg-accent transition-colors"
              >
                <div className="flex items-center justify-between min-w-0 w-full gap-2">
                  <span className="font-medium truncate">{feature.title}</span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                  <Badge variant={taskStatusVariant[feature.status] as any} className="text-[10px] px-1.5 py-0 shrink-0">
                    {feature.status.replace('_', ' ')}
                  </Badge>
                  <Badge variant={feature.priority as any} className="text-[10px] px-1.5 py-0 shrink-0">
                    {feature.priority}
                  </Badge>
                  {feature.progress?.total ? (
                    <span>
                      {feature.progress.done}/{feature.progress.total} ({Math.round((feature.progress.done / feature.progress.total) * 100)}%)
                    </span>
                  ) : null}
                </div>
              </button>
            ))}
            {hasMore && (
              <div className="flex justify-center py-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => loadFeatures(false)}
                  disabled={isLoading}
                >
                  {isLoading ? 'Loading...' : 'Load more'}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
}
