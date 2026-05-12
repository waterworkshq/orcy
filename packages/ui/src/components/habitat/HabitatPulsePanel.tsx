import React, { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Plus, Loader2 } from 'lucide-react';
import { api } from '../../api/index.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { PulseFilterBar } from './PulseFilterBar.js';
import { PulseSignalCard } from './PulseSignalCard.js';
import { SIGNAL_LABELS, SIGNAL_COLORS } from '../../lib/signalConfig.js';
import type { SignalType, PostPulseInput } from '../../types/index.js';

interface HabitatPulsePanelProps {
  boardId: string;
}

export function HabitatPulsePanel({ boardId }: HabitatPulsePanelProps) {
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(false);
  const [activeTypes, setActiveTypes] = useState<SignalType[]>([]);
  const [hideAuto, setHideAuto] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);

  const queryKey = [...queryKeys.pulse.byBoard(boardId), { activeTypes, hideAuto }];

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => {
      const params: Record<string, string | number> = {};
      if (activeTypes.length > 0) {
        params.signalTypes = activeTypes.join(',');
      }
      if (hideAuto) {
        params.isAuto = 'false';
      }
      return api.pulse.listByBoard(boardId, params);
    },
    staleTime: 30 * 1000,
  });

  const pulses = data?.items ?? [];
  const total = data?.total ?? 0;

  const filtered = pulses.filter((p) => !p.replyToId);

  React.useEffect(() => {
    if (collapsed && composeOpen) setComposeOpen(false);
  }, [collapsed]);

  const toggleType = useCallback((type: SignalType) => {
    setActiveTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  }, []);

  const clearAll = useCallback(() => {
    setActiveTypes([]);
    setHideAuto(false);
  }, []);

  return (
    <div className="glass-panel rounded-lg border border-[var(--outline-variant)] overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-[var(--surface-container)]/60 hover:bg-[var(--surface-container)] transition-colors"
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 text-[var(--on-surface-variant)]" />
        ) : (
          <ChevronDown className="h-4 w-4 text-[var(--on-surface-variant)]" />
        )}
        <span className="text-xs font-semibold text-[var(--on-surface)] uppercase tracking-wider">
          Habitat Signals
        </span>
        <span className="text-[10px] text-[var(--on-surface-variant)] ml-auto">
          {total} signal{total !== 1 ? 's' : ''}
        </span>
        {!collapsed && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setComposeOpen(true); }}
            className="ml-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[var(--primary)] text-[var(--on-primary)] text-[10px] font-semibold hover:opacity-90 transition-opacity"
          >
            <Plus className="h-3 w-3" />
            Post
          </button>
        )}
      </button>

      {!collapsed && (
        <>
          <PulseFilterBar
            activeTypes={activeTypes}
            onToggleType={toggleType}
            hideAuto={hideAuto}
            onToggleHideAuto={() => setHideAuto(!hideAuto)}
            resultCount={total}
            onClearAll={clearAll}
          />

          <div className="max-h-80 overflow-y-auto p-3 space-y-2">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-[var(--on-surface-variant)]" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-[var(--on-surface-variant)] gap-2">
                <span className="text-xs">No habitat signals yet</span>
                <button
                  type="button"
                  onClick={() => setComposeOpen(true)}
                  className="text-[10px] text-[var(--primary)] hover:underline"
                >
                  Post the first signal
                </button>
              </div>
            ) : (
              filtered.map((pulse) => (
                <PulseSignalCard
                  key={pulse.id}
                  pulse={pulse}
                  missionId={pulse.missionId ?? boardId}
                  boardId={boardId}
                />
              ))
            )}
          </div>
        </>
      )}

      <HabitatPulseComposeDialog
        boardId={boardId}
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
      />
    </div>
  );
}

function HabitatPulseComposeDialog({ boardId, open, onClose }: { boardId: string; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [signalType, setSignalType] = useState<SignalType>('finding');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setSignalType('finding');
      setSubject('');
      setBody('');
      setError(null);
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: (input: PostPulseInput) => api.pulse.postHabitat(boardId, input),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.pulse.byBoard(boardId) });
      onClose();
    },
    onError: (err: Error) => {
      setError(err.message || 'Failed to post signal');
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim()) return;
    mutation.mutate({
      signalType,
      subject: subject.trim(),
      body: body.trim() || undefined,
    });
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="rounded-lg border border-[var(--outline-variant)] bg-[var(--surface)]/95 p-6 shadow-xl w-full max-w-md mx-4"
        style={{ backdropFilter: 'blur(12px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-[var(--on-surface)] mb-1">Post Habitat Signal</h3>
        <p className="text-[11px] text-[var(--on-surface-variant)] mb-4">Broadcast a signal to the entire habitat</p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {(['finding', 'blocker', 'warning', 'directive', 'context', 'question'] as SignalType[]).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setSignalType(type)}
                className={`px-2 py-1 rounded text-[10px] font-semibold uppercase tracking-wider transition-all ${
                  signalType === type ? 'ring-1' : 'bg-[var(--surface-container)] text-[var(--on-surface-variant)]'
                }`}
                style={signalType === type ? {
                  backgroundColor: `color-mix(in srgb, ${SIGNAL_COLORS[type]} 15%, transparent)`,
                  color: SIGNAL_COLORS[type],
                  borderColor: SIGNAL_COLORS[type],
                } : undefined}
              >
                {SIGNAL_LABELS[type]}
              </button>
            ))}
          </div>

          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value.slice(0, 80))}
            placeholder="Signal subject..."
            maxLength={80}
            className="w-full bg-[var(--surface-container)] border border-[var(--outline-variant)] rounded-lg px-3 py-2 text-sm text-[var(--on-surface)] placeholder:text-[var(--on-surface-variant)] focus:ring-1 focus:ring-[var(--primary)] focus:border-[var(--primary)]"
          />

          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Describe the signal..."
            rows={3}
            className="w-full bg-[var(--surface-container)] border border-[var(--outline-variant)] rounded-lg px-3 py-2 text-sm text-[var(--on-surface)] placeholder:text-[var(--on-surface-variant)] focus:ring-1 focus:ring-[var(--primary)] focus:border-[var(--primary)] resize-none"
          />

          {error && (
            <p className="text-[11px] text-[var(--error)]">{error}</p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-xs text-[var(--on-surface-variant)] hover:bg-[var(--surface-container-high)] transition-colors"
              disabled={mutation.isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!subject.trim() || mutation.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {mutation.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Posting...
                </>
              ) : (
                'Post Signal'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
