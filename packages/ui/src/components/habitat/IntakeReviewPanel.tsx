import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useIntakeCandidates } from '../../lib/useHabitatData.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { api } from '../../api/index.js';
import { notify } from '../../lib/toast.js';
import { Button } from '../ui/Button.js';
import { ExternalLink, ArrowRight, EyeOff, HelpCircle, Loader2, Filter, ChevronRight } from 'lucide-react';
import type { ExternalIntakeReviewStatus, IntegrationProvider } from '../../types/index.js';

interface IntakeReviewPanelProps {
  habitatId: string;
}

function providerBadge(provider: IntegrationProvider): { label: string; color: string } {
  switch (provider) {
    case 'jira': return { label: 'Jira', color: 'bg-blue-100 text-blue-800' };
    case 'linear': return { label: 'Linear', color: 'bg-violet-100 text-violet-800' };
    case 'github': return { label: 'GitHub', color: 'bg-gray-100 text-gray-800' };
    default: return { label: provider, color: 'bg-muted' };
  }
}

function reviewStatusLabel(status: ExternalIntakeReviewStatus): { label: string; color: string } {
  switch (status) {
    case 'new': return { label: 'New', color: 'bg-blue-50 text-blue-700' };
    case 'needs_clarification': return { label: 'Needs Clarification', color: 'bg-yellow-50 text-yellow-700' };
    case 'ready': return { label: 'Ready', color: 'bg-green-50 text-green-700' };
    case 'promoted': return { label: 'Promoted', color: 'bg-emerald-100 text-emerald-800' };
    case 'ignored': return { label: 'Ignored', color: 'bg-gray-100 text-gray-500' };
    default: return { label: status, color: 'bg-muted' };
  }
}

export function IntakeReviewPanel({ habitatId }: IntakeReviewPanelProps) {
  const qc = useQueryClient();
  const [filterProvider, setFilterProvider] = useState<IntegrationProvider | ''>('');
  const [filterStatus, setFilterStatus] = useState<ExternalIntakeReviewStatus | ''>('new');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useIntakeCandidates(habitatId, {
    ...(filterStatus ? { reviewStatus: filterStatus } : {}),
    ...(filterProvider ? { provider: filterProvider } : {}),
  });

  const candidates = data?.candidates ?? [];
  const selected = selectedId ? candidates.find((c) => c.id === selectedId) ?? null : null;

  function invalidate() {
    qc.invalidateQueries({ queryKey: queryKeys.integrations.intakeCandidates(habitatId) });
  }

  async function handleAction(candidateId: string, action: 'promote' | 'ignore' | 'needs_clarification') {
    setActing(candidateId);
    try {
      if (action === 'promote') {
        const result = await api.integrations.promoteCandidate(candidateId);
        notify.success(`Promoted to mission: ${result.mission.title}`);
      } else if (action === 'ignore') {
        await api.integrations.ignoreCandidate(candidateId);
        notify.success('Candidate ignored');
      } else {
        await api.integrations.markCandidateNeedsClarification(candidateId);
        notify.success('Marked as needs clarification');
      }
      invalidate();
      if (selectedId === candidateId && action !== 'needs_clarification') {
        setSelectedId(null);
      }
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setActing(null);
    }
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        <div className="text-center space-y-2">
          <p>Failed to load intake candidates.</p>
          <Button size="sm" variant="outline" onClick={() => refetch()}>Retry</Button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Loading candidates...
      </div>
    );
  }

  return (
    <div className="flex h-full border rounded-lg overflow-hidden">
      <div className="w-2/5 border-r flex flex-col">
        <div className="p-3 border-b space-y-2">
          <div className="flex items-center gap-2">
            <Filter className="h-3.5 w-3.5 text-muted-foreground" />
            <select
              value={filterProvider}
              onChange={(e) => setFilterProvider(e.target.value as IntegrationProvider | '')}
              className="text-xs rounded-md border bg-transparent px-2 py-1"
            >
              <option value="">All providers</option>
              <option value="jira">Jira</option>
              <option value="linear">Linear</option>
              <option value="github">GitHub</option>
            </select>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as ExternalIntakeReviewStatus | '')}
              className="text-xs rounded-md border bg-transparent px-2 py-1"
            >
              <option value="">All statuses</option>
              <option value="new">New</option>
              <option value="needs_clarification">Needs Clarification</option>
              <option value="ready">Ready</option>
              <option value="promoted">Promoted</option>
              <option value="ignored">Ignored</option>
            </select>
          </div>
          <div className="text-xs text-muted-foreground">
            {data?.total ?? 0} candidate{(data?.total ?? 0) !== 1 ? 's' : ''}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {candidates.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No intake candidates found.
            </div>
          ) : (
            candidates.map((c) => {
              const badge = providerBadge(c.provider);
              const rs = reviewStatusLabel(c.reviewStatus);
              const isSelected = selectedId === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  className={`w-full text-left p-3 border-b hover:bg-surface-container-high transition-colors ${
                    isSelected ? 'bg-primary-container/30' : ''
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-[10px] font-medium uppercase px-1.5 py-0.5 rounded ${badge.color}`}>
                      {badge.label}
                    </span>
                    <span className="text-xs font-mono text-muted-foreground">{c.externalKey}</span>
                    <span className={`ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded ${rs.color}`}>
                      {rs.label}
                    </span>
                  </div>
                  <div className="text-sm font-medium truncate">{c.sourceTitle}</div>
                  {c.sourcePriority && (
                    <div className="text-xs text-muted-foreground mt-0.5">{c.sourcePriority}</div>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col">
        {selected ? (
          <>
            <div className="p-4 border-b space-y-3">
              <div className="flex items-center gap-2">
                {(() => {
                  const badge = providerBadge(selected.provider);
                  return (
                    <span className={`text-xs font-medium uppercase px-2 py-0.5 rounded ${badge.color}`}>
                      {badge.label}
                    </span>
                  );
                })()}
                <span className="text-sm font-mono font-medium">{selected.externalKey}</span>
                <a
                  href={selected.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  Open in provider
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
              <h3 className="text-base font-semibold">{selected.sourceTitle}</h3>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {selected.sourceBody && (
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground mb-1">Description</h4>
                  <div className="text-sm whitespace-pre-wrap rounded-md bg-surface-container p-3 max-h-64 overflow-y-auto">
                    {selected.sourceBody}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                {selected.sourceKind && (
                  <div>
                    <span className="text-xs text-muted-foreground">Type</span>
                    <p className="text-sm">{selected.sourceKind}</p>
                  </div>
                )}
                {selected.sourceStatus && (
                  <div>
                    <span className="text-xs text-muted-foreground">Status</span>
                    <p className="text-sm">{selected.sourceStatus}</p>
                  </div>
                )}
                {selected.sourcePriority && (
                  <div>
                    <span className="text-xs text-muted-foreground">Priority</span>
                    <p className="text-sm">{selected.sourcePriority}</p>
                  </div>
                )}
                {selected.sourceAssignees.length > 0 && (
                  <div>
                    <span className="text-xs text-muted-foreground">Assignees</span>
                    <p className="text-sm">{selected.sourceAssignees.join(', ')}</p>
                  </div>
                )}
                {selected.sourceReporter && (
                  <div>
                    <span className="text-xs text-muted-foreground">Reporter</span>
                    <p className="text-sm">{selected.sourceReporter}</p>
                  </div>
                )}
                {selected.sourceLabels.length > 0 && (
                  <div className="col-span-2">
                    <span className="text-xs text-muted-foreground">Labels</span>
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      {selected.sourceLabels.map((label: string) => (
                        <span key={label} className="text-xs px-2 py-0.5 rounded-full bg-surface-container-high">
                          {label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {selected.promotedMissionId && (
                <div className="rounded-md bg-emerald-50 border border-emerald-200 p-3">
                  <span className="text-xs font-medium text-emerald-800">
                    Promoted to mission
                  </span>
                </div>
              )}
            </div>

            {selected.reviewStatus !== 'promoted' && selected.reviewStatus !== 'ignored' && (
              <div className="p-3 border-t flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => handleAction(selected.id, 'promote')}
                  loading={acting === selected.id}
                >
                  <ArrowRight className="h-3.5 w-3.5 mr-1" />
                  Promote to Mission
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleAction(selected.id, 'needs_clarification')}
                  loading={acting === selected.id}
                >
                  <HelpCircle className="h-3.5 w-3.5 mr-1" />
                  Needs Clarification
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleAction(selected.id, 'ignore')}
                  loading={acting === selected.id}
                >
                  <EyeOff className="h-3.5 w-3.5 mr-1" />
                  Ignore
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            <div className="text-center">
              <ChevronRight className="h-6 w-6 mx-auto mb-2 opacity-30" />
              <p>Select a candidate to review</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
