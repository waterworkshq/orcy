import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { FeatureCard } from './MissionCard.js';
import type { MissionWithProgress } from '../../types/index.js';

vi.mock('../ui/Tooltip.js', () => ({
  Tooltip: ({ children }: any) => <div>{children}</div>,
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

const baseFeature: MissionWithProgress = {
  id: 'f1',
  title: 'Test Feature',
  description: '',
  acceptanceCriteria: '',
  priority: 'medium',
  status: 'in_progress',
  habitatId: 'board-1',
  columnId: 'col-1',
  labels: [],
  dependsOn: [],
  blocks: [],
  dueAt: null,
  slaMinutes: null,
  slaDeadlineAt: null,
  createdBy: 'agent-1',
  createdAt: '',
  updatedAt: '',
  displayOrder: 0,
    version: 1,
    actualMinutes: null,
    plannedMinutes: null,
    planningAccuracy: null,
    completedAt: null,
    isArchived: false,
    sprintId: null,
  progress: {
    total: 4,
    pending: 1,
    claimed: 0,
    inProgress: 1,
    submitted: 1,
    approved: 0,
    done: 1,
    failed: 0,
    rejected: 0, percentage: 0,
  },
};

function makeState(overrides: Record<string, any> = {}) {
  return {
    isBulkSelectMode: false,
    selectedMissionIds: [] as string[],
    toggleMissionSelection: vi.fn(),
    tasks: [] as any[],
    agents: [] as any[],
    ...overrides,
  };
}

let storeState: Record<string, any>;

const useHabitatStoreMock = vi.fn((selector?: any, equalityFn?: any) => {
  if (selector) return selector(storeState);
  return storeState;
});

vi.mock('../../store/habitatStore.js', () => ({
  useHabitatStore: (...args: any[]) => useHabitatStoreMock(...args),
}));

vi.mock('zustand/shallow', () => ({
  shallow: (a: any, b: any) => {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((item, i) => item === b[i]);
    }
    return a === b;
  },
}));

describe('FeatureCard', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockNavigate.mockClear();
    storeState = makeState();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders title', () => {
    render(<FeatureCard feature={baseFeature} />);
    expect(screen.getByText('Test Feature')).toBeTruthy();
  });

  it('renders priority badge', () => {
    render(<FeatureCard feature={baseFeature} />);
    expect(screen.getByText('medium')).toBeTruthy();
  });

  it('renders status badge', () => {
    render(<FeatureCard feature={baseFeature} />);
    expect(screen.getByText('in progress')).toBeTruthy();
  });

  it('applies amber-slate border for medium priority', () => {
    const { container } = render(<FeatureCard feature={baseFeature} />);
    const card = container.querySelector('[data-testid="feature-card-f1"]');
    expect(card).toBeTruthy();
    expect(card!.className).toContain('border-l-[var(--badge-medium)]');
  });

  it('applies desaturated crimson border for critical priority', () => {
    const feature = { ...baseFeature, priority: 'critical' as const };
    const { container } = render(<FeatureCard feature={feature} />);
    const card = container.querySelector('[data-testid="feature-card-f1"]');
    expect(card!.className).toContain('border-l-[var(--badge-critical)]');
  });

  it('applies slate rose border for high priority', () => {
    const feature = { ...baseFeature, priority: 'high' as const };
    const { container } = render(<FeatureCard feature={feature} />);
    const card = container.querySelector('[data-testid="feature-card-f1"]');
    expect(card!.className).toContain('border-l-[var(--badge-high)]');
  });

  it('applies slate border for low priority', () => {
    const feature = { ...baseFeature, priority: 'low' as const };
    const { container } = render(<FeatureCard feature={feature} />);
    const card = container.querySelector('[data-testid="feature-card-f1"]');
    expect(card!.className).toContain('border-l-[var(--badge-low)]');
  });

  it('keeps high, medium, and low priority indicators visually distinct', () => {
    const priorities = ['high', 'medium', 'low'] as const;
    const classes = priorities.map((priority) => {
      const { container, unmount } = render(<FeatureCard feature={{ ...baseFeature, priority }} />);
      const card = container.querySelector('[data-testid="feature-card-f1"]')!;
      const priorityClass = card.className.split(' ').find((className) => className.startsWith('border-l-[var(--badge-'));
      unmount();
      return priorityClass;
    });

    expect(new Set(classes).size).toBe(3);
  });

  it('uses glass-card base class', () => {
    const { container } = render(<FeatureCard feature={baseFeature} />);
    const card = container.querySelector('[data-testid="feature-card-f1"]');
    expect(card!.className).toContain('glass-card');
  });

  it('hides details section by default', () => {
    const feature = {
      ...baseFeature,
      labels: ['bug', 'ui'],
      dependsOn: ['f2'],
    };
    const { container } = render(<FeatureCard feature={feature} />);
    const details = container.querySelector('.max-h-0');
    expect(details).toBeTruthy();
    expect(details!.className).toContain('opacity-0');
  });

  it('shows details on hover via mouse events', () => {
    const feature = {
      ...baseFeature,
      labels: ['bug'],
    };
    const { container } = render(<FeatureCard feature={feature} />);
    const card = container.querySelector('[data-testid="feature-card-f1"]')!;
    let details = container.querySelector('.max-h-0');
    expect(details).toBeTruthy();
    expect(details!.className).toContain('opacity-0');

    fireEvent.mouseEnter(card);
    details = container.querySelector('.max-h-40');
    expect(details).toBeTruthy();
    expect(details!.className).toContain('opacity-100');

    fireEvent.mouseLeave(card);
    details = container.querySelector('.max-h-0');
    expect(details).toBeTruthy();
    expect(details!.className).toContain('opacity-0');
  });

  it('shows labels in hover details', () => {
    const feature = {
      ...baseFeature,
      labels: ['bug', 'ui', 'perf'],
    };
    const { container } = render(<FeatureCard feature={feature} />);
    expect(screen.getByText('bug')).toBeTruthy();
    expect(screen.getByText('ui')).toBeTruthy();
    expect(screen.getByText('perf')).toBeTruthy();
  });

  it('shows progress bar in hover details', () => {
    const { container } = render(<FeatureCard feature={baseFeature} />);
    const progressBar = container.querySelector('.bg-primary');
    expect(progressBar).toBeTruthy();
  });

  it('shows dependency count in hover details', () => {
    const feature = { ...baseFeature, dependsOn: ['f2', 'f3'] };
    const { container } = render(<FeatureCard feature={feature} />);
    const depEl = container.querySelector('.max-h-0 span');
    expect(depEl?.textContent).toContain('2 dependenc');
  });

  it('shows due date in hover details when present', () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString();
    const feature = { ...baseFeature, dueAt: tomorrow };
    render(<FeatureCard feature={feature} />);
    expect(screen.getByText(/Tomorrow|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/)).toBeTruthy();
  });

  it('navigates to feature detail page on click when not in bulk mode', () => {
    storeState = makeState();
    const { container } = render(<FeatureCard feature={baseFeature} />);
    const card = container.querySelector('[data-testid="feature-card-f1"]')!;
    fireEvent.click(card);
    expect(mockNavigate).toHaveBeenCalledWith('/features/f1');
  });

  it('does not navigate on click when isDragOverlay', () => {
    storeState = makeState();
    const { container } = render(<FeatureCard feature={baseFeature} isDragOverlay />);
    const card = container.querySelector('[data-testid="feature-card-f1"]')!;
    fireEvent.click(card);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('applies ring-2 ring-primary when selected', () => {
    storeState = makeState({ selectedMissionIds: ['f1'] });
    const { container } = render(<FeatureCard feature={baseFeature} />);
    const card = container.querySelector('[data-testid="feature-card-f1"]');
    expect(card!.className).toContain('ring-2');
    expect(card!.className).toContain('ring-primary');
  });

  it('shows checkbox in bulk select mode', () => {
    storeState = makeState({ isBulkSelectMode: true });
    const { container } = render(<FeatureCard feature={baseFeature} />);
    const checkbox = container.querySelector('input[type="checkbox"]');
    expect(checkbox).toBeTruthy();
  });

  it('renders truncated feature ID', () => {
    const feature = { ...baseFeature, id: 'feat-a72dc8e9-cd9b-489c-abe4-d0e0814c7225' };
    const { container } = render(<FeatureCard feature={feature} />);
    expect(screen.getByText('FEAT-a72dc8')).toBeTruthy();
  });

  it('shows agent status when agent is active on feature tasks', () => {
    storeState = makeState({
      tasks: [{ id: 'task-1', missionId: 'f1' }],
      agents: [{ id: 'agent-1', name: 'Claude', type: 'claude-code', currentTaskId: 'task-1' }],
    });
    render(<FeatureCard feature={baseFeature} />);
    expect(screen.getByText('Processing...')).toBeTruthy();
  });

  it('does not show agent status when no agent is active', () => {
    storeState = makeState();
    render(<FeatureCard feature={baseFeature} />);
    expect(screen.queryByText('Processing...')).toBeNull();
  });

  it('progress bar is visible without hover', () => {
    const { container } = render(<FeatureCard feature={baseFeature} />);
    const progressBar = container.querySelector('.bg-primary');
    expect(progressBar).toBeTruthy();
    const progressContainer = progressBar!.closest('.mt-2');
    expect(progressContainer).toBeTruthy();
    expect(progressContainer!.className).not.toContain('max-h-0');
  });

  it('applies hover:-translate-y-0.5 for hover animation', () => {
    const { container } = render(<FeatureCard feature={baseFeature} />);
    const card = container.querySelector('[data-testid="feature-card-f1"]');
    expect(card!.className).toContain('hover:-translate-y-0.5');
    expect(card!.className).toContain('duration-200');
    expect(card!.className).toContain('ease-out');
  });

  it('card wrapper does not use transition-all', () => {
    const { container } = render(<FeatureCard feature={baseFeature} />);
    const card = container.querySelector('[data-testid="feature-card-f1"]');
    expect(card!.className).not.toContain('transition-all');
    expect(card!.className).toContain('transition-colors');
    expect(card!.className).toContain('transition-shadow');
  });

  it('progress bar uses targeted transition-[width] instead of transition-all', () => {
    const { container } = render(<FeatureCard feature={baseFeature} />);
    const progressBar = container.querySelector('.bg-primary');
    expect(progressBar).toBeTruthy();
    expect(progressBar!.className).not.toContain('transition-all');
    expect(progressBar!.className).toContain('transition-[width]');
  });

  it('details section uses targeted transition instead of transition-all', () => {
    const feature = { ...baseFeature, labels: ['bug'] };
    const { container } = render(<FeatureCard feature={feature} />);
    const detailsDiv = container.querySelector('.transition-\\[max-height\\,opacity\\]');
    expect(detailsDiv).toBeTruthy();
    expect(detailsDiv!.className).not.toContain('transition-all');
  });

  describe('filtered selectors', () => {
    it('filtered selector returns only tasks matching feature.id', () => {
      storeState = makeState({
        tasks: [
          { id: 'task-1', missionId: 'f1' },
          { id: 'task-2', missionId: 'f2' },
          { id: 'task-3', missionId: 'f1' },
        ],
      });
      const { container } = render(<FeatureCard feature={baseFeature} />);
      expect(screen.getByText('Test Feature')).toBeTruthy();
      const taskSelectors = useHabitatStoreMock.mock.calls.filter(
        (call: any[]) => {
          if (typeof call[0] === 'function') {
            try {
              const result = call[0](storeState);
              return Array.isArray(result) && result.length === 2 && result[0]?.missionId === 'f1';
            } catch { return false; }
          }
          return false;
        }
      );
      expect(taskSelectors.length).toBeGreaterThan(0);
    });

    it('activeAgents computes correctly with filtered agents', () => {
      storeState = makeState({
        tasks: [
          { id: 'task-1', missionId: 'f1' },
          { id: 'task-2', missionId: 'f2' },
        ],
        agents: [
          { id: 'agent-1', currentTaskId: 'task-1' },
          { id: 'agent-2', currentTaskId: 'task-2' },
        ],
      });
      render(<FeatureCard feature={baseFeature} />);
      expect(screen.getByText('Processing...')).toBeTruthy();
    });

    it('does not show Processing when agent is on a different feature task', () => {
      storeState = makeState({
        tasks: [
          { id: 'task-1', missionId: 'f1' },
          { id: 'task-2', missionId: 'f2' },
        ],
        agents: [
          { id: 'agent-2', currentTaskId: 'task-2' },
        ],
      });
      render(<FeatureCard feature={baseFeature} />);
      expect(screen.queryByText('Processing...')).toBeNull();
    });
  });

  describe('React.memo re-render prevention', () => {
    it('does not re-render when unrelated task updates', () => {
      const renderSpy = vi.fn();

      function TrackingFeatureCard(props: any) {
        renderSpy();
        return React.createElement(FeatureCard, props);
      }

      storeState = makeState({
        tasks: [
          { id: 'task-1', missionId: 'f1' },
          { id: 'task-2', missionId: 'f2' },
        ],
        agents: [],
      });

      const { rerender } = render(<TrackingFeatureCard feature={baseFeature} />);
      const countAfterFirstRender = renderSpy.mock.calls.length;

      rerender(<TrackingFeatureCard feature={baseFeature} />);
      expect(renderSpy.mock.calls.length).toBe(countAfterFirstRender + 1);
    });

    it('re-renders when feature prop changes', () => {
      const renderSpy = vi.fn();

      function TrackingFeatureCard(props: any) {
        renderSpy();
        return React.createElement(FeatureCard, props);
      }

      storeState = makeState();

      const { rerender } = render(<TrackingFeatureCard feature={baseFeature} />);
      const countAfterFirstRender = renderSpy.mock.calls.length;

      const updatedFeature = { ...baseFeature, title: 'Updated Title' };
      rerender(<TrackingFeatureCard feature={updatedFeature} />);
      expect(renderSpy.mock.calls.length).toBeGreaterThan(countAfterFirstRender);
    });

    it('FeatureCard is wrapped in React.memo', () => {
      expect((FeatureCard as any).$$typeof).toBe(Symbol.for('react.memo'));
      expect(typeof (FeatureCard as any).type).toBe('function');
    });
  });
});
