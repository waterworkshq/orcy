import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { X, Bookmark, ChevronDown, Trash2, Save, SlidersHorizontal } from 'lucide-react';
import { useBoardStore } from '../../store/habitatStore.js';
import { useIsMobile } from '../../hooks/useMediaQuery.js';
import { api } from '../../api/index.js';

interface SavedFilter {
  id: string;
  boardId: string;
  userId: string;
  name: string;
  filterConfig: Record<string, unknown>;
  isBuiltin: boolean;
  createdAt: string;
}

export const FilterBar = React.memo(function FilterBar({ focusSearchRef }: { focusSearchRef?: React.RefObject<HTMLInputElement | null> }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const agents = useBoardStore((s) => s.agents);
  const board = useBoardStore((s) => s.board);
  const internalSearchRef = useRef<HTMLInputElement>(null);
  const searchRef = focusSearchRef ?? internalSearchRef;
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(true);
  const viewsRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (viewsRef.current && !viewsRef.current.contains(e.target as Node)) {
        setViewsOpen(false);
        setShowSaveInput(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const boardId = board?.id;
  useEffect(() => {
    if (!boardId || !api.savedFilters) return;
    api.savedFilters.list(boardId)
      .then((filters) => setSavedFilters(filters as unknown as SavedFilter[]))
      .catch(() => {});
  }, [boardId]);

  function updateFilter(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams);
    if (value === null || value === '') {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    setSearchParams(next);
  }

  function clearFilters() {
    setSearchParams(new URLSearchParams());
  }

  function applySavedFilter(filter: SavedFilter) {
    const next = new URLSearchParams();
    const config = filter.filterConfig;
    if (config.search) next.set('search', config.search as string);
    if (config.priority) next.set('priority', config.priority as string);
    if (config.status) next.set('status', config.status as string);
    if (config.assignedAgentId) next.set('assignedAgentId', config.assignedAgentId as string);
    if (config.columnId) next.set('columnId', config.columnId as string);
    setSearchParams(next);
    setViewsOpen(false);
  }

  async function handleSave() {
    if (!board || !saveName.trim()) return;
    const config: Record<string, unknown> = {};
    if (searchParams.get('search')) config.search = searchParams.get('search');
    if (searchParams.get('priority')) config.priority = searchParams.get('priority');
    if (searchParams.get('status')) config.status = searchParams.get('status');
    if (searchParams.get('assignedAgentId')) config.assignedAgentId = searchParams.get('assignedAgentId');
    if (searchParams.get('columnId')) config.columnId = searchParams.get('columnId');

    try {
      const filter = await api.savedFilters.create(board.id, { name: saveName.trim(), filterConfig: config });
      setSavedFilters((prev) => [...prev, filter as unknown as SavedFilter]);
      setSaveName('');
      setShowSaveInput(false);
    } catch (err) {
      console.warn('[FilterBar] Failed to save filter:', err);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.savedFilters.delete(id);
      setSavedFilters((prev) => prev.filter((f) => f.id !== id));
    } catch (err) {
      console.warn('[FilterBar] Failed to delete saved filter:', err);
    }
  }

  const hasFilters = searchParams.toString().length > 0;
  const selectedAgentId = searchParams.get('assignedAgentId');

  return (
    <div className="mb-4">
      {isMobile && (
        <button
          type="button"
          onClick={() => setFiltersExpanded(!filtersExpanded)}
          className="flex w-full items-center justify-between rounded-md border border-outline-variant bg-surface-container px-3 py-2 text-sm text-on-surface mb-2"
        >
          <span className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4" />
            Filters
          </span>
          {hasFilters && (
            <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] text-primary-foreground">Active</span>
          )}
        </button>
      )}
      <div className={`flex flex-wrap items-center gap-2 ${isMobile && !filtersExpanded ? 'hidden' : ''}`}>
      <input
        ref={searchRef}
        type="text"
        value={searchParams.get('search') ?? ''}
        onChange={(e) => updateFilter('search', e.target.value)}
        placeholder="Search features..."
        className="h-9 flex-1 min-w-[200px] rounded-md border border-outline-variant bg-surface-container px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-primary/40 mobile-full-width"
      />

      <select
        value={selectedAgentId ?? ''}
        onChange={(e) => updateFilter('assignedAgentId', e.target.value || null)}
        className="h-9 rounded-md border border-outline-variant bg-surface-container px-2 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40"
      >
        <option value="">All Agents</option>
        <option value="unassigned">Unassigned</option>
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>

      <div className="flex gap-1">
        {['critical', 'high', 'medium', 'low'].map((p) => (
          <button
            type="button"
            key={p}
            onClick={() => updateFilter('priority', searchParams.get('priority') === p ? null : p)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors mobile-touch-target ${
              searchParams.get('priority') === p
                ? 'bg-primary-container text-primary border border-primary/30'
                : 'glass-badge hover:bg-surface-container-highest'
            }`}
          >
            {p}
          </button>
        ))}
      </div>

      <div className="flex gap-1">
        {['not_started', 'in_progress', 'review', 'done', 'failed'].map((s) => (
          <button
            type="button"
            key={s}
            onClick={() => updateFilter('status', searchParams.get('status') === s ? null : s)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors mobile-touch-target ${
              searchParams.get('status') === s
                ? 'bg-primary-container text-primary border border-primary/30'
                : 'glass-badge hover:bg-surface-container-highest'
            }`}
          >
            {s.replace('_', ' ')}
          </button>
        ))}
      </div>

      <div ref={viewsRef} className="relative">
        <button
          type="button"
          onClick={() => setViewsOpen(!viewsOpen)}
          className="flex h-9 items-center gap-1 rounded-md border border-outline-variant bg-surface-container px-2.5 py-1 text-sm text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors"
        >
          <Bookmark className="h-3.5 w-3.5" />
          Views
          <ChevronDown className="h-3 w-3" />
        </button>

        {viewsOpen && (
          <div className="absolute left-0 top-full z-50 mt-1 w-56 glass-card p-1 shadow-lg">
            {savedFilters.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">No saved views</div>
            )}
            {savedFilters.map((filter) => (
              <div
                key={filter.id}
                className="flex items-center justify-between rounded px-2 py-1.5 text-sm text-on-surface hover:bg-surface-container-high"
              >
                <button
                  type="button"
                  onClick={() => applySavedFilter(filter)}
                  className="flex-1 text-left"
                >
                  <span className="truncate">{filter.name}</span>
                  {filter.isBuiltin && (
                    <span className="ml-1 text-[10px] text-muted-foreground">built-in</span>
                  )}
                </button>
                {!filter.isBuiltin && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleDelete(filter.id); }}
                    className="ml-1 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
            <div className="border-t border-border pt-1">
              {showSaveInput ? (
                <div className="flex items-center gap-1 px-1">
                  <input
                    type="text"
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
                    placeholder="View name..."
                    className="h-7 flex-1 rounded border border-outline-variant bg-surface-container px-2 text-xs text-on-surface focus:outline-none focus:ring-1 focus:ring-primary/40"
                  />
                  <button
                    type="button"
                    onClick={handleSave}
                    className="flex h-7 items-center justify-center rounded bg-primary-container px-2 text-primary hover:bg-primary-container/80"
                  >
                    <Save className="h-3 w-3" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowSaveInput(true)}
                  className="w-full rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  + Save Current View
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {hasFilters && (
        <button
          type="button"
          onClick={clearFilters}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground mobile-touch-target"
        >
          <X className="h-3 w-3" />
          Clear
        </button>
      )}
      </div>
    </div>
  );
});
