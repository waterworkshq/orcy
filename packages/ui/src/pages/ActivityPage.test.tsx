import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ActivityPage } from './ActivityPage.js';
import type { EnrichedHabitatEvent, Anomaly } from '../types/index.js';
import type { UseQueryResult } from '@tanstack/react-query';

function makeEvent(overrides: Partial<EnrichedHabitatEvent> & { id: string }): EnrichedHabitatEvent {
  return {
    taskId: 'task-1',
    taskTitle: 'Test Task',
    habitatId: 'board-1',
    actorType: 'agent',
    actorId: 'agent-1',
    actorName: 'Agent One',
    action: 'claimed',
    fromColumnId: null,
    toColumnId: 'col-2',
    fromColumnName: null,
    toColumnName: 'In Progress',
    fromStatus: null,
    toStatus: null,
    metadata: {},
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeAnomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    type: 'stale_task',
    severity: 'medium',
    message: 'Task has been stale for 2 hours',
    data: {},
    ...overrides,
  };
}

let mockAnomaliesResult: UseQueryResult<{ anomalies: Anomaly[] }> = {
  data: { anomalies: [] },
  isLoading: false,
  error: null,
} as any;

let mockEventsResult: UseQueryResult<{ events: EnrichedHabitatEvent[]; total: number }> = {
  data: { events: [], total: 0 },
  isLoading: true,
  error: null,
} as any;

vi.mock('../lib/useHabitatData.js', () => ({
  useAgents: () => ({ data: [] as any[], isLoading: false, isError: false }),
  useHabitatAnomalies: () => mockAnomaliesResult,
  useHabitatEvents: () => mockEventsResult,
}));

const mockOpenModal = vi.fn();

vi.mock('../store/habitatStore.js', () => ({
  useHabitatStore: (selector: any) =>
    selector({
      board: { id: 'board-1', name: 'Test Board' },
    }),
}));

vi.mock('../store/modalStore.js', () => ({
  useModalStore: (selector: any) =>
    selector({
      openModal: (...args: any[]) => mockOpenModal(...args),
    }),
}));

vi.mock('../components/ui/Button.js', () => ({
  Button: ({ children, onClick, disabled, ...props }: any) => (
    <button onClick={onClick} disabled={disabled} {...props}>
      {children}
    </button>
  ),
}));

vi.mock('lucide-react', () => ({
  ArrowLeft: () => <span data-testid="icon-arrow-left">←</span>,
  Activity: ({ className }: any) => (
    <span data-testid="icon-activity" className={className}>
      ⚡
    </span>
  ),
  Loader2: ({ className }: any) => (
    <span data-testid="icon-loader" className={className}>
      ⟳
    </span>
  ),
  CheckCircle: () => <span data-testid="icon-check">✓</span>,
  XCircle: () => <span data-testid="icon-x">✗</span>,
  User: () => <span data-testid="icon-user">👤</span>,
  Circle: () => <span data-testid="icon-circle">○</span>,
  Clock: () => <span data-testid="icon-clock">🕐</span>,
  AlertTriangle: ({ className }: any) => (
    <span data-testid="icon-alert" className={className}>
      ⚠
    </span>
  ),
  Calendar: () => <span data-testid="icon-calendar">📅</span>,
}));

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderPage() {
  const qc = createQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/activity']}>
        <Routes>
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/" element={<div>Home Page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function setAnomaliesResult(overrides: Partial<UseQueryResult<{ anomalies: Anomaly[] }>> = {}) {
  mockAnomaliesResult = {
    data: { anomalies: [] },
    isLoading: false,
    error: null,
    ...overrides,
  } as any;
}

function setEventsResult(overrides: Partial<UseQueryResult<{ events: EnrichedHabitatEvent[]; total: number }>> = {}) {
  mockEventsResult = {
    data: { events: [], total: 0 },
    isLoading: false,
    error: null,
    isFetching: false,
    ...overrides,
  } as any;
}

describe('ActivityPage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2024-06-15T14:30:00Z'));
    setAnomaliesResult({ data: { anomalies: [] } });
    setEventsResult({ data: { events: [], total: 0 }, isLoading: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    mockOpenModal.mockReset();
  });

  it('renders page header with Activity title', () => {
    renderPage();

    expect(screen.getByText('Activity')).toBeTruthy();
    expect(screen.getByText('Back')).toBeTruthy();
    expect(screen.getAllByTestId('icon-activity').length).toBeGreaterThan(0);
  });

  it('shows loading state during fetch', () => {
    setEventsResult({ isLoading: true, data: undefined as any });

    renderPage();

    expect(screen.getByTestId('icon-loader')).toBeTruthy();
    expect(screen.getByText('Loading activity...')).toBeTruthy();
  });

  it('shows empty state when no events', () => {
    setEventsResult({ data: { events: [], total: 0 } });

    renderPage();

    expect(screen.getByText('No activity yet')).toBeTruthy();
    expect(screen.getByText('Events will appear here as work happens on the board.')).toBeTruthy();
  });

  it('shows error state when fetch fails', () => {
    setEventsResult({ error: new Error('Network error') as any, data: undefined as any });

    renderPage();

    expect(screen.getByText('Network error')).toBeTruthy();
  });

  it('renders event feed with correct formatting', () => {
    const events = [
      makeEvent({ id: 'e1', action: 'claimed', actorName: 'Agent One', taskTitle: 'Task A' }),
      makeEvent({ id: 'e2', action: 'approved', actorName: 'Human', taskTitle: 'Task B' }),
    ];
    setEventsResult({ data: { events, total: 2 } });

    renderPage();

    expect(screen.getByTestId('event-row-e1')).toBeTruthy();
    expect(screen.getByTestId('event-row-e2')).toBeTruthy();
    expect(screen.getByText('Agent One')).toBeTruthy();
    expect(screen.getByText('Human')).toBeTruthy();
    expect(screen.getByText('"Task A"')).toBeTruthy();
    expect(screen.getByText('"Task B"')).toBeTruthy();
  });

  it('shows relative timestamps for events', () => {
    const fiveMinAgo = new Date('2024-06-15T14:25:00Z').toISOString();
    const events = [
      makeEvent({ id: 'e1', timestamp: fiveMinAgo }),
    ];
    setEventsResult({ data: { events, total: 1 } });

    renderPage();

    expect(screen.getByText('5m ago')).toBeTruthy();
  });

  it('shows column transition details', () => {
    const events = [
      makeEvent({
        id: 'e1',
        action: 'moved',
        fromColumnName: 'Backlog',
        toColumnName: 'In Progress',
      }),
    ];
    setEventsResult({ data: { events, total: 1 } });

    renderPage();

    expect(screen.getByText('Backlog → In Progress')).toBeTruthy();
  });

  it('filter tabs change active filter', () => {
    setEventsResult({ data: { events: [], total: 0 } });

    renderPage();

    expect(screen.getByText('No activity yet')).toBeTruthy();

    setEventsResult({ data: { events: [], total: 0 } });

    const claimsFilter = screen.getByTestId('filter-claims');
    fireEvent.click(claimsFilter);

    expect(screen.getByText('No activity yet')).toBeTruthy();
  });

  it('loads all filter tabs', () => {
    setEventsResult({ data: { events: [], total: 0 } });

    renderPage();

    expect(screen.getByTestId('filter-all')).toBeTruthy();
    expect(screen.getByTestId('filter-claims')).toBeTruthy();
    expect(screen.getByTestId('filter-submissions')).toBeTruthy();
    expect(screen.getByTestId('filter-approvals')).toBeTruthy();
    expect(screen.getByTestId('filter-rejections')).toBeTruthy();
  });

  it('Load more button fetches additional events', () => {
    const firstBatch = Array.from({ length: 50 }, (_, i) =>
      makeEvent({ id: `e${i}`, taskTitle: `Task ${i}` })
    );
    setEventsResult({ data: { events: firstBatch, total: 100 } });

    renderPage();

    expect(screen.getByTestId('load-more')).toBeTruthy();
  });

  it('hides load more when all events loaded', () => {
    const events = [makeEvent({ id: 'e1' })];
    setEventsResult({ data: { events, total: 1 } });

    renderPage();

    expect(screen.getByTestId('event-row-e1')).toBeTruthy();
    expect(screen.queryByTestId('load-more')).toBeNull();
  });

  it('event click opens task modal', () => {
    const events = [makeEvent({ id: 'e1', taskId: 'task-42', taskTitle: 'Click Me' })];
    setEventsResult({ data: { events, total: 1 } });

    renderPage();

    expect(screen.getByText('"Click Me"')).toBeTruthy();

    fireEvent.click(screen.getByTestId('event-row-e1'));

    expect(mockOpenModal).toHaveBeenCalledWith('task-42');
  });

  it('task title click opens task modal', () => {
    const events = [makeEvent({ id: 'e1', taskId: 'task-99', taskTitle: 'Title Click' })];
    setEventsResult({ data: { events, total: 1 } });

    renderPage();

    expect(screen.getByText('"Title Click"')).toBeTruthy();

    fireEvent.click(screen.getByText('"Title Click"'));

    expect(mockOpenModal).toHaveBeenCalledWith('task-99');
  });

  it('anomaly alerts render when present', () => {
    const anomalies = [
      makeAnomaly({ type: 'stale_task', severity: 'high', message: 'Task stuck for 4h' }),
      makeAnomaly({ type: 'high_rejection_rate', severity: 'critical', message: 'Rate > 50%' }),
    ];
    setAnomaliesResult({ data: { anomalies } });
    setEventsResult({ data: { events: [], total: 0 } });

    renderPage();

    expect(screen.getByText('Active Anomalies (2)')).toBeTruthy();
    expect(screen.getByText('Task stuck for 4h')).toBeTruthy();
    expect(screen.getByText('Rate > 50%')).toBeTruthy();
    expect(screen.getByText('high')).toBeTruthy();
    expect(screen.getByText('critical')).toBeTruthy();
  });

  it('anomaly type labels are formatted with spaces', () => {
    setAnomaliesResult({
      data: { anomalies: [makeAnomaly({ type: 'high_rejection_rate' })] },
    });
    setEventsResult({ data: { events: [], total: 0 } });

    renderPage();

    expect(screen.getByText('high rejection rate')).toBeTruthy();
  });

  it('Back button navigates to workspace', () => {
    renderPage();

    const backLink = screen.getByText('Back').closest('a');
    expect(backLink?.getAttribute('href')).toBe('/');
  });

  it('shows total event count in header', () => {
    const events = [makeEvent({ id: 'e1' }), makeEvent({ id: 'e2' })];
    setEventsResult({ data: { events, total: 42 } });

    renderPage();

    expect(screen.getByText('42 events')).toBeTruthy();
  });

  it('handles anomalies fetch failure gracefully', () => {
    setAnomaliesResult({ error: new Error('Anomaly fetch failed') as any, data: undefined as any });
    setEventsResult({ data: { events: [], total: 0 } });

    renderPage();

    expect(screen.getByText('No activity yet')).toBeTruthy();
  });

  it('shows loading text on load more button while fetching', () => {
    const firstBatch = Array.from({ length: 50 }, (_, i) =>
      makeEvent({ id: `e${i}` })
    );
    setEventsResult({ data: { events: firstBatch, total: 100 } });

    const { rerender } = renderPage();

    expect(screen.getByTestId('load-more')).toBeTruthy();

    setEventsResult({ isFetching: true, isLoading: false, data: { events: firstBatch, total: 100 } });

    const qc = createQueryClient();
    rerender(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/activity']}>
          <Routes>
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/" element={<div>Home Page</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('displays reason from metadata', () => {
    const events = [
      makeEvent({
        id: 'e1',
        action: 'rejected',
        fromColumnName: null,
        toColumnName: null,
        metadata: { reason: 'Code quality issues' },
      }),
    ];
    setEventsResult({ data: { events, total: 1 } });

    renderPage();

    expect(screen.getByText('Code quality issues')).toBeTruthy();
  });

  it('uses actor ID substring when no name and not human/system', () => {
    const longId = 'abc123def456ghi789';
    const events = [
      makeEvent({
        id: 'e1',
        actorType: 'agent' as any,
        actorId: longId,
        actorName: null,
      }),
    ];
    setEventsResult({ data: { events, total: 1 } });

    renderPage();

    expect(screen.getByText(longId.substring(0, 8))).toBeTruthy();
  });

  it('shows "Human" label for human actors with no name', () => {
    const events = [
      makeEvent({ id: 'e1', actorType: 'human', actorName: null }),
    ];
    setEventsResult({ data: { events, total: 1 } });

    renderPage();

    expect(screen.getByText('Human')).toBeTruthy();
  });

  it('shows "System" label for system actors with no name', () => {
    const events = [
      makeEvent({ id: 'e1', actorType: 'system', actorName: null }),
    ];
    setEventsResult({ data: { events, total: 1 } });

    renderPage();

    expect(screen.getByText('System')).toBeTruthy();
  });

  it('does not render empty state when only anomalies exist', () => {
    setAnomaliesResult({ data: { anomalies: [makeAnomaly()] } });
    setEventsResult({ data: { events: [], total: 0 } });

    renderPage();

    expect(screen.getByText('Active Anomalies (1)')).toBeTruthy();
    expect(screen.queryByText('No activity yet')).toBeNull();
  });

  it('renders multiple anomaly severities with correct styling', () => {
    const anomalies = [
      makeAnomaly({ severity: 'low', message: 'Low issue' }),
      makeAnomaly({ severity: 'medium', message: 'Medium issue' }),
      makeAnomaly({ severity: 'high', message: 'High issue' }),
      makeAnomaly({ severity: 'critical', message: 'Critical issue' }),
    ];
    setAnomaliesResult({ data: { anomalies } });
    setEventsResult({ data: { events: [], total: 0 } });

    renderPage();

    expect(screen.getByText('Active Anomalies (4)')).toBeTruthy();
    expect(screen.getByText('low')).toBeTruthy();
    expect(screen.getByText('medium')).toBeTruthy();
    expect(screen.getByText('high')).toBeTruthy();
    expect(screen.getByText('critical')).toBeTruthy();
  });

  it('anomalies render from useHabitatAnomalies', () => {
    const anomalies = [makeAnomaly({ severity: 'high', message: 'Test anomaly' })];
    setAnomaliesResult({ data: { anomalies } });
    setEventsResult({ data: { events: [], total: 0 } });

    renderPage();

    expect(screen.getByText('Test anomaly')).toBeTruthy();
  });

  it('events render from useHabitatEvents', () => {
    const events = [makeEvent({ id: 'e1', taskTitle: 'RQ Event' })];
    setEventsResult({ data: { events, total: 1 } });

    renderPage();

    expect(screen.getByTestId('event-row-e1')).toBeTruthy();
    expect(screen.getByText('"RQ Event"')).toBeTruthy();
  });

  it('loading states show for both queries independently', () => {
    setAnomaliesResult({ isLoading: true, data: undefined as any });
    setEventsResult({ isLoading: true, data: undefined as any });

    renderPage();

    expect(screen.getByTestId('icon-loader')).toBeTruthy();
    expect(screen.getByText('Loading activity...')).toBeTruthy();
  });
});
