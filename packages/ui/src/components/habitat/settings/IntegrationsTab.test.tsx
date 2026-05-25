import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntegrationsTab } from './IntegrationsTab.js';

const mockList = vi.fn();
const mockCreatePat = vi.fn();
const mockUpdate = vi.fn();
const mockDisable = vi.fn();
const mockSync = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

vi.mock('../../../api/index.js', () => ({
  api: {
    integrations: {
      list: (...args: unknown[]) => mockList(...args),
      createGitHubPat: (...args: unknown[]) => mockCreatePat(...args),
      startGitHubDeviceFlow: () => Promise.resolve({
        deviceCode: 'dc-1',
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
        interval: 5,
      }),
      pollGitHubDeviceFlow: () => Promise.resolve({ status: 'pending' }),
      update: (...args: unknown[]) => mockUpdate(...args),
      disable: (...args: unknown[]) => mockDisable(...args),
      sync: (...args: unknown[]) => mockSync(...args),
      listSyncRuns: () => Promise.resolve({ syncRuns: [] }),
      listMissionLinks: () => Promise.resolve({ externalLinks: [] }),
    },
  },
}));

vi.mock('../../../lib/toast.js', () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
  },
}));

vi.mock('../../ui/Button.js', () => ({
  Button: ({ children, onClick, loading, disabled }: any) => (
    <button onClick={onClick} disabled={loading || disabled}>{children}</button>
  ),
}));

vi.mock('../../ui/ToggleSwitch.js', () => ({
  ToggleSwitch: ({ checked, onChange, disabled }: any) => (
    <button
      data-testid={`toggle-${checked ? 'on' : 'off'}`}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
    />
  ),
}));

vi.mock('./GitHubIntegrationPanel.js', () => ({
  GitHubIntegrationPanel: ({ connection, onSync, onDisconnect }: any) => (
    <div data-testid={`github-panel-${connection.id}`}>
      <span>{connection.name}</span>
      <span>{connection.repositoryOwner}/{connection.repositoryName}</span>
      <button onClick={() => onSync(connection.id)}>SyncBtn</button>
      <button onClick={() => onDisconnect(connection.id)}>DisconnectBtn</button>
    </div>
  ),
}));

function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    habitatId: 'hab-1',
    provider: 'github',
    name: 'Test Connection',
    authMethod: 'pat',
    hasAccessToken: true,
    hasRefreshToken: false,
    hasWebhookSecret: true,
    externalAccountId: null,
    externalAccountName: null,
    externalTenantId: null,
    externalTenantName: null,
    externalBaseUrl: null,
    repositoryOwner: 'acme',
    repositoryName: 'repo',
    projectKey: null,
    teamId: null,
    providerConfig: {},
    enabled: true,
    pullEnabled: true,
    autoImport: false,
    webhookExternalId: null,
    lastSyncAt: '2026-05-25T10:00:00Z',
    lastSyncStatus: 'success' as const,
    lastSyncError: null,
    createdBy: 'user-1',
    createdAt: '2026-05-25T10:00:00Z',
    updatedAt: '2026-05-25T10:00:00Z',
    ...overrides,
  };
}

function renderWithQC(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
    },
  });
  return render(
    <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue({ integrations: [] });
});

describe('IntegrationsTab', () => {
  it('shows empty state when no connections exist', async () => {
    renderWithQC(<IntegrationsTab habitatId="hab-1" />);
    expect(await screen.findByText(/No GitHub connections/)).toBeInTheDocument();
  });

  it('shows connect button when empty', async () => {
    renderWithQC(<IntegrationsTab habitatId="hab-1" />);
    expect((await screen.findAllByText('Connect with GitHub')).length).toBeGreaterThanOrEqual(1);
  });

  it('opens PAT form on click', async () => {
    renderWithQC(<IntegrationsTab habitatId="hab-1" />);
    fireEvent.click(await screen.findByText(/Use a personal access token instead/));
    expect(screen.getAllByText(/Personal Access Token/).length).toBeGreaterThanOrEqual(1);
  });

  it('lists existing GitHub connections', async () => {
    mockList.mockResolvedValue({ integrations: [makeConnection()] });
    renderWithQC(<IntegrationsTab habitatId="hab-1" />);
    expect(await screen.findByText('Test Connection')).toBeInTheDocument();
    expect(screen.getByText(/acme\/repo/)).toBeInTheDocument();
  });

  it('shows other providers placeholder', async () => {
    renderWithQC(<IntegrationsTab habitatId="hab-1" />);
    expect((await screen.findAllByText(/Jira and Linear/)).length).toBeGreaterThanOrEqual(1);
  });

  it('creates PAT connection on form submit', async () => {
    mockCreatePat.mockResolvedValue({ integration: makeConnection() });
    renderWithQC(<IntegrationsTab habitatId="hab-1" />);
    fireEvent.click((await screen.findAllByText(/Use a personal access token instead/))[0]);

    await waitFor(() => {
      expect(screen.getAllByText(/Connect via/).length).toBeGreaterThanOrEqual(1);
    });

    const nameInputs = screen.getAllByPlaceholderText('My GitHub Repo');
    const tokenInputs = screen.getAllByPlaceholderText('ghp_...');
    const ownerInputs = screen.getAllByPlaceholderText('owner or org');
    const repoInputs = screen.getAllByPlaceholderText('my-repo');
    fireEvent.change(nameInputs[0], { target: { value: 'Test' } });
    fireEvent.change(tokenInputs[0], { target: { value: 'ghp_test123' } });
    fireEvent.change(ownerInputs[0], { target: { value: 'acme' } });
    fireEvent.change(repoInputs[0], { target: { value: 'repo' } });

    const allForms = screen.getAllByText('Connect');
    const submitBtn = allForms.find((el) => el.closest('form'));
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockCreatePat).toHaveBeenCalledWith('hab-1', expect.objectContaining({
        name: 'Test',
        token: 'ghp_test123',
        repositoryOwner: 'acme',
        repositoryName: 'repo',
      }));
    });
  });

  it('shows OAuth device flow code on connect click', async () => {
    renderWithQC(<IntegrationsTab habitatId="hab-1" />);
    fireEvent.click((await screen.findAllByText('Connect with GitHub'))[0]);
    expect(await screen.findByText('ABCD-1234')).toBeInTheDocument();
    expect(screen.getAllByText(/Authorizing with GitHub/).length).toBeGreaterThanOrEqual(1);
  });
});
