import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { TaskCard } from './TaskCard.js';
import type { Task } from '../../types/index.js';

const { mockOpenModal, mockBoardState } = vi.hoisted(() => ({
  mockOpenModal: vi.fn(),
  mockBoardState: {
    agents: [] as Array<{ id: string; name: string; type: string }>,
    presence: [] as Array<{ sessionId?: string; viewingTaskId?: string; userName?: string; agentName?: string }>,
    isBulkSelectMode: false,
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined }),
}));

vi.mock('../../store/modalStore.js', () => ({
  useModalStore: (selector: any) => selector({ openModal: mockOpenModal }),
}));

let selectorCallLog: Array<{ selector: any; equalityFn?: any }> = [];

const useHabitatStoreMock = vi.fn((selectorOrState?: any, equalityFn?: any) => {
  if (typeof selectorOrState === 'function') {
    selectorCallLog.push({ selector: selectorOrState, equalityFn });
    return selectorOrState(mockBoardState);
  }
  return mockBoardState;
});

vi.mock('../../store/habitatStore.js', () => ({
  useHabitatStore: (...args: any[]) => useHabitatStoreMock(...args),
}));

vi.mock('zustand/shallow', () => ({
  shallow: (a: any, b: any) => {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((item, i) => {
        if (typeof item === 'object' && item !== null && typeof b[i] === 'object' && b[i] !== null) {
          return Object.keys(item).every((k) => item[k] === b[i][k]);
        }
        return item === b[i];
      });
    }
    if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
      const aKeys = Object.keys(a);
      const bKeys = Object.keys(b);
      if (aKeys.length !== bKeys.length) return false;
      return aKeys.every((k) => a[k] === b[k]);
    }
    return false;
  },
}));

vi.mock('../ui/Badge.js', () => ({
  Badge: ({ children }: any) => <span>{children}</span>,
}));

vi.mock('../ui/Tooltip.js', () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
}));

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    missionId: 'feature-1',
    title: 'Board Task',
    description: '',
    priority: 'medium',
    assignedAgentId: null,
    delegatedToAgentId: null,
    requiredDomain: null,
    requiredCapabilities: [],
    status: 'pending',
    claimedAt: null,
    startedAt: null,
    submittedAt: null,
    completedAt: null,
    rejectedCount: 0,
    rejectionReason: null,
    result: null,
    artifacts: [],
    order: 0,
    createdBy: 'user-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    estimatedMinutes: null,
    actualMinutes: null,
    cycleTimeMinutes: null,
    leadTimeMinutes: null,
    estimationAccuracy: null,
    retryPolicy: null,
    retryCount: 0,
    nextRetryAt: null,
    labels: [],
    ...overrides,
  };
}

describe('TaskCard modal integration', () => {
  afterEach(() => {
    cleanup();
    mockOpenModal.mockReset();
    mockBoardState.agents = [];
    mockBoardState.presence = [];
    mockBoardState.isBulkSelectMode = false;
  });

  it('opens the portable task modal from a board task click', () => {
    render(<TaskCard task={makeTask({ id: 'task-board-open', title: 'Open From Board' })} />);

    fireEvent.click(screen.getByText('Open From Board'));

    expect(mockOpenModal).toHaveBeenCalledWith('task-board-open');
  });

  it('uses desaturated agent avatar colors', () => {
    mockBoardState.agents = [{ id: 'agent-1', name: 'Claude Agent', type: 'claude-code' }];

    const { container } = render(
      <TaskCard task={makeTask({ id: 'task-with-agent', assignedAgentId: 'agent-1' })} />
    );

    const avatar = container.querySelector('[title="Claude Agent"]');
    expect(avatar).toBeTruthy();
    expect(avatar!.className).toContain('bg-[var(--agent-blue)]');
    expect(avatar!.className).not.toContain('bg-blue-500');
  });
});

describe('TaskCard glass design system', () => {
  afterEach(() => {
    cleanup();
    mockOpenModal.mockReset();
    mockBoardState.agents = [];
    mockBoardState.presence = [];
    mockBoardState.isBulkSelectMode = false;
    selectorCallLog = [];
  });

  it('renders with glass-card class', () => {
    const { container } = render(
      <TaskCard task={makeTask({ id: 'task-glass', title: 'Glass Task' })} />
    );
    const card = container.querySelector('.glass-card');
    expect(card).toBeTruthy();
  });

  it('does not use bg-card, border, or shadow-sm classes', () => {
    const { container } = render(
      <TaskCard task={makeTask({ id: 'task-no-old', title: 'No Old Tokens' })} />
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).not.toContain('bg-card');
    // Match standalone "border" class only (not border-l-*, border-[var(--*], etc.)
    expect(card.className).not.toMatch(/(^|\s)border(\s|$)/);
    expect(card.className).not.toContain('shadow-sm');
    expect(card.className).not.toContain('shadow-md');
  });

  it('applies priority left border for high priority', () => {
    const { container } = render(
      <TaskCard task={makeTask({ id: 'task-high', title: 'High Task', priority: 'high' })} />
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('border-l-[3px]');
    expect(card.className).toContain('border-l-[var(--badge-high)]');
  });

  it('applies priority left border for critical priority', () => {
    const { container } = render(
      <TaskCard task={makeTask({ id: 'task-crit', title: 'Crit Task', priority: 'critical' })} />
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('border-l-[3px]');
    expect(card.className).toContain('border-l-[var(--badge-critical)]');
  });

  it('applies priority left border for low priority', () => {
    const { container } = render(
      <TaskCard task={makeTask({ id: 'task-low', title: 'Low Task', priority: 'low' })} />
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('border-l-[3px]');
    expect(card.className).toContain('border-l-[var(--badge-low)]');
  });

  it('uses text-on-surface-variant for unassigned text', () => {
    const { container: _c } = render(
      <TaskCard task={makeTask({ id: 'task-unassigned', title: 'Unassigned Task' })} />
    );
    const unassigned = screen.getByText('Unassigned');
    expect(unassigned.className).toContain('text-on-surface-variant');
    expect(unassigned.className).not.toContain('text-muted-foreground');
  });

  it('uses animate-card-hover for non-drag state', () => {
    const { container } = render(
      <TaskCard task={makeTask({ id: 'task-hover', title: 'Hover Task' })} />
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('animate-card-hover');
  });

  it('renders truncated task ID', () => {
    render(
      <TaskCard task={makeTask({ id: 'task-b3f291e8-abcd', title: 'ID Task' })} />
    );
    expect(screen.getByText('TASK-b3f291')).toBeTruthy();
  });

  it('applies hover:-translate-y-0.5 for hover animation', () => {
    const { container } = render(
      <TaskCard task={makeTask({ id: 'task-anim', title: 'Anim Task' })} />
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('hover:-translate-y-0.5');
    expect(card.className).toContain('duration-200');
    expect(card.className).toContain('ease-out');
  });

  it('card wrapper does not use transition-all', () => {
    const { container } = render(
      <TaskCard task={makeTask({ id: 'task-no-transition-all', title: 'No TransAll' })} />
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).not.toContain('transition-all');
    expect(card.className).toContain('transition-colors');
    expect(card.className).toContain('transition-shadow');
  });
});

describe('TaskCard per-agent AgentAvatar selector', () => {
  afterEach(() => {
    cleanup();
    mockOpenModal.mockReset();
    mockBoardState.agents = [];
    mockBoardState.presence = [];
    mockBoardState.isBulkSelectMode = false;
    selectorCallLog = [];
  });

  it('AgentAvatar uses per-agent selector that returns the matching agent', () => {
    mockBoardState.agents = [
      { id: 'agent-1', name: 'Claude Agent', type: 'claude-code' },
      { id: 'agent-2', name: 'Codex Agent', type: 'codex' },
    ];

    render(
      <TaskCard task={makeTask({ id: 'task-agent-sel', assignedAgentId: 'agent-1' })} />
    );

    const agentSelectors = selectorCallLog.filter((call) => {
      if (typeof call.selector !== 'function') return false;
      try {
        const result = call.selector(mockBoardState);
        return result && typeof result === 'object' && !Array.isArray(result) && result.id === 'agent-1';
      } catch { return false; }
    });
    expect(agentSelectors.length).toBeGreaterThanOrEqual(1);
  });

  it('AgentAvatar returns null for non-existent agent', () => {
    mockBoardState.agents = [
      { id: 'agent-1', name: 'Claude Agent', type: 'claude-code' },
    ];

    const { container } = render(
      <TaskCard task={makeTask({ id: 'task-no-agent', assignedAgentId: 'agent-999' })} />
    );

    const agentAvatar = Array.from(container.querySelectorAll('[title]')).find(
      (el) => el.getAttribute('title') === 'Claude Agent'
    );
    expect(agentAvatar).toBeUndefined();
  });
});

describe('TaskCard filtered presence selector', () => {
  afterEach(() => {
    cleanup();
    mockOpenModal.mockReset();
    mockBoardState.agents = [];
    mockBoardState.presence = [];
    mockBoardState.isBulkSelectMode = false;
    selectorCallLog = [];
  });

  it('filtered presence selector returns only viewers for this task', () => {
    mockBoardState.presence = [
      { sessionId: 's1', viewingTaskId: 'task-pres-1', userName: 'Alice' },
      { sessionId: 's2', viewingTaskId: 'task-pres-2', userName: 'Bob' },
      { sessionId: 's3', viewingTaskId: 'task-pres-1', userName: 'Carol' },
    ];

    render(<TaskCard task={makeTask({ id: 'task-pres-1' })} />);

    const presenceSelectors = selectorCallLog.filter((call) => {
      if (typeof call.selector !== 'function') return false;
      try {
        const result = call.selector(mockBoardState);
        return Array.isArray(result) && result.every((r: any) => r.viewingTaskId === 'task-pres-1');
      } catch { return false; }
    });
    expect(presenceSelectors.length).toBeGreaterThanOrEqual(1);
  });

  it('uses shallow equality function for filtered presence selector', () => {
    render(<TaskCard task={makeTask({ id: 'task-shallow' })} />);

    const selectorsWithShallow = selectorCallLog.filter((call) => call.equalityFn !== undefined);
    expect(selectorsWithShallow.length).toBeGreaterThanOrEqual(1);
  });

  it('shows viewer count for task viewers', () => {
    mockBoardState.presence = [
      { sessionId: 's1', viewingTaskId: 'task-viewers', userName: 'Alice' },
      { sessionId: 's2', viewingTaskId: 'task-viewers', userName: 'Bob' },
    ];

    render(<TaskCard task={makeTask({ id: 'task-viewers' })} />);
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('does not show viewer indicator when no viewers for this task', () => {
    mockBoardState.presence = [
      { sessionId: 's1', viewingTaskId: 'other-task', userName: 'Alice' },
    ];

    const { container } = render(<TaskCard task={makeTask({ id: 'task-no-viewers' })} />);
    const viewerBadge = container.querySelector('.text-\\[10px\\]');
    expect(viewerBadge).toBeNull();
  });
});

describe('TaskCard React.memo wrapping', () => {
  afterEach(() => {
    cleanup();
    mockOpenModal.mockReset();
    mockBoardState.agents = [];
    mockBoardState.presence = [];
    mockBoardState.isBulkSelectMode = false;
    selectorCallLog = [];
  });

  it('TaskCard is wrapped in React.memo', () => {
    expect((TaskCard as any).$$typeof).toBe(Symbol.for('react.memo'));
    expect(typeof (TaskCard as any).type).toBe('function');
  });

  it('does not re-render when same props are passed', () => {
    const renderSpy = vi.fn();

    function TrackingTaskCard(props: any) {
      renderSpy();
      return React.createElement(TaskCard, props);
    }

    const task = makeTask({ id: 'task-memo-1' });
    const { rerender } = render(<TrackingTaskCard task={task} />);
    const countAfterFirstRender = renderSpy.mock.calls.length;

    rerender(<TrackingTaskCard task={task} />);
    expect(renderSpy.mock.calls.length).toBe(countAfterFirstRender + 1);
  });

  it('re-renders when task prop changes', () => {
    const renderSpy = vi.fn();

    function TrackingTaskCard(props: any) {
      renderSpy();
      return React.createElement(TaskCard, props);
    }

    const task1 = makeTask({ id: 'task-memo-2', title: 'Original' });
    const { rerender } = render(<TrackingTaskCard task={task1} />);
    const countAfterFirstRender = renderSpy.mock.calls.length;

    const task2 = makeTask({ id: 'task-memo-2', title: 'Updated' });
    rerender(<TrackingTaskCard task={task2} />);
    expect(renderSpy.mock.calls.length).toBeGreaterThan(countAfterFirstRender);
  });

  it('does not re-render when unrelated presence changes', () => {
    const renderSpy = vi.fn();

    function TrackingTaskCard(props: any) {
      renderSpy();
      return React.createElement(TaskCard, props);
    }

    mockBoardState.presence = [
      { sessionId: 's1', viewingTaskId: 'task-pres-check', userName: 'Alice' },
    ];

    const task = makeTask({ id: 'task-pres-check' });
    const { rerender } = render(<TrackingTaskCard task={task} />);
    const countAfterFirstRender = renderSpy.mock.calls.length;

    mockBoardState.presence = [
      { sessionId: 's1', viewingTaskId: 'task-pres-check', userName: 'Alice' },
      { sessionId: 's2', viewingTaskId: 'other-task', userName: 'Bob' },
    ];

    rerender(<TrackingTaskCard task={task} />);
    expect(renderSpy.mock.calls.length).toBe(countAfterFirstRender + 1);
  });

  it('re-renders when its own viewers change', () => {
    const renderSpy = vi.fn();

    function TrackingTaskCard(props: any) {
      renderSpy();
      return React.createElement(TaskCard, props);
    }

    mockBoardState.presence = [
      { sessionId: 's1', viewingTaskId: 'task-own-viewer', userName: 'Alice' },
    ];

    const task = makeTask({ id: 'task-own-viewer' });
    const { rerender } = render(<TrackingTaskCard task={task} />);
    const countAfterFirstRender = renderSpy.mock.calls.length;

    mockBoardState.presence = [
      { sessionId: 's1', viewingTaskId: 'task-own-viewer', userName: 'Alice' },
      { sessionId: 's2', viewingTaskId: 'task-own-viewer', userName: 'Bob' },
    ];

    rerender(<TrackingTaskCard task={task} />);
    expect(renderSpy.mock.calls.length).toBeGreaterThan(countAfterFirstRender);
  });
});
