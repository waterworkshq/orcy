import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TaskDetailPanel } from './TaskDetailPanel.js';
import type { Task, Agent, TaskEvent, Subtask, TaskComment, PullRequest, PipelineEvent, TaskAttachment } from '../../types/index.js';

// ── Board store mocks ──
vi.mock('../../store/habitatStore.js', () => ({
  useHabitatStore: vi.fn((selector?: any) => {
    const state = {
      selectedMissionId: 'feat-1',
      tasks: [] as any[],
      columns: [] as any[],
      agents: [] as Agent[],
    };
    return selector ? selector(state) : state;
  }),
}));

// ── Modal store mocks ──
const mockOpenModal = vi.fn();
const mockCloseModal = vi.fn();
vi.mock('../../store/modalStore.js', () => ({
  useModalStore: vi.fn((selector?: any) => {
    const state = { openModal: mockOpenModal, closeModal: mockCloseModal };
    return selector ? selector(state) : state;
  }),
}));

// ── React Query mocks ──
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
  useQuery: vi.fn(() => ({ data: null, isLoading: false })),
}));

// ── Query keys mock ──
vi.mock('../../lib/queryKeys.js', () => ({
  queryKeys: { tasks: { quality: vi.fn(() => ['quality']) } },
}));

// ── API mock ──
vi.mock('../../api/index.js', () => ({
  api: { qualityGates: { getReport: vi.fn(), updateItem: vi.fn() } },
}));

// ── Badge mock ──
vi.mock('../ui/Badge.js', () => ({
  Badge: ({ children, className }: any) => (
    <span data-testid="badge" className={className}>{children}</span>
  ),
}));

// ── Child component mocks ──
vi.mock('./MissionContextSection.js', () => ({
  FeatureContextSection: ({ feature }: any) =>
    feature ? <div data-testid="feature-context">{feature.title}</div> : null,
}));
vi.mock('./SiblingTasksSection.js', () => ({
  SiblingTasksSection: ({ siblingTasks }: any) =>
    siblingTasks.length > 0 ? <div data-testid="sibling-tasks" /> : null,
}));
vi.mock('./TaskViewHeader.js', () => ({
  TaskViewHeader: ({ task }: any) => <div data-testid="task-view-header">{task.title}</div>,
}));
vi.mock('./TaskEditForm.js', () => ({
  TaskEditForm: () => <div data-testid="task-edit-form" />,
}));
vi.mock('./TaskDescription.js', () => ({
  TaskDescription: ({ description }: any) =>
    description ? <div data-testid="task-description">{description}</div> : null,
}));
vi.mock('./TaskRetryPolicy.js', () => ({
  TaskRetryPolicy: () => null,
}));
vi.mock('./TaskTimeInfo.js', () => ({
  TaskTimeInfo: () => null,
}));
vi.mock('./TaskResultCard.js', () => ({
  TaskResultCard: () => null,
}));
vi.mock('./TaskArtifacts.js', () => ({
  TaskArtifacts: () => null,
}));
vi.mock('./TaskTimeConstraints.js', () => ({
  TaskTimeConstraints: () => null,
}));
vi.mock('./TaskSubtasks.js', () => ({
  TaskSubtasks: ({ subtasks }: any) =>
    subtasks.length > 0 ? <div data-testid="task-subtasks" /> : null,
}));
vi.mock('./TaskQualityChecklist.js', () => ({
  TaskQualityChecklist: () => null,
}));
vi.mock('./TaskDependencies.js', () => ({
  TaskDependencies: () => null,
}));
vi.mock('./TaskAssignment.js', () => ({
  TaskAssignment: () => null,
}));
vi.mock('./ReviewPanel.js', () => ({
  ReviewPanel: () => null,
}));
vi.mock('./TaskActivity.js', () => ({
  TaskActivity: () => null,
}));
vi.mock('./CommentSection.js', () => ({
  CommentSection: () => null,
}));
vi.mock('./AttachmentSection.js', () => ({
  AttachmentSection: () => null,
}));
vi.mock('./TaskPullRequests.js', () => ({
  TaskPullRequests: () => null,
}));
vi.mock('./TaskPipelineEvents.js', () => ({
  TaskPipelineEvents: () => null,
}));
vi.mock('./TaskDangerZone.js', () => ({
  TaskDangerZone: () => null,
}));
vi.mock('../ui/Button.js', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

// ── useTaskDetailPanel mock ──
const useTaskDetailPanelMock = vi.fn();
vi.mock('../../hooks/useTaskDetailPanel.js', () => ({
  useTaskDetailPanel: (...args: any[]) => useTaskDetailPanelMock(...args),
}));

// ── Default task ──
function makeDefaultPanelReturn(overrides: Record<string, any> = {}) {
  const taskOverrides = overrides.task || {};
  delete overrides.task;
  return {
    selectedTaskId: 'task-1',
    contextLoading: false,
    isEditing: false,
    task: {
      id: 'task-1',
      missionId: 'feat-1',
      title: 'Test Task',
      description: 'Test description',
      priority: 'medium',
      status: 'pending',
      requiredCapabilities: [],
      assignedAgentId: null,
      delegatedToAgentId: null,
      requiredDomain: 'frontend',
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
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      version: 1,
      estimatedMinutes: null,
      actualMinutes: null,
      cycleTimeMinutes: null,
      leadTimeMinutes: null,
      estimationAccuracy: null,
      retryPolicy: null,
      retryCount: 0,
      nextRetryAt: null,
      ...taskOverrides,
    } as Task,
    feature: null,
    siblingTasks: [],
    column: undefined,
    nextColumnName: undefined,
    isWatching: false,
    watchLoading: false,
    submitting: false,
    agents: [],
    events: [] as TaskEvent[],
    subtasks: [] as Subtask[],
    pullRequests: [] as PullRequest[],
    pipelineEvents: [] as PipelineEvent[],
    attachments: [] as TaskAttachment[],
    comments: [] as TaskComment[],
    dependencies: [],
    crossBoardDependsOn: [],
    blockedBy: [],
    blocking: [],
    dependenciesLoading: false,
    deleteDialogOpen: false,
    decomposing: false,
    decomposeDialogOpen: false,
    decompositionProposals: [],
    newSubtaskTitle: '',
    addingSubtask: false,
    delegateAgentId: '',
    delegating: false,
    showDelegate: false,
    addingDep: false,
    editForm: { title: '', description: '', priority: 'medium' as const, labels: '', requiredDomain: '' },
    editDueAt: '',
    editSlaMinutes: '',
    editEstimatedMinutes: '',
    retryForm: { maxRetries: '', backoffBase: '', backoffMultiplier: '', maxBackoff: '', escalateToHuman: true },
    setIsEditing: vi.fn(),
    setDeleteDialogOpen: vi.fn(),
    setEditForm: vi.fn(),
    setEditDueAt: vi.fn(),
    setEditSlaMinutes: vi.fn(),
    setEditEstimatedMinutes: vi.fn(),
    setRetryForm: vi.fn(),
    setNewSubtaskTitle: vi.fn(),
    setDelegateAgentId: vi.fn(),
    setShowDelegate: vi.fn(),
    setDecomposeDialogOpen: vi.fn(),
    setDecompositionProposals: vi.fn(),
    startEditing: vi.fn(),
    handleAddSubtask: vi.fn(),
    handleToggleSubtask: vi.fn(),
    handleDeleteSubtask: vi.fn(),
    handleApprove: vi.fn(),
    handleReject: vi.fn(),
    handleDelete: vi.fn(),
    handleClone: vi.fn(),
    handleDecompose: vi.fn(),
    handleDecomposeConfirm: vi.fn(),
    handleDelegate: vi.fn(),
    handleToggleWatch: vi.fn(),
    handleEditSubmit: vi.fn(),
    handleEditCancel: vi.fn(),
    handleAddDependency: vi.fn(),
    handleRemoveDependency: vi.fn(),
  };
}

describe('TaskDetailPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTaskDetailPanelMock.mockReturnValue(makeDefaultPanelReturn());
  });

  afterEach(() => {
    cleanup();
  });

  it('returns null when no selected task', () => {
    useTaskDetailPanelMock.mockReturnValue({
      ...makeDefaultPanelReturn(),
      selectedTaskId: null,
      task: undefined,
    } as any);
    const { container } = render(<TaskDetailPanel />);
    expect(container.innerHTML).toBe('');
  });

  it('shows task title in header', () => {
    useTaskDetailPanelMock.mockReturnValue(makeDefaultPanelReturn());
    render(<TaskDetailPanel />);
    expect(screen.getByTestId('task-view-header')).toBeTruthy();
    expect(screen.getByText('Test Task')).toBeTruthy();
  });

  it('renders capabilities as badges when array is non-empty', () => {
    useTaskDetailPanelMock.mockReturnValue(makeDefaultPanelReturn({
      task: { requiredCapabilities: ['react', 'typescript'] },
    }));
    render(<TaskDetailPanel />);

    const badges = screen.getAllByTestId('badge');
    expect(badges).toHaveLength(2);
    expect(screen.getByText('react')).toBeTruthy();
    expect(screen.getByText('typescript')).toBeTruthy();
    expect(screen.getByText('Capabilities')).toBeTruthy();
  });

  it('renders nothing when capabilities array is empty', () => {
    useTaskDetailPanelMock.mockReturnValue(makeDefaultPanelReturn({
      task: { requiredCapabilities: [] },
    }));
    render(<TaskDetailPanel />);

    expect(screen.queryByText('Capabilities')).toBeNull();
    expect(screen.queryAllByTestId('badge')).toHaveLength(0);
  });

  it('renders nothing when capabilities field is undefined', () => {
    useTaskDetailPanelMock.mockReturnValue(makeDefaultPanelReturn({
      task: { requiredCapabilities: undefined },
    }));
    render(<TaskDetailPanel />);

    expect(screen.queryByText('Capabilities')).toBeNull();
  });

  it('badge elements have glass-badge styling', () => {
    useTaskDetailPanelMock.mockReturnValue(makeDefaultPanelReturn({
      task: { requiredCapabilities: ['typescript'] },
    }));
    render(<TaskDetailPanel />);

    const badge = screen.getByTestId('badge');
    expect(badge).toHaveClass('text-[10px]');
  });
});
