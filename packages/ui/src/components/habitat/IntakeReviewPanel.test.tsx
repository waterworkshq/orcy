import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntakeReviewPanel } from './IntakeReviewPanel.js';

const mockPromote = vi.fn();
const mockIgnore = vi.fn();
const mockClarify = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

let mockHookReturn: { data: { candidates: Record<string, unknown>[]; total: number } | undefined; isLoading: boolean; isError: boolean; refetch: ReturnType<typeof vi.fn> };

vi.mock('../../api/index.js', () => ({
  api: {
    integrations: {
      listIntakeCandidates: () => Promise.resolve(mockHookReturn.data),
      promoteCandidate: (...args: unknown[]) => mockPromote(...args),
      ignoreCandidate: (...args: unknown[]) => mockIgnore(...args),
      markCandidateNeedsClarification: (...args: unknown[]) => mockClarify(...args),
    },
  },
}));

vi.mock('../../lib/toast.js', () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
  },
}));

vi.mock('../../lib/useHabitatData.js', () => ({
  useIntakeCandidates: () => mockHookReturn,
}));

vi.mock('../../lib/queryKeys.js', () => ({
  queryKeys: {
    integrations: {
      intakeCandidates: () => ['integrations', 'intakeCandidates'],
    },
  },
}));

function makeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cand-1',
    connectionId: 'conn-1',
    habitatId: 'hab-1',
    provider: 'jira',
    externalId: 'EXT-101',
    externalKey: 'PROJ-101',
    externalUrl: 'https://mysite.atlassian.net/browse/PROJ-101',
    sourceKind: 'Bug',
    sourceStatus: 'open',
    sourcePriority: 'High',
    sourceAssignees: ['John'],
    sourceReporter: 'Jane',
    sourceLabels: ['bug', 'frontend'],
    sourceTitle: 'Login page crashes on mobile',
    sourceBody: 'Steps to reproduce...',
    normalizedSummary: null,
    recommendedMissionTitle: null,
    recommendedMissionDescription: null,
    reviewStatus: 'new',
    promotedMissionId: null,
    rawProviderPayload: null,
    externalUpdatedAt: '2026-05-26T10:00:00Z',
    createdAt: '2026-05-26T09:00:00Z',
    updatedAt: '2026-05-26T10:00:00Z',
    ...overrides,
  };
}

function renderWithQC(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function first(text: string): HTMLElement {
  return screen.getAllByText(text)[0];
}

describe('IntakeReviewPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHookReturn = {
      data: { candidates: [makeCandidate()], total: 1 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  });

  it('renders candidate list', () => {
    renderWithQC(<IntakeReviewPanel habitatId="hab-1" />);
    expect(screen.getAllByText('Login page crashes on mobile').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('PROJ-101').length).toBeGreaterThanOrEqual(1);
  });

  it('shows provider badge', () => {
    renderWithQC(<IntakeReviewPanel habitatId="hab-1" />);
    expect(screen.getAllByText('Jira').length).toBeGreaterThanOrEqual(1);
  });

  it('shows review status badge', () => {
    renderWithQC(<IntakeReviewPanel habitatId="hab-1" />);
    expect(screen.getAllByText('New').length).toBeGreaterThanOrEqual(1);
  });

  it('shows total count', () => {
    renderWithQC(<IntakeReviewPanel habitatId="hab-1" />);
    expect(screen.getAllByText(/1 candidate/).length).toBeGreaterThanOrEqual(1);
  });

  it('shows empty state when no candidates', () => {
    mockHookReturn = { data: { candidates: [], total: 0 }, isLoading: false, isError: false, refetch: vi.fn() };
    renderWithQC(<IntakeReviewPanel habitatId="hab-1" />);
    expect(screen.getByText('No intake candidates found.')).toBeInTheDocument();
  });

  it('shows error state with retry button', () => {
    const refetch = vi.fn();
    mockHookReturn = { data: undefined, isLoading: false, isError: true, refetch };
    renderWithQC(<IntakeReviewPanel habitatId="hab-1" />);
    expect(screen.getByText('Failed to load intake candidates.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    expect(refetch).toHaveBeenCalled();
  });

  it('shows detail panel when candidate is selected', () => {
    renderWithQC(<IntakeReviewPanel habitatId="hab-1" />);
    fireEvent.click(first('Login page crashes on mobile'));
    expect(screen.getAllByText('Description').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Steps to reproduce...').length).toBeGreaterThanOrEqual(1);
  });

  it('shows priority, type, assignees in detail panel', () => {
    renderWithQC(<IntakeReviewPanel habitatId="hab-1" />);
    fireEvent.click(first('Login page crashes on mobile'));
    expect(screen.getAllByText('Bug').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('High').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('John').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Jane').length).toBeGreaterThanOrEqual(1);
  });

  it('shows labels in detail panel', () => {
    renderWithQC(<IntakeReviewPanel habitatId="hab-1" />);
    fireEvent.click(first('Login page crashes on mobile'));
    expect(screen.getAllByText('bug').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('frontend').length).toBeGreaterThanOrEqual(1);
  });

  it('shows action buttons for new candidate', () => {
    renderWithQC(<IntakeReviewPanel habitatId="hab-1" />);
    fireEvent.click(first('Login page crashes on mobile'));
    expect(screen.getAllByText('Promote to Mission').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Needs Clarification').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Ignore').length).toBeGreaterThanOrEqual(1);
  });

  it('hides action buttons for promoted candidate', () => {
    mockHookReturn = {
      data: { candidates: [makeCandidate({ reviewStatus: 'promoted', promotedMissionId: 'mis-1' })], total: 1 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    const { container } = renderWithQC(<IntakeReviewPanel habitatId="hab-1" />);
    const promoteButtons = container.querySelectorAll('button');
    for (const btn of promoteButtons) {
      expect(btn.textContent).not.toContain('Promote to Mission');
    }
  });

  it('hides action buttons for ignored candidate', () => {
    mockHookReturn = {
      data: { candidates: [makeCandidate({ reviewStatus: 'ignored' })], total: 1 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    const { container } = renderWithQC(<IntakeReviewPanel habitatId="hab-1" />);
    const promoteButtons = container.querySelectorAll('button');
    for (const btn of promoteButtons) {
      expect(btn.textContent).not.toContain('Promote to Mission');
    }
  });

  it('calls promoteCandidate on promote click', async () => {
    mockPromote.mockResolvedValue({ mission: { id: 'mis-1', title: 'Login page crashes on mobile' }, link: {}, candidate: {} });
    renderWithQC(<IntakeReviewPanel habitatId="hab-1" />);
    fireEvent.click(first('Login page crashes on mobile'));
    fireEvent.click(first('Promote to Mission'));
    await waitFor(() => {
      expect(mockPromote).toHaveBeenCalledWith('cand-1');
      expect(mockNotifySuccess).toHaveBeenCalled();
    });
  });

  it('calls ignoreCandidate on ignore click', async () => {
    mockIgnore.mockResolvedValue({ candidate: {} });
    renderWithQC(<IntakeReviewPanel habitatId="hab-1" />);
    fireEvent.click(first('Login page crashes on mobile'));
    fireEvent.click(first('Ignore'));
    await waitFor(() => {
      expect(mockIgnore).toHaveBeenCalledWith('cand-1');
    });
  });

  it('calls markCandidateNeedsClarification on clarify click', async () => {
    mockClarify.mockResolvedValue({ candidate: makeCandidate({ reviewStatus: 'needs_clarification' }) });
    renderWithQC(<IntakeReviewPanel habitatId="hab-1" />);
    fireEvent.click(first('Login page crashes on mobile'));
    const clarifyBtn = screen.getAllByRole('button', { name: /Needs Clarification/ })[0];
    fireEvent.click(clarifyBtn);
    await waitFor(() => {
      expect(mockClarify).toHaveBeenCalledWith('cand-1');
      expect(mockNotifySuccess).toHaveBeenCalled();
    });
  });

  it('shows error toast on action failure', async () => {
    mockPromote.mockRejectedValue(new Error('Server error'));
    renderWithQC(<IntakeReviewPanel habitatId="hab-1" />);
    fireEvent.click(first('Login page crashes on mobile'));
    fireEvent.click(first('Promote to Mission'));
    await waitFor(() => {
      expect(mockNotifyError).toHaveBeenCalledWith('Server error');
    });
  });

  it('shows external link in detail panel', () => {
    renderWithQC(<IntakeReviewPanel habitatId="hab-1" />);
    fireEvent.click(first('Login page crashes on mobile'));
    const link = screen.getAllByText('Open in provider')[0];
    expect(link.closest('a')).toHaveAttribute('href', 'https://mysite.atlassian.net/browse/PROJ-101');
  });

  it('shows Linear provider badge', () => {
    mockHookReturn = {
      data: { candidates: [makeCandidate({ provider: 'linear', externalKey: 'TEAM-42', sourceKind: null })], total: 1 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    renderWithQC(<IntakeReviewPanel habitatId="hab-1" />);
    expect(screen.getAllByText('Linear').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('TEAM-42').length).toBeGreaterThanOrEqual(1);
  });

  it('shows GitHub provider badge', () => {
    mockHookReturn = {
      data: { candidates: [makeCandidate({ provider: 'github', externalKey: 'acme/repo#99' })], total: 1 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    renderWithQC(<IntakeReviewPanel habitatId="hab-1" />);
    expect(screen.getAllByText('GitHub').length).toBeGreaterThanOrEqual(1);
  });
});
