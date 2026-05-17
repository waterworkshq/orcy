import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TaskDetailModal } from './TaskDetailModal.js';
import type { Task, Agent, TaskEvent, Subtask, Task as TaskType } from '../../types/index.js';

const mockOpenModal = vi.fn();
const mockCloseModal = vi.fn();
const mockSetModalTask = vi.fn();

let modalStoreState: {
  isOpen: boolean;
  selectedTaskId: string | null;
  modalTask: Task | null;
  isLoading: boolean;
  openModal: typeof mockOpenModal;
  closeModal: typeof mockCloseModal;
  setModalTask: typeof mockSetModalTask;
} = {
  isOpen: false,
  selectedTaskId: null,
  modalTask: null,
  isLoading: false,
  openModal: mockOpenModal,
  closeModal: mockCloseModal,
  setModalTask: mockSetModalTask,
};

const useModalStoreMock = vi.fn((..._args: any[]) => modalStoreState);

vi.mock('../../store/modalStore.js', () => ({
  useModalStore: (...args: any[]) => useModalStoreMock(args[0]),
}));

let boardStoreState: Record<string, any> = {
  tasks: [],
  agents: [] as Agent[],
};

const useBoardStoreMock = vi.fn((selector?: any) => {
  if (selector) return selector(boardStoreState);
  return boardStoreState;
});

vi.mock('../../store/habitatStore.js', () => ({
  useHabitatStore: (...args: any[]) => useBoardStoreMock(...args),
}));

const mockTaskDetails = vi.fn();
vi.mock('../../lib/useTaskData.js', () => ({
  useTaskDetails: (taskId: string | undefined) => mockTaskDetails(taskId),
}));

vi.mock('./TaskActivityFeed.js', () => ({
  TaskActivityFeed: ({ events }: any) => (
    <div data-testid="task-activity-feed">Activity ({events.length} events)</div>
  ),
}));

vi.mock('../ui/MarkdownContent.js', () => ({
  MarkdownContent: ({ content, className }: any) => (
    <div data-testid="markdown-content" className={className}>{content}</div>
  ),
}));

vi.mock('./TaskSubtasks.js', () => ({
  TaskSubtasks: ({ subtasks }: any) => (
    <div data-testid="task-subtasks">Subtasks ({subtasks.length})</div>
  ),
}));

vi.mock('./TaskArtifacts.js', () => ({
  TaskArtifacts: ({ artifacts }: any) => (
    <div data-testid="task-artifacts">Artifacts ({artifacts.length})</div>
  ),
}));

vi.mock('./TaskDependencies.js', () => ({
  TaskDependencies: ({ taskId }: any) => (
    <div data-testid="task-dependencies">Deps for {taskId}</div>
  ),
}));

vi.mock('../ui/Badge.js', () => ({
  Badge: ({ children, variant }: any) => (
    <span data-testid="badge" data-variant={variant}>{children}</span>
  ),
}));

const baseTask: Task = {
  id: 'task-1',
  missionId: 'feat-1',
  title: 'Test Task Title',
  description: 'This is a test task description with some details.',
  priority: 'high',
  assignedAgentId: 'agent-1',
  delegatedToAgentId: null,
  requiredDomain: 'frontend',
  requiredCapabilities: ['react', 'typescript'],
  status: 'in_progress',
  claimedAt: null,
  startedAt: '2024-03-20T10:00:00Z',
  submittedAt: null,
  completedAt: null,
  rejectedCount: 0,
  rejectionReason: null,
  result: null,
  artifacts: [],
  order: 0,
  createdBy: 'user-1',
  createdAt: '2024-03-18T10:00:00Z',
  updatedAt: '2024-03-20T12:00:00Z',
  version: 3,
  estimatedMinutes: 60,
  actualMinutes: null,
  cycleTimeMinutes: null,
  leadTimeMinutes: null,
  estimationAccuracy: null,
  retryPolicy: null,
  retryCount: 0,
  nextRetryAt: null,
  labels: [],
};

const baseAgent: Agent = {
  id: 'agent-1',
  name: 'Agent Alpha',
  type: 'claude-code',
  domain: 'frontend',
  capabilities: ['react', 'typescript'],
  status: 'working',
  currentTaskId: 'task-1',
  createdAt: '2024-01-01T00:00:00Z',
  lastHeartbeat: '2024-03-20T12:00:00Z',
  metadata: {},
  apiKeyHash: 'test-hash',
  rateLimitPerMinute: null,
};

describe('TaskDetailModal', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    modalStoreState = {
      isOpen: false,
      selectedTaskId: null,
      modalTask: null,
      isLoading: false,
      openModal: mockOpenModal,
      closeModal: mockCloseModal,
      setModalTask: mockSetModalTask,
    };

    boardStoreState = {
      tasks: [],
      agents: [baseAgent],
    };

    mockTaskDetails.mockReturnValue({
      data: {
        task: baseTask,
        feature: { id: 'feat-1', title: 'Test Feature', description: '', acceptanceCriteria: '', priority: 'medium', status: 'in_progress' },
        subtasks: [] as Subtask[],
        pullRequests: [],
        pipelineEvents: [],
        events: [] as TaskEvent[],
        comments: [],
        totalComments: 0,
        attachments: [],
        watchers: [],
        isWatching: false,
        dependencies: [] as TaskType[],
        crossBoardDependsOn: [],
        blockedBy: [] as TaskType[],
        blocking: [] as TaskType[],
        boardContext: { name: 'Board', columns: [] },
      },
      isLoading: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('returns null when modal is closed', () => {
    modalStoreState.isOpen = false;
    const { container } = render(<TaskDetailModal />);
    expect(container.innerHTML).toBe('');
  });

  it('renders with glass-modal class when open', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    const modal = document.querySelector('.glass-modal');
    expect(modal).toBeTruthy();
  });

  it('shows task title in header', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    expect(screen.getByText('Test Task Title')).toBeTruthy();
  });

  it('shows feature breadcrumb when feature exists', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    expect(screen.getByText('Test Feature')).toBeTruthy();
  });

  it('shows assignee name from agents list', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    expect(screen.getAllByText('Agent Alpha').length).toBeGreaterThan(0);
  });

  it('shows unassigned when no agent assigned', () => {
    const unassignedTask = { ...baseTask, assignedAgentId: null };
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = unassignedTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    expect(screen.getAllByText('Unassigned').length).toBeGreaterThan(0);
  });

  it('shows priority dot', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    expect(screen.getAllByText('High').length).toBeGreaterThan(0);
  });

  it('shows status badge', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    expect(screen.getAllByText('In Progress').length).toBeGreaterThan(0);
  });

  it('shows description in left column', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    expect(screen.getByText('Description')).toBeTruthy();
    expect(screen.getByText('This is a test task description with some details.')).toBeTruthy();
  });

  it('renders 7/5 split layout without tabs', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    const left = document.querySelector('.col-span-7');
    const right = document.querySelector('.col-span-5');
    expect(left).toBeTruthy();
    expect(right).toBeTruthy();
    expect(screen.queryByRole('button', { name: /overview/i })).toBeNull();
  });

  it('shows activity feed in the right column simultaneously with description', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    expect(screen.getByText('Description')).toBeTruthy();
    expect(screen.getByText('Activity Feed')).toBeTruthy();
    expect(screen.getByTestId('task-activity-feed')).toBeTruthy();
  });

  it('shows dependencies in the left column without switching tabs', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    expect(screen.getByTestId('task-dependencies')).toBeTruthy();
  });

  it('renders footer actions with disabled save placeholder and glow class', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    expect(screen.getByRole('button', { name: 'Share' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    const saveButton = screen.getByRole('button', { name: /save changes/i });
    expect(saveButton).toBeDisabled();
    expect(saveButton).toHaveAttribute('title', 'Coming soon');
    expect(saveButton).toHaveClass('task-save-gradient-glow');
  });

  it('close button calls closeModal', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    const closeBtn = screen.getByLabelText('Close modal');
    fireEvent.click(closeBtn);

    act(() => { vi.advanceTimersByTime(250); });

    expect(mockCloseModal).toHaveBeenCalled();
  });

  it('escape key triggers close', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    fireEvent.keyDown(document, { key: 'Escape' });

    act(() => { vi.advanceTimersByTime(250); });

    expect(mockCloseModal).toHaveBeenCalled();
  });

  it('closes on backdrop click', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    const overlay = document.querySelector('[role="dialog"]');
    expect(overlay).toBeTruthy();

    fireEvent.click(overlay!);

    act(() => { vi.advanceTimersByTime(250); });

    expect(mockCloseModal).toHaveBeenCalled();
  });

  it('does not close when clicking inside the modal', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    const modalContent = document.querySelector('.glass-modal')!;
    fireEvent.click(modalContent);

    expect(mockCloseModal).not.toHaveBeenCalled();
  });

  it('shows loading spinner when isLoading is true', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.isLoading = true;
    modalStoreState.modalTask = null;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeTruthy();
  });

  it('shows error state when task is null and not loading', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.isLoading = false;
    modalStoreState.modalTask = null;

    mockTaskDetails.mockReturnValue({ data: undefined, isLoading: false });

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    expect(screen.getByText('Failed to load task')).toBeTruthy();
  });

  it('sets body overflow hidden when open', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    expect(document.body.style.overflow).toBe('hidden');
  });

  it('restores body overflow on close', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    const { unmount } = render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    unmount();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('shows subtasks in overview when present', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    mockTaskDetails.mockReturnValue({
      data: {
        task: baseTask,
        feature: { id: 'feat-1', title: 'Test Feature', description: '', acceptanceCriteria: '', priority: 'medium', status: 'in_progress' },
        subtasks: [
          { id: 'st-1', taskId: 'task-1', title: 'Subtask A', completed: true, order: 0, assigneeId: null, createdAt: '', updatedAt: '' },
          { id: 'st-2', taskId: 'task-1', title: 'Subtask B', completed: false, order: 1, assigneeId: null, createdAt: '', updatedAt: '' },
        ],
        pullRequests: [],
        pipelineEvents: [],
        events: [],
        comments: [],
        totalComments: 0,
        attachments: [],
        watchers: [],
        isWatching: false,
        dependencies: [],
        crossBoardDependsOn: [],
        blockedBy: [],
        blocking: [],
        boardContext: { name: 'Board', columns: [] },
      },
      isLoading: false,
    });

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    expect(screen.getByText('Subtask A')).toBeTruthy();
    expect(screen.getByText('Subtask B')).toBeTruthy();
  });

  it('renders task artifacts in overview', () => {
    const taskWithArtifacts = {
      ...baseTask,
      artifacts: [
        { type: 'file' as const, url: 'https://example.com/file.txt', description: 'Test file' },
      ],
    };
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = taskWithArtifacts;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    expect(screen.getByTestId('task-artifacts')).toBeTruthy();
  });

  it('shows capabilities as glass badges', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    expect(screen.getByText('react')).toBeTruthy();
    expect(screen.getByText('typescript')).toBeTruthy();
  });

  it('does not render decorative blur elements', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    const blurElements = document.querySelectorAll('[class*="blur-[100px]"]');
    expect(blurElements.length).toBe(0);
  });

  it('overlay does not use backdrop-blur-sm', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    const overlay = document.querySelector('[role="dialog"]');
    expect(overlay).toBeTruthy();
    expect(overlay!.className).not.toContain('backdrop-blur-sm');
  });

  it('overlay has solid semi-transparent background', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    const overlay = document.querySelector('[role="dialog"]');
    expect(overlay).toBeTruthy();
    expect(overlay!.className).toContain('bg-surface-container-lowest/80');
  });

  it('overlay preserves z-index stacking', () => {
    modalStoreState.isOpen = true;
    modalStoreState.selectedTaskId = 'task-1';
    modalStoreState.modalTask = baseTask;

    render(<TaskDetailModal />);

    act(() => { vi.advanceTimersByTime(50); });

    const overlay = document.querySelector('[role="dialog"]');
    expect(overlay).toBeTruthy();
    expect(overlay!.className).toContain('z-50');
  });
});
