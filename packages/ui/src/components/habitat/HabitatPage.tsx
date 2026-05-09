import React, { useEffect, useState, useCallback, useRef, useMemo, Suspense } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useBoardStore } from '../../store/habitatStore.js';
import { useModalStore } from '../../store/modalStore.js';
import { useSSE } from '../../hooks/useSSE.js';
import { useSSENotifications } from '../../hooks/useSSENotifications.js';
import { usePresence } from '../../hooks/usePresence.js';
import { useIsMobile } from '../../hooks/useMediaQuery.js';
import { api } from '../../api/index.js';
import { Board } from './Habitat.js';
import { AgentPanel } from './AgentPanel.js';
import { FilterBar } from './FilterBar.js';
import { StatsModal } from './StatsModal.js';
import { ColumnSettingsDialog } from './ColumnSettingsDialog.js';
import { BoardSettingsDialog } from './HabitatSettingsDialog.js';
import { CreateColumnDialog } from './CreateColumnDialog.js';
import { Button } from '../ui/Button.js';
import { HelpDrawer } from '../ui/HelpDrawer.js';
import { HelpContent } from '../ui/HelpContent.js';
import { BulkActionBar } from './BulkActionBar.js';
import { MobileNav } from './MobileNav.js';
import { Plus, Users, BarChart3, Settings, HelpCircle, Activity, Eye, CheckSquare, Square, Menu, GitBranch } from 'lucide-react';
import type { Column } from '../../types/index.js';
import { useRegisterDrawerBridge } from '../layout/DrawerBridgeContext.js';
import { SkeletonCard } from '../ui/SkeletonCard.js';

const CreateTaskForm = React.lazy(() =>
  import('./CreateTaskForm.js').then((m) => ({ default: m.CreateTaskForm }))
);
const CreateFeatureForm = React.lazy(() =>
  import('./CreateMissionForm.js').then((m) => ({ default: m.CreateFeatureForm }))
);
const DependencyGraphModal = React.lazy(() =>
  import('./DependencyGraphModal.js').then((m) => ({ default: m.DependencyGraphModal }))
);

const PAGE_SIZE = 50;

export function BoardPage() {
  const { boardId } = useParams<{ boardId: string }>();
  const navigate = useNavigate();
  const { board, setBoard, setAgents, isLoading, setLoading, setError, updateColumn, updateBoard, addColumn, removeColumn, columns, columnPagination, setColumnPagination, setColumnLoadingMore, clearColumnPagination, presence, isBulkSelectMode, setBulkSelectMode } =
    useBoardStore();
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [showCreateFeature, setShowCreateFeature] = useState(false);
  const [showAgentPanel, setShowAgentPanel] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [settingsColumn, setSettingsColumn] = useState<Column | null>(null);
  const [showBoardSettings, setShowBoardSettings] = useState(false);
  const [showCreateColumn, setShowCreateColumn] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showDepGraph, setShowDepGraph] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();
  const registerDrawerBridge = useRegisterDrawerBridge();

  useSSE(boardId ?? '');
  useSSENotifications();
  usePresence(boardId);

  const drawerCallbacks = useMemo(() => ({
    onDeployAgent: () => setShowAgentPanel(true),
    onOpenStats: () => setShowStats(true),
    onOpenAgents: () => setShowAgentPanel(true),
    onOpenDependencies: () => setShowDepGraph(true),
  }), []);

  useEffect(() => registerDrawerBridge(drawerCallbacks), [drawerCallbacks, registerDrawerBridge]);

  useEffect(() => {
    function isInputFocused() {
      const el = document.activeElement;
      return el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.tagName === 'SELECT';
    }

    function closeTopmostDialog() {
      if (showCreateTask) { setShowCreateTask(false); return; }
      if (showCreateFeature) { setShowCreateFeature(false); return; }
      if (showAgentPanel) { setShowAgentPanel(false); return; }
      if (showStats) { setShowStats(false); return; }
      if (showBoardSettings) { setShowBoardSettings(false); return; }
      if (showCreateColumn) { setShowCreateColumn(false); return; }
      if (helpOpen) { setHelpOpen(false); return; }
      if (showDepGraph) { setShowDepGraph(false); return; }
      if (settingsColumn) { setSettingsColumn(null); return; }
      if (useModalStore.getState().isOpen) { return; }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (isInputFocused()) return;
      switch (e.key) {
        case 'n':
        case 'N':
          e.preventDefault();
          setShowCreateTask(true);
          break;
        case '?':
          e.preventDefault();
          setHelpOpen(prev => !prev);
          break;
        case '/':
          e.preventDefault();
          searchRef.current?.focus();
          break;
        case 'Escape':
          closeTopmostDialog();
          break;
        case 'd':
        case 'D':
          e.preventDefault();
          setShowDepGraph(true);
          break;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showCreateTask, showCreateFeature, showAgentPanel, showStats, showBoardSettings, showCreateColumn, helpOpen, settingsColumn, showDepGraph]);

  const loadColumnTasks = useCallback(async (colId: string, offset: number = 0) => {
    if (!boardId) return;
    try {
      const result = await api.features.list(boardId, {
        limit: PAGE_SIZE,
        offset,
      });
      const colFeatures = result.features.filter((f) => f.columnId === colId);
      const hasMore = result.features.length >= PAGE_SIZE;
      if (offset === 0) {
        setColumnPagination(colId, {
          features: colFeatures,
          total: hasMore ? colFeatures.length + 1 : undefined,
          offset: 0,
        });
      } else {
        const existing = useBoardStore.getState().columnPagination[colId];
        const totalCount = (existing?.features.length ?? 0) + colFeatures.length;
        useBoardStore.getState().appendColumnFeatures(colId, colFeatures, hasMore ? totalCount + 1 : undefined);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, [boardId, setColumnPagination, setError]);

  const loadBoard = useCallback(async () => {
    if (!boardId) return;
    setLoading(true);
    setError(null);
    clearColumnPagination();
    try {
      const [boardData, agentsData, firstPage] = await Promise.all([
        api.boards.get(boardId),
        api.agents.list(),
        api.features.list(boardId, { limit: PAGE_SIZE, offset: 0 }),
      ]);
      setBoard(
        boardData.board,
        boardData.columns ?? [],
        boardData.features ?? []
      );
      setAgents(agentsData);

      const firstPageFeatures = firstPage.features;

      for (const col of boardData.columns ?? []) {
        const colFeatures = firstPageFeatures.filter((f: any) => f.columnId === col.id);
        setColumnPagination(col.id, {
          features: colFeatures,
          total: undefined,
          offset: 0,
        });
      }

      setLoading(false);

      if (firstPageFeatures.length >= PAGE_SIZE && firstPage.total > PAGE_SIZE) {
        const remainingPromises: Promise<{ features: any[]; total: number }>[] = [];
        for (let off = PAGE_SIZE; off < firstPage.total; off += PAGE_SIZE) {
          remainingPromises.push(api.features.list(boardId, { limit: PAGE_SIZE, offset: off }));
        }
        const results = await Promise.allSettled(remainingPromises);
        const remainingFeatures = results
          .filter((r): r is PromiseFulfilledResult<{ features: any[]; total: number }> => r.status === 'fulfilled')
          .flatMap((r) => r.value.features);

        const allFeatures = [...firstPageFeatures, ...remainingFeatures];
        for (const col of boardData.columns ?? []) {
          const colFeatures = allFeatures.filter((f: any) => f.columnId === col.id);
          setColumnPagination(col.id, {
            features: colFeatures,
            total: undefined,
            offset: 0,
          });
        }
      }
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }, [boardId, setBoard, setAgents, setLoading, setError, clearColumnPagination, setColumnPagination]);

  useEffect(() => {
    loadBoard();
  }, [loadBoard]);

  const handleLoadMoreColumn = useCallback(async (columnId: string) => {
    const pagination = columnPagination[columnId];
    if (!pagination || pagination.isLoadingMore) return;
    const nextOffset = pagination.offset + PAGE_SIZE;
    setColumnLoadingMore(columnId, true);
    try {
      const result = await api.features.list(boardId!, {
        limit: PAGE_SIZE,
        offset: nextOffset,
      });
      const colFeatures = result.features.filter((f) => f.columnId === columnId);
      const hasMore = result.features.length >= PAGE_SIZE;
      useBoardStore.getState().appendColumnFeatures(columnId, colFeatures, hasMore ? (pagination.features.length + colFeatures.length + 1) : undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setColumnLoadingMore(columnId, false);
    }
  }, [boardId, columnPagination, setColumnLoadingMore, setError]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!boardId) {
    return (
      <div className="flex h-full items-center justify-center text-on-surface-variant">
        Habitat not found.
      </div>
    );
  }

  return (
    <>
      <div className="flex h-full flex-col overflow-hidden p-2 pb-20 md:p-6 md:pb-6">
        <div className="mb-2 md:mb-4 glass-panel p-3 md:p-4 rounded-lg space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 md:gap-3 min-w-0">
              <Link to="/" className="text-xs text-on-surface-variant hover:text-on-surface whitespace-nowrap">
                Habitats
              </Link>
              <span className="text-on-surface-variant text-xs">/</span>
              <span className="text-xs font-medium text-on-surface truncate">{board?.name ?? 'Habitat'}</span>
              {board && (
                <button
                  type="button"
                  onClick={() => setShowBoardSettings(true)}
                  className="rounded p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors"
                  title="Habitat settings"
                >
                  <Settings className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {isMobile ? (
              <button
                type="button"
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="rounded p-2 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
              >
                <Menu className="h-5 w-5" />
              </button>
            ) : (
              <div className="flex items-center gap-1.5">
                {presence.length > 0 && (
                  <div className="flex items-center gap-1.5 rounded-md bg-surface-container-high px-2 py-1 text-xs text-on-surface-variant">
                    <Eye className="h-3.5 w-3.5" />
                    <span>{presence.length}</span>
                    <div className="ml-1 flex -space-x-1.5">
                      {presence.slice(0, 3).map((p) => (
                        <div
                          key={p.sessionId}
                          className="flex h-5 w-5 items-center justify-center rounded-full border border-surface bg-[var(--agent-blue)] text-[9px] font-bold text-[var(--on-surface)]"
                          title={p.userName ?? p.agentName ?? 'Unknown'}
                        >
                          {(p.userName ?? p.agentName ?? '?').slice(0, 2).toUpperCase()}
                        </div>
                      ))}
                      {presence.length > 3 && (
                        <div className="flex h-5 w-5 items-center justify-center rounded-full border border-surface bg-surface-container-highest text-[9px] font-bold text-on-surface-variant">
                          +{presence.length - 3}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setHelpOpen(true)}
                  className="rounded p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors"
                  title="Help"
                >
                  <HelpCircle className="h-3.5 w-3.5" />
                </button>
                <div className="w-px h-5 bg-outline-variant mx-0.5" />
                <Button variant="outline" size="sm" onClick={() => setShowStats(true)}>
                  <BarChart3 className="h-4 w-4" />
                  Stats
                </Button>
                <Button variant="outline" size="sm" onClick={() => setShowAgentPanel(true)}>
                  <Users className="h-4 w-4" />
                  Agents
                </Button>
                <Button variant="outline" size="sm" onClick={() => navigate('/activity')}>
                  <Activity className="h-4 w-4" />
                  Activity
                </Button>
                <div className="w-px h-5 bg-outline-variant mx-0.5" />
                <Button variant="outline" size="sm" onClick={() => setShowDepGraph(true)}>
                  <GitBranch className="h-4 w-4" />
                  Dependencies
                </Button>
                {isBulkSelectMode ? (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => {
                      setBulkSelectMode(false);
                    }}
                  >
                    <CheckSquare className="h-4 w-4" />
                    Done Selecting
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      useModalStore.getState().closeModal();
                      setBulkSelectMode(true);
                    }}
                  >
                    <Square className="h-4 w-4" />
                    Bulk Select
                  </Button>
                )}
                <div className="w-px h-5 bg-outline-variant mx-0.5" />
                <Button variant="outline" size="sm" onClick={() => setShowCreateFeature(true)}>
                  <Plus className="h-4 w-4" />
                  Add Mission
                </Button>
              </div>
            )}
          </div>
        </div>

        {isMobile && mobileMenuOpen && (
          <div className="mb-2 flex flex-col gap-2 glass-card p-3 animate-fade-in">
            <div className="flex items-center justify-between">
              <span className="text-sm text-on-surface-variant">Help</span>
              <button
                type="button"
                onClick={() => { setHelpOpen(true); setMobileMenuOpen(false); }}
                className="flex items-center gap-2 rounded border border-outline-variant px-3 py-1.5 text-sm text-on-surface"
              >
                <HelpCircle className="h-4 w-4" />
                Shortcuts
              </button>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-on-surface-variant">Dependencies</span>
              <button
                type="button"
                onClick={() => { setShowDepGraph(true); setMobileMenuOpen(false); }}
                className="flex items-center gap-2 rounded border border-outline-variant px-3 py-1.5 text-sm text-on-surface"
              >
                <GitBranch className="h-4 w-4" />
                Graph
              </button>
            </div>
            {isBulkSelectMode ? (
              <button
                type="button"
                onClick={() => setBulkSelectMode(false)}
                className="flex items-center gap-2 rounded border border-outline-variant px-3 py-1.5 text-sm text-on-surface"
              >
                <CheckSquare className="h-4 w-4" />
                Done Selecting
              </button>
            ) : (
              <button
                type="button"
                onClick={() => { useModalStore.getState().closeModal(); setBulkSelectMode(true); setMobileMenuOpen(false); }}
                className="flex items-center gap-2 rounded border border-outline-variant px-3 py-1.5 text-sm text-on-surface"
              >
                <Square className="h-4 w-4" />
                Bulk Select
              </button>
            )}
          </div>
        )}

        {!isMobile && presence.length > 0 && (
          <div className="mb-2 flex items-center gap-1.5 rounded-md bg-surface-container-high px-2 py-1 text-xs text-on-surface-variant w-fit md:hidden">
            <Eye className="h-3.5 w-3.5" />
            <span>{presence.length} viewing</span>
          </div>
        )}

        <FilterBar focusSearchRef={searchRef} />

        <div className="min-h-0 flex-1 overflow-hidden">
          <Board onColumnSettingsClick={(col) => setSettingsColumn(col)} onAddColumnClick={() => setShowCreateColumn(true)} presence={presence} />
        </div>

        {isBulkSelectMode && boardId && (
          <div className="sticky bottom-0 z-20 mt-3">
            <BulkActionBar boardId={boardId} />
          </div>
        )}
      </div>

      {isMobile && (
        <MobileNav
          onAddTask={() => setShowCreateTask(true)}
          onStats={() => setShowStats(true)}
          onAgents={() => setShowAgentPanel(true)}
          onBoardSettings={() => setShowBoardSettings(true)}
          boardName={board?.name}
        />
      )}

      {showAgentPanel && <AgentPanel onClose={() => setShowAgentPanel(false)} />}
      {showCreateTask && (
        <Suspense fallback={null}>
          <CreateTaskForm
            open={showCreateTask}
            onClose={() => setShowCreateTask(false)}
            boardId={boardId}
          />
        </Suspense>
      )}
      {showCreateFeature && boardId && (
        <Suspense fallback={null}>
          <CreateFeatureForm
            open={showCreateFeature}
            onClose={() => setShowCreateFeature(false)}
            boardId={boardId}
          />
        </Suspense>
      )}
      {showStats && boardId && (
        <StatsModal boardId={boardId} onClose={() => setShowStats(false)} />
      )}
      {showDepGraph && boardId && (
        <Suspense fallback={null}>
          <DependencyGraphModal
            boardId={boardId}
            onClose={() => setShowDepGraph(false)}
            onSelectFeature={(featureId) => {
              setShowDepGraph(false);
              navigate(`/features/${featureId}`);
            }}
          />
        </Suspense>
      )}
      {settingsColumn && (
        <ColumnSettingsDialog
          column={settingsColumn}
          open={!!settingsColumn}
          onClose={() => setSettingsColumn(null)}
          onUpdate={(col) => {
            updateColumn(col);
            setSettingsColumn(null);
          }}
          onDelete={(columnId) => {
            removeColumn(columnId);
            setSettingsColumn(null);
          }}
          columns={columns}
        />
      )}
      {board && showBoardSettings && (
        <BoardSettingsDialog
          board={board}
          open={showBoardSettings}
          onClose={() => setShowBoardSettings(false)}
          onUpdate={(b) => {
            updateBoard(b);
            setShowBoardSettings(false);
          }}
          onDelete={() => {
            setShowBoardSettings(false);
            navigate('/');
          }}
        />
      )}
      <HelpDrawer isOpen={helpOpen} onClose={() => setHelpOpen(false)}>
        <HelpContent />
      </HelpDrawer>
      {showCreateColumn && boardId && (
        <CreateColumnDialog
          boardId={boardId}
          open={showCreateColumn}
          onClose={() => setShowCreateColumn(false)}
          onAdd={(column) => {
            addColumn(column);
            setShowCreateColumn(false);
          }}
        />
      )}
    </>
  );
}
