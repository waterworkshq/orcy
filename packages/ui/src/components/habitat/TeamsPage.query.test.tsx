import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { onlineManager } from '@tanstack/react-query';
import App from '../../App.js';

function makeToken(username: string): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ sub: `user-${username}`, username }));
  return `${header}.${payload}.sig`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mountTeamsRoute(token = makeToken('alice')) {
  localStorage.setItem('orcy_token', token);
  window.history.pushState({}, '', '/teams');
  return render(<App />);
}

describe('TeamsPage mounted route query feedback', () => {
  beforeEach(() => {
    localStorage.clear();
    onlineManager.setOnline(true);
    window.history.pushState({}, '', '/teams');
  });

  afterEach(() => {
    cleanup();
    onlineManager.setOnline(true);
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('distinguishes organization 500 failure from empty state, preserves New Organization, and recovers on retry', async () => {
    let failOrgs = true;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/agents') return Promise.resolve(json({ agents: [] }));
        if (url === '/api/habitats') return Promise.resolve(json({ habitats: [] }));
        if (url === '/api/users/me/teams') return Promise.resolve(json({ teams: [] }));
        if (url === '/api/organizations') {
          if (failOrgs) return Promise.resolve(json({ error: 'Orgs service down' }, 500));
          return Promise.resolve(
            json({
              organizations: [
                { id: 'org-1', name: 'Acme Corp', slug: 'acme-corp', createdAt: '2024-01-01T00:00:00Z' },
              ],
            }),
          );
        }
        return Promise.resolve(json({ error: `Unexpected URL ${url}` }, 404));
      }),
    );

    mountTeamsRoute();

    const retryBtn = await screen.findByRole('button', { name: /retry organizations/i }, { timeout: 4000 });
    expect(screen.getByRole('alert')).toHaveTextContent(/organizations/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/Orgs service down/);
    expect(screen.queryByText('No organizations yet.')).toBeNull();
    expect(screen.getByRole('button', { name: /New Organization/i })).toBeInTheDocument();

    failOrgs = false;
    fireEvent.click(retryBtn);

    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('distinguishes initial paused offline state from empty organizations and loads when back online', async () => {
    onlineManager.setOnline(false);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/agents') return Promise.resolve(json({ agents: [] }));
        if (url === '/api/habitats') return Promise.resolve(json({ habitats: [] }));
        if (url === '/api/users/me/teams') return Promise.resolve(json({ teams: [] }));
        if (url === '/api/organizations') {
          return Promise.resolve(
            json({
              organizations: [
                { id: 'org-1', name: 'Online Corp', slug: 'online-corp', createdAt: '2024-01-01T00:00:00Z' },
              ],
            }),
          );
        }
        return Promise.resolve(json({}, 200));
      }),
    );

    mountTeamsRoute();

    expect(await screen.findByText(/waiting for connectivity to load organizations/i)).toBeInTheDocument();
    expect(screen.queryByText('No organizations yet.')).toBeNull();

    act(() => {
      onlineManager.setOnline(true);
    });

    expect(await screen.findByText('Online Corp')).toBeInTheDocument();
  });

  it('distinguishes paused refresh of a cached empty organization list from a current empty result', async () => {
    localStorage.setItem('orcy_onboarding_completed', 'true');
    let orgsResponse: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/agents') return Promise.resolve(json({ agents: [] }));
        if (url === '/api/habitats') return Promise.resolve(json({ habitats: [] }));
        if (url === '/api/users/me/teams') return Promise.resolve(json({ teams: [] }));
        if (url === '/api/organizations') return Promise.resolve(json({ organizations: orgsResponse }));
        return Promise.resolve(json({ error: `Unexpected URL ${url}` }, 404));
      }),
    );

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mountTeamsRoute();
      expect(await screen.findByText('No organizations yet.')).toBeInTheDocument();

      // Leave /teams, let cache go stale, go offline, then return to /teams
      fireEvent.click(screen.getByTestId('top-nav-echo-base'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);
      });
      onlineManager.setOnline(false);
      orgsResponse = [
        { id: 'org-1', name: 'Refreshed Org', slug: 'refreshed-org', createdAt: '2024-01-01T00:00:00Z' },
      ];
      fireEvent.click(await screen.findByRole('link', { name: /teams/i }));

      expect(await screen.findByText(/waiting for connectivity to load organizations/i)).toBeInTheDocument();
      expect(screen.queryByText('No organizations yet.')).toBeNull();

      act(() => {
        onlineManager.setOnline(true);
      });
      expect(await screen.findByText('Refreshed Org')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains true-empty organizations, teams, and members views on 200 empty responses', async () => {
    let orgsResponse: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/agents') return Promise.resolve(json({ agents: [] }));
        if (url === '/api/organizations') return Promise.resolve(json({ organizations: orgsResponse }));
        if (url === '/api/organizations/org-1/teams') return Promise.resolve(json({ teams: [] }));
        if (url === '/api/organizations/org-2/teams') {
          return Promise.resolve(
            json({
              teams: [
                {
                  id: 'team-2',
                  organizationId: 'org-2',
                  name: 'Empty Team',
                  slug: 'empty-team',
                  createdAt: '2024-01-01T00:00:00Z',
                },
              ],
            }),
          );
        }
        if (url === '/api/teams/team-2/members') return Promise.resolve(json({ members: [] }));
        return Promise.resolve(json({ error: `Unexpected URL ${url}` }, 404));
      }),
    );

    mountTeamsRoute();

    expect(await screen.findByText('No organizations yet.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    cleanup();

    orgsResponse = [
      { id: 'org-1', name: 'Empty Org', slug: 'empty-org', createdAt: '2024-01-01T00:00:00Z' },
      { id: 'org-2', name: 'Org With Empty Team', slug: 'org-two', createdAt: '2024-01-01T00:00:00Z' },
    ];
    mountTeamsRoute();

    fireEvent.click(await screen.findByText('Empty Org'));
    expect(await screen.findByText('No teams yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add Team/i })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(screen.getByText('Org With Empty Team'));
    fireEvent.click(await screen.findByText('Empty Team'));
    expect(await screen.findByText('No members yet.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('distinguishes teams loading and transport failure from empty, keeps siblings working, and recovers on retry', async () => {
    const team1Pending = deferred<Response>();
    let failOrg1Teams = true;
    let useDeferredForOrg1 = true;

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/agents') return Promise.resolve(json({ agents: [] }));
        if (url === '/api/habitats') return Promise.resolve(json({ habitats: [] }));
        if (url === '/api/users/me/teams') return Promise.resolve(json({ teams: [] }));
        if (url === '/api/organizations') {
          return Promise.resolve(
            json({
              organizations: [
                { id: 'org-1', name: 'Alpha Org', slug: 'alpha', createdAt: '2024-01-01T00:00:00Z' },
                { id: 'org-2', name: 'Beta Org', slug: 'beta', createdAt: '2024-01-01T00:00:00Z' },
              ],
            }),
          );
        }
        if (url === '/api/organizations/org-1/teams') {
          if (useDeferredForOrg1) return team1Pending.promise;
          if (failOrg1Teams) return Promise.reject(new TypeError('Failed to fetch'));
          return Promise.resolve(
            json({
              teams: [
                {
                  id: 'team-1',
                  organizationId: 'org-1',
                  name: 'Core Platform',
                  slug: 'core-platform',
                  createdAt: '2024-01-01T00:00:00Z',
                },
              ],
            }),
          );
        }
        if (url === '/api/organizations/org-2/teams') {
          return Promise.resolve(
            json({
              teams: [
                {
                  id: 'team-2',
                  organizationId: 'org-2',
                  name: 'Beta Squad',
                  slug: 'beta-squad',
                  createdAt: '2024-01-01T00:00:00Z',
                },
              ],
            }),
          );
        }
        return Promise.resolve(json({ error: `Unexpected URL ${url}` }, 404));
      }),
    );

    mountTeamsRoute();
    fireEvent.click(await screen.findByText('Alpha Org'));

    expect(screen.getByText(/loading teams/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add Team/i })).toBeNull();

    useDeferredForOrg1 = false;
    await act(async () => {
      team1Pending.reject(new TypeError('Failed to fetch'));
    });

    const retryTeams = await screen.findByRole('button', { name: /retry teams/i }, { timeout: 4000 });
    expect(screen.getByRole('alert')).toHaveTextContent(/teams/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/Failed to fetch/);
    expect(screen.queryByText('No teams yet.')).toBeNull();
    expect(screen.queryByRole('button', { name: /Add Team/i })).toBeNull();

    // Sibling org remains clickable and loads its teams cleanly
    fireEvent.click(screen.getByText('Beta Org'));
    expect(await screen.findByText('Beta Squad')).toBeInTheDocument();

    // Switching back to Alpha Org still shows distinct error and can retry to recover
    fireEvent.click(screen.getByText('Alpha Org'));
    const retryBack = await screen.findByRole('button', { name: /retry teams/i }, { timeout: 4000 });
    failOrg1Teams = false;
    fireEvent.click(retryBack);

    expect(await screen.findByText('Core Platform')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(retryTeams).not.toBeInTheDocument();
  });

  it('distinguishes members loading and 500 failure from empty, keeps siblings working, and recovers on retry', async () => {
    const membersPending = deferred<Response>();
    let useDeferredMembers = true;
    let failTeam1Members = true;

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/agents') return Promise.resolve(json({ agents: [] }));
        if (url === '/api/habitats') return Promise.resolve(json({ habitats: [] }));
        if (url === '/api/users/me/teams') return Promise.resolve(json({ teams: [] }));
        if (url === '/api/organizations') {
          return Promise.resolve(
            json({
              organizations: [
                { id: 'org-1', name: 'Acme Corp', slug: 'acme', createdAt: '2024-01-01T00:00:00Z' },
              ],
            }),
          );
        }
        if (url === '/api/organizations/org-1/teams') {
          return Promise.resolve(
            json({
              teams: [
                {
                  id: 'team-1',
                  organizationId: 'org-1',
                  name: 'Engineering',
                  slug: 'engineering',
                  createdAt: '2024-01-01T00:00:00Z',
                },
                {
                  id: 'team-2',
                  organizationId: 'org-1',
                  name: 'Design',
                  slug: 'design',
                  createdAt: '2024-01-01T00:00:00Z',
                },
              ],
            }),
          );
        }
        if (url === '/api/teams/team-1/members') {
          if (useDeferredMembers) return membersPending.promise;
          if (failTeam1Members) return Promise.resolve(json({ error: 'Members backend unavailable' }, 500));
          return Promise.resolve(
            json({
              members: [
                {
                  id: 'mem-1',
                  teamId: 'team-1',
                  userId: 'alice-uuid',
                  role: 'owner',
                  joinedAt: '2024-01-01T00:00:00Z',
                },
              ],
            }),
          );
        }
        if (url === '/api/teams/team-2/members') {
          return Promise.resolve(
            json({
              members: [
                {
                  id: 'mem-2',
                  teamId: 'team-2',
                  userId: 'bob-uuid',
                  role: 'admin',
                  joinedAt: '2024-01-01T00:00:00Z',
                },
              ],
            }),
          );
        }
        return Promise.resolve(json({ error: `Unexpected URL ${url}` }, 404));
      }),
    );

    mountTeamsRoute();
    fireEvent.click(await screen.findByText('Acme Corp'));
    fireEvent.click(await screen.findByText('Engineering'));

    expect(screen.getByText(/loading members/i)).toBeInTheDocument();
    expect(screen.queryByText('No members yet.')).toBeNull();

    useDeferredMembers = false;
    await act(async () => {
      membersPending.resolve(json({ error: 'Members backend unavailable' }, 500));
    });

    await screen.findByRole('button', { name: /retry members/i }, { timeout: 4000 });
    expect(screen.getByRole('alert')).toHaveTextContent(/members/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/Members backend unavailable/);
    expect(screen.queryByText('No members yet.')).toBeNull();

    // Working sibling team loads its members cleanly
    fireEvent.click(screen.getByText('Design'));
    expect(await screen.findByText('bob-uuid')).toBeInTheDocument();

    // Switch back to Engineering and retry
    fireEvent.click(screen.getByText('Engineering'));
    const retryMembers = await screen.findByRole('button', { name: /retry members/i }, { timeout: 4000 });
    failTeam1Members = false;
    fireEvent.click(retryMembers);

    expect(await screen.findByText('alice-uuid')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('honestly reports background refresh failures while preserving retained data and hierarchical selection', async () => {
    let failOrgs = false;
    let failTeams = false;
    let failMembers = false;

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/agents') return Promise.resolve(json({ agents: [] }));
        if (url === '/api/habitats') return Promise.resolve(json({ habitats: [] }));
        if (url === '/api/users/me/teams') return Promise.resolve(json({ teams: [] }));
        if (url === '/api/organizations') {
          if (failOrgs) return Promise.resolve(json({ error: 'Orgs refresh failed' }, 500));
          return Promise.resolve(
            json({
              organizations: [
                { id: 'org-1', name: 'Acme Corp', slug: 'acme', createdAt: '2024-01-01T00:00:00Z' },
              ],
            }),
          );
        }
        if (url === '/api/organizations/org-1/teams') {
          if (failTeams) return Promise.resolve(json({ error: 'Teams refresh failed' }, 500));
          return Promise.resolve(
            json({
              teams: [
                {
                  id: 'team-1',
                  organizationId: 'org-1',
                  name: 'Engineering',
                  slug: 'engineering',
                  createdAt: '2024-01-01T00:00:00Z',
                },
              ],
            }),
          );
        }
        if (url === '/api/teams/team-1/members') {
          if (failMembers) return Promise.resolve(json({ error: 'Members refresh failed' }, 500));
          return Promise.resolve(
            json({
              members: [
                {
                  id: 'mem-1',
                  teamId: 'team-1',
                  userId: 'retained-user',
                  role: 'owner',
                  joinedAt: '2024-01-01T00:00:00Z',
                },
              ],
            }),
          );
        }
        return Promise.resolve(json({ error: `Unexpected URL ${url}` }, 404));
      }),
    );

    localStorage.setItem('orcy_onboarding_completed', 'true');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mountTeamsRoute();

      fireEvent.click(await screen.findByText('Acme Corp'));
      fireEvent.click(await screen.findByText('Engineering'));
      expect(await screen.findByText('retained-user')).toBeInTheDocument();

      // Advance past 5m staleTime and trigger background failures via navigation back to /teams
      failOrgs = true;
      failTeams = true;
      failMembers = true;

      fireEvent.click(screen.getByTestId('top-nav-echo-base'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);
      });
      const teamsLink = await screen.findByRole('link', { name: /teams/i });
      fireEvent.click(teamsLink);

      // Retained org list is visible alongside honest background-refresh failure
      expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
      const orgAlert = await screen.findByRole('alert', {}, { timeout: 4000 });
      expect(orgAlert).toHaveTextContent(/showing cached organizations/i);
      expect(orgAlert).toHaveTextContent(/Orgs refresh failed/);

      failOrgs = false;
      fireEvent.click(screen.getByRole('button', { name: /retry organizations/i }));
      await waitFor(() => expect(screen.queryByText(/showing cached organizations/i)).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows error and retry instead of empty text if a refresh of an empty cache fails', async () => {
    localStorage.setItem('orcy_onboarding_completed', 'true');
    let failOrgs = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/agents') return Promise.resolve(json({ agents: [] }));
        if (url === '/api/habitats') return Promise.resolve(json({ habitats: [] }));
        if (url === '/api/users/me/teams') return Promise.resolve(json({ teams: [] }));
        if (url === '/api/organizations') {
          if (failOrgs) return Promise.resolve(json({ error: 'Orgs refresh unavailable' }, 500));
          return Promise.resolve(json({ organizations: [] }));
        }
        return Promise.resolve(json({ error: `Unexpected URL ${url}` }, 404));
      }),
    );

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mountTeamsRoute();
      expect(await screen.findByText('No organizations yet.')).toBeInTheDocument();

      failOrgs = true;
      fireEvent.click(screen.getByTestId('top-nav-echo-base'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);
      });
      fireEvent.click(await screen.findByRole('link', { name: /teams/i }));

      await screen.findByRole('button', { name: /retry organizations/i }, { timeout: 4000 });
      expect(screen.getByRole('alert')).toHaveTextContent(/could not refresh organizations/i);
      expect(screen.queryByText('No organizations yet.')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows retained teams and members honestly with selection preserved when their background refreshes fail', async () => {
    let failOrgs = false;
    let failTeams = false;
    let failMembers = false;

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url === '/api/agents') return Promise.resolve(json({ agents: [] }));
        if (url === '/api/organizations') {
          if (failOrgs) return Promise.resolve(json({ error: 'Orgs refresh failed' }, 500));
          return Promise.resolve(
            json({
              organizations: [
                { id: 'org-1', name: 'Acme Corp', slug: 'acme', createdAt: '2024-01-01T00:00:00Z' },
              ],
            }),
          );
        }
        if (url === '/api/organizations/org-1/teams' && method === 'GET') {
          if (failTeams) return Promise.resolve(json({ error: 'Teams refresh failed' }, 500));
          return Promise.resolve(
            json({
              teams: [
                {
                  id: 'team-1',
                  organizationId: 'org-1',
                  name: 'Engineering',
                  slug: 'engineering',
                  createdAt: '2024-01-01T00:00:00Z',
                },
              ],
            }),
          );
        }
        if (url === '/api/teams/team-1/members' && method === 'GET') {
          if (failMembers) return Promise.resolve(json({ error: 'Members refresh failed' }, 500));
          return Promise.resolve(
            json({
              members: [
                {
                  id: 'mem-1',
                  teamId: 'team-1',
                  userId: 'retained-user',
                  role: 'owner',
                  joinedAt: '2024-01-01T00:00:00Z',
                },
              ],
            }),
          );
        }
        if (url === '/api/teams/team-1/members' && method === 'POST') {
          return Promise.resolve(
            json({
              member: {
                id: 'mem-2',
                teamId: 'team-1',
                userId: 'new-user',
                role: 'member',
                joinedAt: '2024-01-02T00:00:00Z',
              },
            }),
          );
        }
        if (url === '/api/organizations/org-1/teams' && method === 'POST') {
          return Promise.resolve(
            json({
              team: {
                id: 'team-2',
                organizationId: 'org-1',
                name: 'QA',
                slug: 'qa',
                createdAt: '2024-01-02T00:00:00Z',
              },
            }),
          );
        }
        return Promise.resolve(json({ error: `Unexpected URL ${url}` }, 404));
      }),
    );

    mountTeamsRoute();

    const orgButton = await screen.findByRole('button', { name: 'Acme Corp' });
    fireEvent.click(orgButton);
    const teamButton = await screen.findByRole('button', { name: 'Engineering' });
    fireEvent.click(teamButton);
    expect(await screen.findByText('retained-user')).toBeInTheDocument();

    // Trigger background member refetch via Add Member invalidation while GET /members fails
    failMembers = true;
    fireEvent.click(screen.getByRole('button', { name: /Add Member/i }));
    fireEvent.change(screen.getByPlaceholderText('User UUID'), { target: { value: 'new-user' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add' }).pop()!);

    const memberRetry = await screen.findByRole('button', { name: /retry members/i }, { timeout: 4000 });
    expect(screen.getByText('retained-user')).toBeInTheDocument();
    expect(screen.getByText(/showing cached members/i)).toBeInTheDocument();
    expect(screen.getByText(/Members refresh failed/)).toBeInTheDocument();
    // Hierarchical selection remains preserved
    expect(screen.getByRole('button', { name: 'Acme Corp' })).toHaveClass('bg-primary');
    expect(screen.getByRole('button', { name: 'Engineering' })).toHaveClass('bg-primary');

    // Also trigger background team refetch via Add Team invalidation while GET /teams fails
    failTeams = true;
    fireEvent.click(screen.getByRole('button', { name: /Add Team/i }));
    fireEvent.change(screen.getByPlaceholderText('Engineering'), { target: { value: 'QA' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create' }).pop()!);

    const teamRetry = await screen.findByRole('button', { name: /retry teams/i }, { timeout: 4000 });
    expect(screen.getByRole('button', { name: 'Engineering' })).toHaveClass('bg-primary');
    expect(screen.getByText(/showing cached teams/i)).toBeInTheDocument();
    expect(screen.getByText(/Teams refresh failed/)).toBeInTheDocument();
    // Both distinct retries are visible simultaneously
    expect(memberRetry).toBeInTheDocument();

    // Recover teams only -> members alert stays until members retried
    failTeams = false;
    fireEvent.click(teamRetry);
    await waitFor(() => expect(screen.queryByText(/showing cached teams/i)).toBeNull());
    expect(screen.getByText(/showing cached members/i)).toBeInTheDocument();

    failMembers = false;
    fireEvent.click(screen.getByRole('button', { name: /retry members/i }));
    await waitFor(() => expect(screen.queryByText(/showing cached members/i)).toBeNull());
  });

  it('scopes organizations, teams, members, and errors to the active account on logout/login', async () => {
    const aliceDelayed = deferred<Response>();
    let aliceSignal: AbortSignal | undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
        if (url === '/api/agents') return Promise.resolve(json({ agents: [] }));
        if (url === '/api/auth/logout') return Promise.resolve(json({ success: true }));
        if (url === '/api/auth/setup-status') return Promise.resolve(json({ needsSetup: false }));
        if (url === '/api/auth/login') return Promise.resolve(json({ token: makeToken('bob') }));
        if (url === '/api/habitats') return Promise.resolve(json({ habitats: [] }));
        if (url === '/api/users/me/teams') return Promise.resolve(json({ teams: [] }));
        if (url === '/api/organizations') {
          if (auth.includes(makeToken('alice'))) {
            aliceSignal = init?.signal ?? undefined;
            return aliceDelayed.promise;
          }
          return Promise.resolve(
            json({
              organizations: [
                { id: 'bob-org', name: 'Bob Org', slug: 'bob-org', createdAt: '2024-01-01T00:00:00Z' },
              ],
            }),
          );
        }
        return Promise.resolve(json({ error: `Unexpected URL ${url}` }, 404));
      }),
    );

    mountTeamsRoute(makeToken('alice'));
    await waitFor(() => expect(aliceSignal).toBeDefined());

    // Logout Alice -> old request aborted; sign in Bob -> navigate to /teams
    fireEvent.click(screen.getByRole('button', { name: 'User menu' }));
    fireEvent.click(screen.getByTestId('user-menu-logout'));

    expect(aliceSignal?.aborted).toBe(true);

    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'bob' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));

    const teamsLink = await screen.findByRole('link', { name: /teams/i });
    fireEvent.click(teamsLink);

    expect(await screen.findByText('Bob Org')).toBeInTheDocument();

    // Late resolution for Alice never leaks into Bob's Teams view
    await act(async () => {
      aliceDelayed.resolve(
        json({
          organizations: [
            { id: 'alice-org', name: 'Alice Secret Org', slug: 'alice-org', createdAt: '2024-01-01T00:00:00Z' },
          ],
        }),
      );
    });

    expect(screen.queryByText('Alice Secret Org')).toBeNull();
    expect(screen.getByText('Bob Org')).toBeInTheDocument();
  });
});
