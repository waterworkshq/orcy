import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatIntegrationsTab } from './ChatIntegrationsTab.js';

const mockList = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockTest = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

vi.mock('../../../api/index.js', () => ({
  api: {
    chatIntegrations: {
      list: (...args: unknown[]) => mockList(...args),
      create: (...args: unknown[]) => mockCreate(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      delete: (...args: unknown[]) => mockDelete(...args),
      test: (...args: unknown[]) => mockTest(...args),
    },
  },
}));

vi.mock('../../../lib/toast.js', () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
  },
}));

vi.mock('./ChatIntegrationForm.js', () => ({
  ChatIntegrationForm: ({ onSave, onCancel, saving, existing }: any) => (
    <div data-testid="chat-form">
      <span>{existing ? 'Edit Form' : 'Create Form'}</span>
      <button onClick={() => onSave({ provider: 'slack', webhookUrl: '', channelId: '', botToken: '', events: [] })}>
        Submit
      </button>
      <button onClick={onCancel}>FormCancel</button>
      {saving && <span>Saving...</span>}
    </div>
  ),
}));

vi.mock('./ChatIntegrationList.js', () => ({
  ChatIntegrationList: ({ integrations, loading, onAdd, onEdit, onDelete, onTest, onToggle }: any) => (
    <div data-testid="chat-list">
      {loading && <span>Loading...</span>}
      {!loading && integrations?.length === 0 && <span>No integrations</span>}
      {!loading && integrations?.map((i: any) => (
        <div key={i.id} data-testid={`integration-${i.id}`}>
          <span>{i.provider}</span>
          <button onClick={() => onEdit(i)}>EditBtn</button>
          <button onClick={() => onDelete(i.id)}>DeleteBtn</button>
          <button onClick={() => onTest(i.id)}>TestBtn</button>
          <button onClick={() => onToggle(i)}>ToggleBtn</button>
        </div>
      ))}
      <button onClick={onAdd}>AddBtn</button>
    </div>
  ),
}));

vi.mock('../../ui/Button.js', () => ({
  Button: ({ children, onClick, loading }: any) => (
    <button onClick={onClick} disabled={loading}>{children}</button>
  ),
}));

vi.mock('../../ui/ToggleSwitch.js', () => ({
  ToggleSwitch: ({ checked, onChange }: any) => (
    <button data-testid={`toggle-${checked}`} onClick={() => onChange(!checked)} />
  ),
}));

function renderWithQC(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
  );
}

describe('ChatIntegrationsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the list component', async () => {
    renderWithQC(<ChatIntegrationsTab boardId="b1" />);

    await waitFor(() => {
      expect(screen.getByTestId('chat-list')).toBeTruthy();
    });
  });

  it('renders Add button', async () => {
    renderWithQC(<ChatIntegrationsTab boardId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('AddBtn')).toBeTruthy();
    });
  });

  it('renders empty state when no integrations', async () => {
    renderWithQC(<ChatIntegrationsTab boardId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('No integrations')).toBeTruthy();
    });
  });

  it('renders integrations', async () => {
    mockList.mockResolvedValue([
      { id: 'ci1', provider: 'slack', webhookUrl: 'https://hooks.slack.com/test', channelId: null, botToken: null, enabled: 1, events: [], createdAt: '', updatedAt: '' },
    ]);

    renderWithQC(<ChatIntegrationsTab boardId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('slack')).toBeTruthy();
    });
  });

  it('shows form when Add is clicked', async () => {
    renderWithQC(<ChatIntegrationsTab boardId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('AddBtn')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('AddBtn'));

    await waitFor(() => {
      expect(screen.getByTestId('chat-form')).toBeTruthy();
      expect(screen.getByText('Create Form')).toBeTruthy();
    });
  });

  it('calls create API when form submits new integration', async () => {
    mockCreate.mockResolvedValue({ id: 'ci-new' });

    renderWithQC(<ChatIntegrationsTab boardId="b1" />);

    await waitFor(() => {
      expect(screen.getByText('AddBtn')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('AddBtn'));

    await waitFor(() => {
      expect(screen.getByText('Submit')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Submit'));

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith('b1', expect.objectContaining({
        provider: 'slack',
      }));
      expect(mockNotifySuccess).toHaveBeenCalledWith('Integration created');
    });
  });
});
