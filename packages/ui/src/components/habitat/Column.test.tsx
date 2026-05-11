import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Column } from './Column.js';
import type { Column as ColumnType, FeatureWithProgress } from '../../types/index.js';

vi.mock('@dnd-kit/core', () => ({
  useDroppable: vi.fn(() => ({ setNodeRef: vi.fn(), isOver: false })),
}));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: any) => <div>{children}</div>,
  verticalListSortingStrategy: {},
}));

vi.mock('./MissionCard.js', () => ({
  SortableFeatureCard: ({ feature }: any) => (
    <div data-testid={`feature-card-${feature.id}`}>{feature.title}</div>
  ),
}));

vi.mock('../ui/Tooltip.js', () => ({
  Tooltip: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('zustand/shallow', () => ({
  shallow: (a: any, b: any) => {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== 'object' || typeof b !== 'object') return a === b;
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => a[key] === b[key]);
  },
}));

const mockColumn: ColumnType = {
  id: 'col-1',
  name: 'In Progress',
  order: 0,
  boardId: 'board-1',
  wipLimit: 5,
  requiresClaim: false,
  autoAdvance: false,
  nextColumnId: null,
  isTerminal: false,
};

const mockFeatures: FeatureWithProgress[] = [
  {
    id: 'f1',
    title: 'Feature A',
    description: '',
    acceptanceCriteria: '',
    priority: 'high',
    status: 'in_progress',
    boardId: 'board-1',
    columnId: 'col-1',
    labels: [],
    dependsOn: [],
    blocks: [],
    displayOrder: 0,
    createdAt: '',
    updatedAt: '',
    dueAt: null,
    slaMinutes: null,
    slaDeadlineAt: null,
    createdBy: '',
    version: 1,
    actualMinutes: null,
    plannedMinutes: null,
    planningAccuracy: null,
    completedAt: null,
    isArchived: false,
    progress: {
      total: 3,
      pending: 0,
      claimed: 0,
      inProgress: 1,
      submitted: 0,
      approved: 0,
      done: 1,
      failed: 0,
      rejected: 0,
    },
  },
  {
    id: 'f2',
    title: 'Feature B',
    description: '',
    acceptanceCriteria: '',
    priority: 'medium',
    status: 'in_progress',
    boardId: 'board-1',
    columnId: 'col-1',
    labels: [],
    dependsOn: [],
    blocks: [],
    displayOrder: 1,
    createdAt: '',
    updatedAt: '',
    dueAt: null,
    slaMinutes: null,
    slaDeadlineAt: null,
    createdBy: '',
    version: 1,
    actualMinutes: null,
    plannedMinutes: null,
    planningAccuracy: null,
    completedAt: null,
    isArchived: false,
    progress: {
      total: 2,
      pending: 0,
      claimed: 0,
      inProgress: 0,
      submitted: 0,
      approved: 0,
      done: 0,
      failed: 0,
      rejected: 0,
    },
  },
];

const mockStoreState = {
  wipAlerts: {} as Record<string, { limit: number; timestamp: number }>,
  collapsedColumns: {} as Record<string, boolean>,
  toggleColumnCollapsed: vi.fn(),
};

const useBoardStoreMock = vi.fn((selector?: any) => {
  if (selector) return selector(mockStoreState);
  return mockStoreState;
});

vi.mock('../../store/habitatStore.js', () => ({
  useBoardStore: (...args: any[]) => useBoardStoreMock(...args),
}));

describe('Column', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockStoreState.wipAlerts = {};
    mockStoreState.collapsedColumns = {};
  });

  afterEach(() => {
    cleanup();
  });

  it('renders column container with glass-card class', () => {
    const { container } = render(
      <Column column={mockColumn} features={mockFeatures} onSettingsClick={vi.fn()} />
    );
    const columnEl = container.querySelector('[data-testid="column-col-1"]');
    expect(columnEl).toBeTruthy();
    expect(columnEl!.className).toContain('glass-card');
  });

  it('renders column container with ghost-border class', () => {
    const { container } = render(
      <Column column={mockColumn} features={mockFeatures} onSettingsClick={vi.fn()} />
    );
    const columnEl = container.querySelector('[data-testid="column-col-1"]');
    expect(columnEl!.className).toContain('ghost-border');
  });

  it('renders sticky header', () => {
    const { container } = render(
      <Column column={mockColumn} features={mockFeatures} onSettingsClick={vi.fn()} />
    );
    const header = container.querySelector('[data-testid="column-header-col-1"]');
    expect(header).toBeTruthy();
    expect(header!.className).toContain('sticky');
    expect(header!.className).toContain('top-0');
    expect(header!.className).toContain('z-10');
  });

  it('renders column name', () => {
    render(
      <Column column={mockColumn} features={mockFeatures} onSettingsClick={vi.fn()} />
    );
    expect(screen.getByText('In Progress')).toBeTruthy();
  });

  it('displays WIP count with glass-badge class when within limit', () => {
    const { container } = render(
      <Column column={mockColumn} features={mockFeatures} onSettingsClick={vi.fn()} />
    );
    const badge = container.querySelector('[data-testid="wip-count-col-1"]');
    expect(badge).toBeTruthy();
    expect(badge!.textContent).toBe('2/5');
    expect(badge!.className).toContain('glass-badge');
  });

  it('displays glass-badge-exceeded when WIP limit reached', () => {
    const exceededColumn = { ...mockColumn, wipLimit: 2 };
    const { container } = render(
      <Column column={exceededColumn} features={mockFeatures} onSettingsClick={vi.fn()} />
    );
    const badge = container.querySelector('[data-testid="wip-count-col-1"]');
    expect(badge).toBeTruthy();
    expect(badge!.className).toContain('glass-badge-exceeded');
  });

  it('displays glass-badge-warning when WIP at 80% threshold', () => {
    const warningColumn = { ...mockColumn, wipLimit: 5 };
    const fourFeatures = Array.from({ length: 4 }, (_, i) => ({
      ...mockFeatures[0],
      id: `f${i}`,
      title: `Feature ${i}`,
    }));
    const { container } = render(
      <Column column={warningColumn} features={fourFeatures} onSettingsClick={vi.fn()} />
    );
    const badge = container.querySelector('[data-testid="wip-count-col-1"]');
    expect(badge).toBeTruthy();
    expect(badge!.className).toContain('glass-badge-warning');
  });

  it('displays count without limit when wipLimit is null', () => {
    const noLimitColumn = { ...mockColumn, wipLimit: null };
    const { container } = render(
      <Column column={noLimitColumn} features={mockFeatures} onSettingsClick={vi.fn()} />
    );
    const badge = container.querySelector('[data-testid="wip-count-col-1"]');
    expect(badge).toBeTruthy();
    expect(badge!.textContent).toBe('2');
    expect(badge!.className).toContain('glass-badge');
    expect(badge!.className).not.toContain('glass-badge-exceeded');
  });

  it('shows glass-warning banner when WIP alert is active', () => {
    mockStoreState.wipAlerts = {
      'col-1': { limit: 5, timestamp: Date.now() },
    };
    const { container } = render(
      <Column column={mockColumn} features={mockFeatures} onSettingsClick={vi.fn()} />
    );
    const alert = container.querySelector('[data-testid="wip-alert-col-1"]');
    expect(alert).toBeTruthy();
    expect(alert!.className).toContain('glass-warning');
    expect(alert!.textContent).toContain('WIP limit (5) reached');
  });

  it('hides WIP alert banner after 5 seconds', () => {
    mockStoreState.wipAlerts = {
      'col-1': { limit: 5, timestamp: Date.now() - 6000 },
    };
    const { container } = render(
      <Column column={mockColumn} features={mockFeatures} onSettingsClick={vi.fn()} />
    );
    const alert = container.querySelector('[data-testid="wip-alert-col-1"]');
    expect(alert).toBeNull();
  });

  it('does not show WIP alert for a different column', () => {
    mockStoreState.wipAlerts = {
      'col-2': { limit: 3, timestamp: Date.now() },
    };
    const { container } = render(
      <Column column={mockColumn} features={mockFeatures} onSettingsClick={vi.fn()} />
    );
    const alert = container.querySelector('[data-testid="wip-alert-col-1"]');
    expect(alert).toBeNull();
  });

  it('renders feature cards', () => {
    render(
      <Column column={mockColumn} features={mockFeatures} onSettingsClick={vi.fn()} />
    );
    expect(screen.getByTestId('feature-card-f1')).toBeTruthy();
    expect(screen.getByTestId('feature-card-f2')).toBeTruthy();
  });

  it('renders settings button with group-hover pattern', () => {
    render(
      <Column column={mockColumn} features={mockFeatures} onSettingsClick={vi.fn()} />
    );
    const btn = screen.getByTitle('Column settings');
    expect(btn).toBeTruthy();
    expect(btn.className).toContain('group-hover:opacity-100');
  });

  it('calls onSettingsClick when settings button clicked', () => {
    const onSettings = vi.fn();
    render(
      <Column column={mockColumn} features={mockFeatures} onSettingsClick={onSettings} />
    );
    screen.getByTitle('Column settings').click();
    expect(onSettings).toHaveBeenCalledWith(mockColumn);
  });

  it('shows claim badge when column requires claim', () => {
    const claimColumn = { ...mockColumn, requiresClaim: true };
    render(
      <Column column={claimColumn} features={mockFeatures} onSettingsClick={vi.fn()} />
    );
    const claimBadge = screen.getByText('claim');
    expect(claimBadge).toBeTruthy();
    expect(claimBadge.className).toContain('glass-badge');
  });

  it('has w-80 fixed width class for desktop', () => {
    const { container } = render(
      <Column column={mockColumn} features={mockFeatures} onSettingsClick={vi.fn()} />
    );
    const columnEl = container.querySelector('[data-testid="column-col-1"]');
    expect(columnEl!.className).toContain('w-80');
    expect(columnEl!.className).toContain('shrink-0');
    expect(columnEl!.className).not.toContain('flex-1');
  });

  it('header does not contain backdrop-blur-sm', () => {
    const { container } = render(
      <Column column={mockColumn} features={mockFeatures} onSettingsClick={vi.fn()} />
    );
    const header = container.querySelector('[data-testid="column-header-col-1"]');
    expect(header!.className).not.toContain('backdrop-blur-sm');
  });

  it('header has background color class applied', () => {
    const { container } = render(
      <Column column={mockColumn} features={mockFeatures} onSettingsClick={vi.fn()} />
    );
    const header = container.querySelector('[data-testid="column-header-col-1"]');
    expect(header!.className).toContain('bg-surface-container');
  });

  it('renders column with features and visually distinct header', () => {
    const { container } = render(
      <Column column={mockColumn} features={mockFeatures} onSettingsClick={vi.fn()} />
    );
    const header = container.querySelector('[data-testid="column-header-col-1"]');
    const featureCards = container.querySelectorAll('[data-testid^="feature-card-"]');
    expect(header).toBeTruthy();
    expect(featureCards.length).toBe(2);
    expect(header!.className).toContain('bg-surface-container');
    expect(header!.className).toContain('sticky');
    expect(header!.className).not.toContain('backdrop-blur-sm');
  });

  it('does not apply w-80 when isMobile', () => {
    const { container } = render(
      <Column column={mockColumn} features={mockFeatures} onSettingsClick={vi.fn()} isMobile />
    );
    const columnEl = container.querySelector('[data-testid="column-col-1"]');
    expect(columnEl!.className).not.toContain('w-80');
    expect(columnEl!.className).toContain('flex-1');
  });

  describe('React.memo wrapping', () => {
    it('Column is wrapped in React.memo', () => {
      expect((Column as any).$$typeof).toBe(Symbol.for('react.memo'));
      expect(typeof (Column as any).type).toBe('function');
    });
  });
});
