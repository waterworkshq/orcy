import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AgentsPage } from './AgentsPage.js';
import type { Agent, AgentStats } from '../types/index.js';

function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    name: 'Test Agent',
    type: 'opencode',
    domain: 'backend',
    capabilities: ['typescript', 'react'],
    status: 'idle',
    currentTaskId: null,
    createdAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    metadata: {},
    apiKeyHash: 'test-hash',
    rateLimitPerMinute: null,
    ...overrides,
  };
}

function makeStats(overrides: Partial<AgentStats> = {}): AgentStats {
  return {
    agentId: 'agent-1',
    agentName: 'Test Agent',
    tasks: { completed: 10, failed: 1, inProgress: 2, rejected: 3, totalAssigned: 16 },
    cycleTime: { averageMinutes: 45, medianMinutes: 30, count: 10 },
    throughput: { today: 2, last7d: 8, last30d: 30 },
    quality: { rejectionRate: 0.1, approvalRate: 0.9, currentStreak: 5, totalRejections: 3 },
    artifacts: { total: 15, byType: { pr: 10, commit: 5 } },
    ...overrides,
  };
}

function toListWithTasks(
  agents: Agent[],
  taskTitles?: Record<string, string>
): { agent: Agent; currentTaskTitle: string | null }[] {
  return agents.map((a) => ({
    agent: a,
    currentTaskTitle: taskTitles?.[a.id] ?? null,
  }));
}

const mockAgentsListWithTasks = vi.fn();
const mockAgentsStats = vi.fn();
const mockAgentsDelete = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

vi.mock('../api/index.js', () => ({
  api: {
    agents: {
      listWithTasks: (...args: any[]) => mockAgentsListWithTasks(...args),
      stats: (...args: any[]) => mockAgentsStats(...args),
      delete: (...args: any[]) => mockAgentsDelete(...args),
    },
  },
}));

vi.mock('../lib/toast.js', () => ({
  notify: {
    success: (...args: any[]) => mockNotifySuccess(...args),
    error: (...args: any[]) => mockNotifyError(...args),
  },
}));

vi.mock('../components/ui/AgentRegistrationDialog.js', () => ({
  AgentRegistrationDialog: ({ open, onClose, onRegistered }: any) =>
    open ? (
      <div data-testid="register-dialog">
        <button data-testid="register-close" onClick={onClose}>
          Close
        </button>
        <button data-testid="register-registered" onClick={() => onRegistered()}>
          Registered
        </button>
      </div>
    ) : null,
}));

vi.mock('../components/ui/ConfirmDialog.js', () => ({
  ConfirmDialog: ({ open, onConfirm, onCancel, title, description, confirmLabel, variant }: any) =>
    open ? (
      <div data-testid="confirm-dialog">
        <span>{title}</span>
        <span>{description}</span>
        <span>{confirmLabel}</span>
        <button data-testid="confirm-ok" onClick={onConfirm}>
          OK
        </button>
        <button data-testid="confirm-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    ) : null,
}));

vi.mock('../components/ui/Button.js', () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

vi.mock('../components/ui/Badge.js', () => ({
  Badge: ({ children, variant }: any) => (
    <span data-testid="badge" data-variant={variant}>
      {children}
    </span>
  ),
}));

vi.mock('../components/ui/Card.js', () => ({
  Card: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardHeader: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardTitle: ({ children, ...props }: any) => <h3 {...props}>{children}</h3>,
}));

vi.mock('../components/ui/Tooltip.js', () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
}));

vi.mock('lucide-react', () => ({
  ArrowLeft: () => <span data-testid="icon-arrow-left">←</span>,
  Bot: () => <span data-testid="icon-bot">🤖</span>,
  ChevronDown: () => <span data-testid="icon-chevron-down">▼</span>,
  ChevronRight: () => <span data-testid="icon-chevron-right">▶</span>,
  Loader2: ({ className }: any) => (
    <span data-testid="icon-loader" className={className}>
      ⟳
    </span>
  ),
  Plus: () => <span data-testid="icon-plus">+</span>,
  TrendingUp: () => <span data-testid="icon-trending">📈</span>,
  Users: () => <span data-testid="icon-users">👥</span>,
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/agents']}>
      <Routes>
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/" element={<div>Home Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('AgentsPage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2024-06-15T14:30:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    mockAgentsListWithTasks.mockReset();
    mockAgentsStats.mockReset();
    mockAgentsDelete.mockReset();
    mockNotifySuccess.mockReset();
    mockNotifyError.mockReset();
  });

  it('renders page header with Agents title', async () => {
    mockAgentsListWithTasks.mockResolvedValue([]);

    renderPage();

    expect(screen.getByText('Agents')).toBeTruthy();
    expect(screen.getByText('Back')).toBeTruthy();
    expect(screen.getByTestId('icon-bot')).toBeTruthy();
  });

  it('shows loading state during fetch', async () => {
    mockAgentsListWithTasks.mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.getByTestId('icon-loader')).toBeTruthy();
    expect(screen.getByText('Loading agents...')).toBeTruthy();
  });

  it('shows empty state when no agents', async () => {
    mockAgentsListWithTasks.mockResolvedValue([]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No agents registered')).toBeTruthy();
    });
    expect(screen.getByText('Register an AI agent to start working on tasks.')).toBeTruthy();
  });

  it('shows error state when fetch fails', async () => {
    mockAgentsListWithTasks.mockRejectedValue(new Error('Network error'));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeTruthy();
    });
  });

  it('renders agent cards in grid layout', async () => {
    const agents = [
      makeAgent({ id: 'a1', name: 'Agent 1' }),
      makeAgent({ id: 'a2', name: 'Agent 2', status: 'working' }),
    ];
    mockAgentsListWithTasks.mockResolvedValue(toListWithTasks(agents));
    mockAgentsStats.mockImplementation((id: string) =>
      Promise.resolve(makeStats({ agentId: id }))
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Agent 1')).toBeTruthy();
      expect(screen.getByText('Agent 2')).toBeTruthy();
    });

    const grid = screen.getByText('Agent 1').closest('.grid');
    expect(grid).toBeTruthy();
    expect(grid?.className).toContain('grid-cols-1');
    expect(grid?.className).toContain('md:grid-cols-2');
    expect(grid?.className).toContain('lg:grid-cols-3');
  });

  it('displays agent status badge', async () => {
    mockAgentsListWithTasks.mockResolvedValue(toListWithTasks([
      makeAgent({ id: 'a1', status: 'idle' }),
      makeAgent({ id: 'a2', status: 'working' }),
      makeAgent({ id: 'a3', status: 'offline' }),
    ]));
    mockAgentsStats.mockImplementation((id: string) =>
      Promise.resolve(makeStats({ agentId: id }))
    );

    renderPage();

    await waitFor(() => {
      const badges = screen.getAllByTestId('badge');
      expect(badges.some((b) => b.textContent === 'idle')).toBe(true);
      expect(badges.some((b) => b.textContent === 'working')).toBe(true);
      expect(badges.some((b) => b.textContent === 'offline')).toBe(true);
    });
  });

  it('shows agent capabilities', async () => {
    mockAgentsListWithTasks.mockResolvedValue(toListWithTasks([
      makeAgent({ id: 'a1', capabilities: ['typescript', 'react'] }),
    ]));
    mockAgentsStats.mockResolvedValue(makeStats({ agentId: 'a1' }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('typescript')).toBeTruthy();
      expect(screen.getByText('react')).toBeTruthy();
    });
  });

  it('opens registration dialog on Register button click', async () => {
    mockAgentsListWithTasks.mockResolvedValue([]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No agents registered')).toBeTruthy();
    });

    const registerButtons = screen.getAllByText('Register Agent');
    fireEvent.click(registerButtons[0]);

    expect(screen.getByTestId('register-dialog')).toBeTruthy();
  });

  it('closes registration dialog and refetches on registered callback', async () => {
    const agents = [makeAgent({ id: 'a1' })];
    mockAgentsListWithTasks.mockResolvedValueOnce([]).mockResolvedValueOnce(toListWithTasks(agents));
    mockAgentsStats.mockResolvedValue(makeStats({ agentId: 'a1' }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No agents registered')).toBeTruthy();
    });

    const registerButtons = screen.getAllByText('Register Agent');
    fireEvent.click(registerButtons[0]);

    const registeredBtn = screen.getByTestId('register-registered');
    fireEvent.click(registeredBtn);

    await waitFor(() => {
      expect(mockAgentsListWithTasks).toHaveBeenCalledTimes(2);
    });
  });

  it('shows confirmation on Deregister button click', async () => {
    mockAgentsListWithTasks.mockResolvedValue(toListWithTasks([makeAgent({ id: 'a1', name: 'Agent 1' })]));
    mockAgentsStats.mockResolvedValue(makeStats({ agentId: 'a1' }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Agent 1')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Deregister'));

    expect(screen.getByTestId('confirm-dialog')).toBeTruthy();
    expect(screen.getByText('Deregister Agent')).toBeTruthy();
  });

  it('deregisters agent on confirm', async () => {
    mockAgentsListWithTasks.mockResolvedValue(toListWithTasks([makeAgent({ id: 'a1', name: 'Agent 1' })]));
    mockAgentsStats.mockResolvedValue(makeStats({ agentId: 'a1' }));
    mockAgentsDelete.mockResolvedValue(undefined);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Agent 1')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Deregister'));
    fireEvent.click(screen.getByTestId('confirm-ok'));

    await waitFor(() => {
      expect(mockAgentsDelete).toHaveBeenCalledWith('a1');
      expect(mockNotifySuccess).toHaveBeenCalledWith('Agent deregistered');
    });
  });

  it('handles deregister error', async () => {
    mockAgentsListWithTasks.mockResolvedValue(toListWithTasks([makeAgent({ id: 'a1', name: 'Agent 1' })]));
    mockAgentsStats.mockResolvedValue(makeStats({ agentId: 'a1' }));
    mockAgentsDelete.mockRejectedValue(new Error('Delete failed'));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Agent 1')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Deregister'));
    fireEvent.click(screen.getByTestId('confirm-ok'));

    await waitFor(() => {
      expect(mockNotifyError).toHaveBeenCalledWith('Delete failed');
    });
  });

  it('cancels deregister confirmation', async () => {
    mockAgentsListWithTasks.mockResolvedValue(toListWithTasks([makeAgent({ id: 'a1', name: 'Agent 1' })]));
    mockAgentsStats.mockResolvedValue(makeStats({ agentId: 'a1' }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Agent 1')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Deregister'));
    fireEvent.click(screen.getByTestId('confirm-cancel'));

    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    expect(screen.getByText('Agent 1')).toBeTruthy();
  });

  it('expands and collapses metrics section', async () => {
    mockAgentsListWithTasks.mockResolvedValue(toListWithTasks([makeAgent({ id: 'a1' })]));
    mockAgentsStats.mockResolvedValue(makeStats({ agentId: 'a1' }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('metrics-toggle-a1')).toBeTruthy();
    });

    expect(screen.queryByText('Completed:')).toBeNull();

    fireEvent.click(screen.getByTestId('metrics-toggle-a1'));

    expect(screen.getByText('Completed:')).toBeTruthy();
    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.getByText('Failed:')).toBeTruthy();

    fireEvent.click(screen.getByTestId('metrics-toggle-a1'));

    expect(screen.queryByText('Completed:')).toBeNull();
  });

  it('shows artifacts in metrics when total > 0', async () => {
    mockAgentsListWithTasks.mockResolvedValue(toListWithTasks([makeAgent({ id: 'a1' })]));
    mockAgentsStats.mockResolvedValue(makeStats({ agentId: 'a1', artifacts: { total: 5, byType: { pr: 5 } } }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('metrics-toggle-a1')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('metrics-toggle-a1'));

    expect(screen.getByText('Artifacts:')).toBeTruthy();
  });

  it('shows dash when cycle time count is 0', async () => {
    mockAgentsListWithTasks.mockResolvedValue(toListWithTasks([makeAgent({ id: 'a1' })]));
    mockAgentsStats.mockResolvedValue(
      makeStats({ agentId: 'a1', cycleTime: { averageMinutes: 0, medianMinutes: 0, count: 0 } })
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('metrics-toggle-a1')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('metrics-toggle-a1'));

    expect(screen.getByText('—')).toBeTruthy();
  });

  it('Back button navigates to workspace', async () => {
    mockAgentsListWithTasks.mockResolvedValue([]);

    renderPage();

    const backLink = screen.getByText('Back').closest('a');
    expect(backLink?.getAttribute('href')).toBe('/');
  });

  it('shows relative time for last heartbeat', async () => {
    const now = new Date('2024-06-15T14:30:00Z');
    const fiveMinAgo = new Date(now.getTime() - 5 * 60000).toISOString();
    mockAgentsListWithTasks.mockResolvedValue(toListWithTasks([
      makeAgent({ id: 'a1', lastHeartbeat: fiveMinAgo }),
    ]));
    mockAgentsStats.mockResolvedValue(makeStats({ agentId: 'a1' }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('5m ago')).toBeTruthy();
    });
  });

  it('shows just now for very recent heartbeat', async () => {
    mockAgentsListWithTasks.mockResolvedValue(toListWithTasks([
      makeAgent({ id: 'a1', lastHeartbeat: new Date().toISOString() }),
    ]));
    mockAgentsStats.mockResolvedValue(makeStats({ agentId: 'a1' }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('just now')).toBeTruthy();
    });
  });

  it('handles stats fetch failure gracefully', async () => {
    const agents = [makeAgent({ id: 'a1' })];
    mockAgentsListWithTasks.mockResolvedValue(toListWithTasks(agents));
    mockAgentsStats.mockRejectedValue(new Error('Stats error'));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Test Agent')).toBeTruthy();
    });
  });

  it('displays agent type and domain', async () => {
    mockAgentsListWithTasks.mockResolvedValue(toListWithTasks([
      makeAgent({ id: 'a1', type: 'claude-code', domain: 'frontend' }),
    ]));
    mockAgentsStats.mockResolvedValue(makeStats({ agentId: 'a1' }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('claude code · frontend')).toBeTruthy();
    });
  });

  it('formats cycle time correctly with hours and minutes', async () => {
    mockAgentsListWithTasks.mockResolvedValue(toListWithTasks([makeAgent({ id: 'a1' })]));
    mockAgentsStats.mockResolvedValue(
      makeStats({ agentId: 'a1', cycleTime: { averageMinutes: 125, medianMinutes: 120, count: 5 } })
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('metrics-toggle-a1')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('metrics-toggle-a1'));

    expect(screen.getByText('2h 5m')).toBeTruthy();
  });

  it('formats cycle time with exact hours', async () => {
    mockAgentsListWithTasks.mockResolvedValue(toListWithTasks([makeAgent({ id: 'a1' })]));
    mockAgentsStats.mockResolvedValue(
      makeStats({ agentId: 'a1', cycleTime: { averageMinutes: 120, medianMinutes: 120, count: 3 } })
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('metrics-toggle-a1')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('metrics-toggle-a1'));

    expect(screen.getByText('2h')).toBeTruthy();
  });

  it('shows hours ago for older heartbeat', async () => {
    const now = new Date('2024-06-15T14:30:00Z');
    const twoHoursAgo = new Date(now.getTime() - 2 * 3600000).toISOString();
    mockAgentsListWithTasks.mockResolvedValue(toListWithTasks([
      makeAgent({ id: 'a1', lastHeartbeat: twoHoursAgo }),
    ]));
    mockAgentsStats.mockResolvedValue(makeStats({ agentId: 'a1' }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('2h ago')).toBeTruthy();
    });
  });

  it('shows days ago for very old heartbeat', async () => {
    const now = new Date('2024-06-15T14:30:00Z');
    const threeDaysAgo = new Date(now.getTime() - 3 * 86400000).toISOString();
    mockAgentsListWithTasks.mockResolvedValue(toListWithTasks([
      makeAgent({ id: 'a1', lastHeartbeat: threeDaysAgo }),
    ]));
    mockAgentsStats.mockResolvedValue(makeStats({ agentId: 'a1' }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('3d ago')).toBeTruthy();
    });
  });

  it('renders agent card without capabilities', async () => {
    mockAgentsListWithTasks.mockResolvedValue(toListWithTasks([
      makeAgent({ id: 'a1', capabilities: [] }),
    ]));
    mockAgentsStats.mockResolvedValue(makeStats({ agentId: 'a1' }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Test Agent')).toBeTruthy();
    });

    expect(screen.queryByText('typescript')).toBeNull();
  });

  it('displays current task title for working agent', async () => {
    mockAgentsListWithTasks.mockResolvedValue(toListWithTasks(
      [makeAgent({ id: 'a1', name: 'Agent 1', status: 'working' })],
      { a1: 'Fix navigation bug' }
    ));
    mockAgentsStats.mockResolvedValue(makeStats({ agentId: 'a1' }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Agent 1')).toBeTruthy();
    });

    expect(screen.getByText('Working on:')).toBeTruthy();
    expect(screen.getByText('Fix navigation bug')).toBeTruthy();
  });

  it('hides current task section when agent has no active task', async () => {
    mockAgentsListWithTasks.mockResolvedValue(toListWithTasks([
      makeAgent({ id: 'a1', name: 'Agent 1', status: 'idle' }),
    ]));
    mockAgentsStats.mockResolvedValue(makeStats({ agentId: 'a1' }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Agent 1')).toBeTruthy();
    });

    expect(screen.queryByText('Working on:')).toBeNull();
  });
});
