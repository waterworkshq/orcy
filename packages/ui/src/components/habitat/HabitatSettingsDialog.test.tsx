import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { BoardSettingsDialog } from './HabitatSettingsDialog.js';
import type { Board } from '../../types/index.js';

const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();
const mockGetGlobalPrefs = vi.fn();
const mockGetBoardPrefs = vi.fn();

vi.mock('../../api/index.js', () => ({
  api: {
    boards: {
      update: (...args: unknown[]) => mockUpdate(...args),
      delete: (...args: unknown[]) => mockDelete(...args),
    },
    notifications: {
      getGlobalPrefs: (...args: unknown[]) => mockGetGlobalPrefs(...args),
      getBoardPrefs: (...args: unknown[]) => mockGetBoardPrefs(...args),
      updateEmail: vi.fn(),
      updateGlobalPrefs: vi.fn(),
      updateBoardPrefs: vi.fn(),
    },
    chatIntegrations: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      test: vi.fn(),
    },
  },
}));

vi.mock('../../lib/toast.js', () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
  },
}));

vi.mock('../ui/Dialog.js', () => ({
  Dialog: ({ open, children }: any) => open ? <div data-testid="dialog">{children}</div> : null,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogContent: ({ children }: any) => <div data-testid="dialog-content">{children}</div>,
  DialogFooter: ({ children }: any) => <div data-testid="dialog-footer">{children}</div>,
}));

vi.mock('../ui/Button.js', () => ({
  Button: ({ children, onClick, disabled, loading, variant }: any) => (
    <button onClick={onClick} disabled={disabled} data-variant={variant} data-loading={loading}>
      {loading ? 'Loading...' : children}
    </button>
  ),
}));

vi.mock('../ui/ConfirmDialog.js', () => ({
  ConfirmDialog: ({ open, title }: any) => open ? <div data-testid="confirm-dialog">{title}</div> : null,
}));

vi.mock('./ExportHabitatDialog.js', () => ({
  ExportBoardDialog: ({ open }: any) => open ? <div data-testid="export-dialog" /> : null,
}));

vi.mock('./ImportHabitatDialog.js', () => ({
  ImportBoardDialog: ({ open }: any) => open ? <div data-testid="import-dialog" /> : null,
}));

vi.mock('./settings/GeneralTab.js', () => ({
  GeneralTab: React.forwardRef(function GeneralTab(props: any, ref: any) {
    React.useImperativeHandle(ref, () => ({
      save: async () => {
        props.onUpdate({ id: 'b1', name: 'Saved' });
        props.onClose();
      },
    }));
    return (
      <div data-testid="general-tab">
        <span>GeneralTab</span>
        <button onClick={() => props.onExportOpen()}>ExportTrigger</button>
        <button onClick={() => props.onDeleteOpen()}>DeleteTrigger</button>
      </div>
    );
  }),
}));

vi.mock('./settings/NotificationsTab.js', () => ({
  NotificationsTab: React.forwardRef(function NotificationsTab(props: any, ref: any) {
    React.useImperativeHandle(ref, () => ({
      save: async () => {},
    }));
    return <div data-testid="notifications-tab">NotificationsTab</div>;
  }),
}));

vi.mock('./settings/ChatIntegrationsTab.js', () => ({
  ChatIntegrationsTab: () => <div data-testid="chat-tab">ChatIntegrationsTab</div>,
}));

vi.mock('./settings/RetryPolicyTab.js', () => ({
  RetryPolicyTab: React.forwardRef(function RetryPolicyTab(props: any, ref: any) {
    React.useImperativeHandle(ref, () => ({
      save: async () => {},
    }));
    return <div data-testid="retry-tab">RetryPolicyTab</div>;
  }),
}));

vi.mock('./settings/AnomalyDetectionTab.js', () => ({
  AnomalyDetectionTab: React.forwardRef(function AnomalyDetectionTab(props: any, ref: any) {
    React.useImperativeHandle(ref, () => ({
      save: async () => {},
    }));
    return <div data-testid="anomaly-tab">AnomalyDetectionTab</div>;
  }),
}));

vi.mock('./settings/AutoAssignTab.js', () => ({
  AutoAssignTab: React.forwardRef(function AutoAssignTab(props: any, ref: any) {
    React.useImperativeHandle(ref, () => ({
      save: async () => {},
    }));
    return <div data-testid="auto-assign-tab">AutoAssignTab</div>;
  }),
}));

const mockBoard: Board = {
  id: 'b1',
  name: 'Test Board',
  description: 'A test board',
  columns: [],
  teamId: null,
  retrySettings: null,
  anomalySettings: null,
  autoAssignSettings: null,
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
};

describe('HabitatSettingsDialog', () => {
  const mockOnUpdate = vi.fn();
  const mockOnDelete = vi.fn();
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders dialog title', () => {
    render(
      <BoardSettingsDialog
        board={mockBoard}
        open={true}
        onClose={mockOnClose}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
      />
    );
    expect(screen.getByText('Habitat Settings')).toBeTruthy();
  });

  it('renders all tab buttons', () => {
    render(
      <BoardSettingsDialog
        board={mockBoard}
        open={true}
        onClose={mockOnClose}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
      />
    );
    expect(screen.getByText('General')).toBeTruthy();
    expect(screen.getByText('Notifications')).toBeTruthy();
    expect(screen.getByText('Chat Integrations')).toBeTruthy();
    expect(screen.getByText('Retry Policy')).toBeTruthy();
    expect(screen.getByText('Anomaly Detection')).toBeTruthy();
    expect(screen.getByText('Auto-Assign')).toBeTruthy();
  });

  it('shows GeneralTab by default', () => {
    render(
      <BoardSettingsDialog
        board={mockBoard}
        open={true}
        onClose={mockOnClose}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
      />
    );
    expect(screen.getByTestId('general-tab')).toBeTruthy();
  });

  it('switches to NotificationsTab on tab click', () => {
    render(
      <BoardSettingsDialog
        board={mockBoard}
        open={true}
        onClose={mockOnClose}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
      />
    );
    fireEvent.click(screen.getByText('Notifications'));
    expect(screen.getByTestId('notifications-tab')).toBeTruthy();
    expect(screen.queryByTestId('general-tab')).toBeNull();
  });

  it('switches to ChatIntegrationsTab on tab click', () => {
    render(
      <BoardSettingsDialog
        board={mockBoard}
        open={true}
        onClose={mockOnClose}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
      />
    );
    fireEvent.click(screen.getByText('Chat Integrations'));
    expect(screen.getByTestId('chat-tab')).toBeTruthy();
  });

  it('switches to RetryPolicyTab on tab click', () => {
    render(
      <BoardSettingsDialog
        board={mockBoard}
        open={true}
        onClose={mockOnClose}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
      />
    );
    fireEvent.click(screen.getByText('Retry Policy'));
    expect(screen.getByTestId('retry-tab')).toBeTruthy();
  });

  it('switches to AnomalyDetectionTab on tab click', () => {
    render(
      <BoardSettingsDialog
        board={mockBoard}
        open={true}
        onClose={mockOnClose}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
      />
    );
    fireEvent.click(screen.getByText('Anomaly Detection'));
    expect(screen.getByTestId('anomaly-tab')).toBeTruthy();
  });

  it('switches to AutoAssignTab on tab click', () => {
    render(
      <BoardSettingsDialog
        board={mockBoard}
        open={true}
        onClose={mockOnClose}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
      />
    );
    fireEvent.click(screen.getByText('Auto-Assign'));
    expect(screen.getByTestId('auto-assign-tab')).toBeTruthy();
  });

  it('renders Cancel button', () => {
    render(
      <BoardSettingsDialog
        board={mockBoard}
        open={true}
        onClose={mockOnClose}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
      />
    );
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  it('renders Save button for general tab', () => {
    render(
      <BoardSettingsDialog
        board={mockBoard}
        open={true}
        onClose={mockOnClose}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
      />
    );
    expect(screen.getByText('Save')).toBeTruthy();
  });

  it('renders correct save button for each tab', () => {
    render(
      <BoardSettingsDialog
        board={mockBoard}
        open={true}
        onClose={mockOnClose}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
      />
    );

    expect(screen.getByText('Save')).toBeTruthy();

    fireEvent.click(screen.getByText('Retry Policy'));
    expect(screen.getByText('Save Retry Policy')).toBeTruthy();

    fireEvent.click(screen.getByText('Anomaly Detection'));
    expect(screen.getByText('Save Anomaly Settings')).toBeTruthy();

    fireEvent.click(screen.getByText('Auto-Assign'));
    expect(screen.getByText('Save Auto-Assign Settings')).toBeTruthy();
  });

  it('renders no save button for chat tab', () => {
    render(
      <BoardSettingsDialog
        board={mockBoard}
        open={true}
        onClose={mockOnClose}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
      />
    );
    fireEvent.click(screen.getByText('Chat Integrations'));
    expect(screen.queryByText('Save')).toBeNull();
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  it('does not render when open=false', () => {
    render(
      <BoardSettingsDialog
        board={mockBoard}
        open={false}
        onClose={mockOnClose}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
      />
    );
    expect(screen.queryByTestId('dialog')).toBeNull();
  });

  it('renders 6 tab buttons', () => {
    render(
      <BoardSettingsDialog
        board={mockBoard}
        open={true}
        onClose={mockOnClose}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
      />
    );
    const tabButtons = screen.getAllByRole('button').filter(
      btn => ['General', 'Notifications', 'Chat Integrations', 'Retry Policy', 'Anomaly Detection', 'Auto-Assign']
        .includes(btn.textContent || '')
    );
    expect(tabButtons.length).toBe(6);
  });
});
