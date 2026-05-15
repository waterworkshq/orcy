import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { TeamsPage } from './TeamsPage.js';

const mockUseOrganizations = vi.fn();
const mockUseOrganizationTeams = vi.fn();
const mockUseTeamMembers = vi.fn();

vi.mock('../../lib/useHabitatData.js', () => ({
  useOrganizations: (...args: unknown[]) => mockUseOrganizations(...args),
  useOrganizationTeams: (...args: unknown[]) => mockUseOrganizationTeams(...args),
  useTeamMembers: (...args: unknown[]) => mockUseTeamMembers(...args),
}));

const mockInvalidateQueries = vi.fn().mockResolvedValue(undefined);

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual('@tanstack/react-query');
  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: mockInvalidateQueries,
    }),
  };
});

const mockOrgsList = vi.fn();
const mockOrgsCreate = vi.fn();
const mockOrgsCreateTeam = vi.fn();
const mockOrgsListTeams = vi.fn();
const mockTeamsListMembers = vi.fn();
const mockTeamsAddMember = vi.fn();
const mockTeamsRemoveMember = vi.fn();
const mockTeamsDelete = vi.fn();

vi.mock('../../api/index.js', () => ({
  api: {
    organizations: {
      list: (...args: unknown[]) => mockOrgsList(...args),
      create: (...args: unknown[]) => mockOrgsCreate(...args),
      createTeam: (...args: unknown[]) => mockOrgsCreateTeam(...args),
      listTeams: (...args: unknown[]) => mockOrgsListTeams(...args),
    },
    teams: {
      listMembers: (...args: unknown[]) => mockTeamsListMembers(...args),
      addMember: (...args: unknown[]) => mockTeamsAddMember(...args),
      removeMember: (...args: unknown[]) => mockTeamsRemoveMember(...args),
      delete: (...args: unknown[]) => mockTeamsDelete(...args),
    },
  },
}));

vi.mock('../../lib/toast.js', () => ({
  notify: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../ui/Button.js', () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>{children}</button>
  ),
}));

function renderWithQueryClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>{ui}</QueryClientProvider>,
  );
}

const org1 = { id: 'org-1', name: 'Acme Corp', slug: 'acme-corp' };
const org2 = { id: 'org-2', name: 'Beta Inc', slug: 'beta-inc' };
const team1 = { id: 'team-1', name: 'Engineering', slug: 'engineering', orgId: 'org-1' };
const team2 = { id: 'team-2', name: 'Design', slug: 'design', orgId: 'org-1' };
const member1 = {
  id: 'mem-1',
  teamId: 'team-1',
  userId: 'user-1',
  role: 'owner' as const,
  joinedAt: '2024-01-15T00:00:00Z',
};
const member2 = {
  id: 'mem-2',
  teamId: 'team-1',
  userId: 'user-2',
  role: 'member' as const,
  joinedAt: '2024-02-20T00:00:00Z',
};

describe('TeamsPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();

    mockUseOrganizations.mockReturnValue({
      data: [org1, org2],
      isLoading: false,
    });
    mockUseOrganizationTeams.mockReturnValue({
      data: [],
      isLoading: false,
    });
    mockUseTeamMembers.mockReturnValue({
      data: [],
      isLoading: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('calls useOrganizations on mount', () => {
    renderWithQueryClient(<TeamsPage />);
    expect(mockUseOrganizations).toHaveBeenCalled();
  });

  it('renders organizations from useOrganizations', () => {
    renderWithQueryClient(<TeamsPage />);
    expect(screen.getByText('Acme Corp')).toBeTruthy();
    expect(screen.getByText('Beta Inc')).toBeTruthy();
  });

  it('shows loading spinner when organizations are loading', () => {
    mockUseOrganizations.mockReturnValue({
      data: undefined,
      isLoading: true,
    });
    renderWithQueryClient(<TeamsPage />);
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeTruthy();
  });

  it('does not show spinner when organizations loaded', () => {
    renderWithQueryClient(<TeamsPage />);
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeNull();
  });

  it('calls useOrganizationTeams with undefined when no org selected', () => {
    renderWithQueryClient(<TeamsPage />);
    expect(mockUseOrganizationTeams).toHaveBeenCalledWith(undefined);
  });

  it('calls useOrganizationTeams with orgId when org is selected', () => {
    renderWithQueryClient(<TeamsPage />);
    fireEvent.click(screen.getByText('Acme Corp'));
    expect(mockUseOrganizationTeams).toHaveBeenCalledWith('org-1');
  });

  it('shows teams after selecting an organization', () => {
    mockUseOrganizationTeams.mockReturnValue({
      data: [team1, team2],
      isLoading: false,
    });

    renderWithQueryClient(<TeamsPage />);
    fireEvent.click(screen.getByText('Acme Corp'));

    expect(screen.getByText('Engineering')).toBeTruthy();
    expect(screen.getByText('Design')).toBeTruthy();
  });

  it('calls useTeamMembers with undefined when no team selected', () => {
    renderWithQueryClient(<TeamsPage />);
    expect(mockUseTeamMembers).toHaveBeenCalledWith(undefined);
  });

  it('calls useTeamMembers with teamId when team is selected', () => {
    mockUseOrganizationTeams.mockReturnValue({
      data: [team1],
      isLoading: false,
    });

    renderWithQueryClient(<TeamsPage />);
    fireEvent.click(screen.getByText('Acme Corp'));
    fireEvent.click(screen.getByText('Engineering'));

    expect(mockUseTeamMembers).toHaveBeenCalledWith('team-1');
  });

  it('shows members after selecting a team', () => {
    mockUseOrganizationTeams.mockReturnValue({
      data: [team1],
      isLoading: false,
    });
    mockUseTeamMembers.mockReturnValue({
      data: [member1, member2],
      isLoading: false,
    });

    renderWithQueryClient(<TeamsPage />);
    fireEvent.click(screen.getByText('Acme Corp'));
    fireEvent.click(screen.getByText('Engineering'));

    expect(screen.getByText('user-1')).toBeTruthy();
    expect(screen.getByText('user-2')).toBeTruthy();
  });

  it('resets team selection when switching organizations', () => {
    mockUseOrganizationTeams.mockImplementation((orgId: string | undefined) => {
      if (orgId === 'org-1') return { data: [team1], isLoading: false };
      return { data: [], isLoading: false };
    });
    mockUseTeamMembers.mockImplementation((tId: string | undefined) => {
      if (tId === 'team-1') return { data: [member1], isLoading: false };
      return { data: [], isLoading: false };
    });

    renderWithQueryClient(<TeamsPage />);

    fireEvent.click(screen.getByText('Acme Corp'));
    fireEvent.click(screen.getByText('Engineering'));
    expect(screen.getByText('user-1')).toBeTruthy();

    fireEvent.click(screen.getByText('Beta Inc'));
    expect(screen.queryByText('user-1')).toBeNull();
  });

  it('shows "Select a team to manage members" when no team selected', () => {
    renderWithQueryClient(<TeamsPage />);
    expect(screen.getByText('Select a team to manage members')).toBeTruthy();
  });

  it('shows "No organizations yet" when no orgs', () => {
    mockUseOrganizations.mockReturnValue({
      data: [],
      isLoading: false,
    });
    renderWithQueryClient(<TeamsPage />);
    expect(screen.getByText('No organizations yet.')).toBeTruthy();
  });

  it('shows "No members yet" when team has no members', () => {
    mockUseOrganizationTeams.mockReturnValue({
      data: [team1],
      isLoading: false,
    });
    mockUseTeamMembers.mockReturnValue({
      data: [],
      isLoading: false,
    });

    renderWithQueryClient(<TeamsPage />);
    fireEvent.click(screen.getByText('Acme Corp'));
    fireEvent.click(screen.getByText('Engineering'));

    expect(screen.getByText('No members yet.')).toBeTruthy();
  });

  it('opens create org dialog', () => {
    renderWithQueryClient(<TeamsPage />);
    fireEvent.click(screen.getByText('New Organization'));
    expect(screen.getByText('Create Organization')).toBeTruthy();
  });

  it('creates an organization and invalidates cache', async () => {
    const newOrg = { id: 'org-new', name: 'New Corp', slug: 'new-corp' };
    mockOrgsCreate.mockResolvedValue(newOrg);

    renderWithQueryClient(<TeamsPage />);
    fireEvent.click(screen.getByText('New Organization'));

    const nameInput = screen.getByPlaceholderText('Acme Corp');
    fireEvent.change(nameInput, { target: { value: 'New Corp' } });
    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      expect(mockOrgsCreate).toHaveBeenCalledWith({ name: 'New Corp', slug: 'new-corp' });
      expect(mockInvalidateQueries).toHaveBeenCalled();
    });
  });

  it('creates a team and invalidates cache', async () => {
    const newTeam = { id: 'team-new', name: 'QA Team', slug: 'qa-team', orgId: 'org-1' };
    mockUseOrganizationTeams.mockReturnValue({
      data: [team1],
      isLoading: false,
    });
    mockOrgsCreateTeam.mockResolvedValue(newTeam);

    renderWithQueryClient(<TeamsPage />);
    fireEvent.click(screen.getByText('Acme Corp'));
    fireEvent.click(screen.getByText('Add Team'));

    const nameInput = screen.getByPlaceholderText('Engineering');
    fireEvent.change(nameInput, { target: { value: 'QA Team' } });
    fireEvent.click(screen.getAllByText('Create').pop()!);

    await waitFor(() => {
      expect(mockOrgsCreateTeam).toHaveBeenCalledWith('org-1', {
        name: 'QA Team',
        slug: 'qa-team',
      });
      expect(mockInvalidateQueries).toHaveBeenCalled();
    });
  });

  it('adds a member and invalidates cache', async () => {
    mockUseOrganizationTeams.mockReturnValue({
      data: [team1],
      isLoading: false,
    });
    mockUseTeamMembers.mockReturnValue({
      data: [member1],
      isLoading: false,
    });
    const newMember = {
      id: 'mem-new',
      teamId: 'team-1',
      userId: 'user-new',
      role: 'admin',
      joinedAt: '2024-03-01T00:00:00Z',
    };
    mockTeamsAddMember.mockResolvedValue(newMember);

    renderWithQueryClient(<TeamsPage />);
    fireEvent.click(screen.getByText('Acme Corp'));
    fireEvent.click(screen.getByText('Engineering'));
    fireEvent.click(screen.getByText('Add Member'));

    const userIdInput = screen.getByPlaceholderText('User UUID');
    fireEvent.change(userIdInput, { target: { value: 'user-new' } });
    fireEvent.click(screen.getAllByText('Add').pop()!);

    await waitFor(() => {
      expect(mockTeamsAddMember).toHaveBeenCalledWith('team-1', {
        userId: 'user-new',
        role: 'member',
      });
      expect(mockInvalidateQueries).toHaveBeenCalled();
    });
  });

  it('deletes a team and invalidates cache', async () => {
    mockUseOrganizationTeams.mockReturnValue({
      data: [team1],
      isLoading: false,
    });
    mockTeamsDelete.mockResolvedValue(undefined);

    const { container } = renderWithQueryClient(<TeamsPage />);
    fireEvent.click(screen.getByText('Acme Corp'));

    const deleteButtons = container.querySelectorAll('button.text-muted-foreground.hover\\:text-destructive');
    expect(deleteButtons.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(mockTeamsDelete).toHaveBeenCalledWith('team-1');
      expect(mockInvalidateQueries).toHaveBeenCalled();
    });
  });

  it('removes a member and invalidates cache', async () => {
    mockUseOrganizationTeams.mockReturnValue({
      data: [team1],
      isLoading: false,
    });
    mockUseTeamMembers.mockReturnValue({
      data: [member1],
      isLoading: false,
    });
    mockTeamsRemoveMember.mockResolvedValue(undefined);

    const { container } = renderWithQueryClient(<TeamsPage />);
    fireEvent.click(screen.getByText('Acme Corp'));
    fireEvent.click(screen.getByText('Engineering'));

    const deleteButtons = container.querySelectorAll('button.text-muted-foreground.hover\\:text-destructive');
    const memberDeleteBtn = deleteButtons[deleteButtons.length - 1];
    fireEvent.click(memberDeleteBtn);

    await waitFor(() => {
      expect(mockTeamsRemoveMember).toHaveBeenCalledWith('team-1', 'user-1');
      expect(mockInvalidateQueries).toHaveBeenCalled();
    });
  });

  it('renders member role badges', () => {
    mockUseOrganizationTeams.mockReturnValue({
      data: [team1],
      isLoading: false,
    });
    mockUseTeamMembers.mockReturnValue({
      data: [member1, member2],
      isLoading: false,
    });

    renderWithQueryClient(<TeamsPage />);
    fireEvent.click(screen.getByText('Acme Corp'));
    fireEvent.click(screen.getByText('Engineering'));

    expect(screen.getByText('owner')).toBeTruthy();
    expect(screen.getByText('member')).toBeTruthy();
  });

  it('disables teams query when no org selected', () => {
    mockUseOrganizationTeams.mockReturnValue({
      data: undefined,
      isLoading: false,
      fetchStatus: 'idle',
    });

    renderWithQueryClient(<TeamsPage />);
    expect(mockUseOrganizationTeams).toHaveBeenCalledWith(undefined);
    const teamsSection = screen.queryByText('Teams', { selector: 'h2' });
    expect(teamsSection).toBeNull();
  });

  it('disables members query when no team selected', () => {
    mockUseTeamMembers.mockReturnValue({
      data: undefined,
      isLoading: false,
      fetchStatus: 'idle',
    });

    renderWithQueryClient(<TeamsPage />);
    expect(mockUseTeamMembers).toHaveBeenCalledWith(undefined);
  });
});
