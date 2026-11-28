import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, MemoryRouter } from 'react-router-dom';
import { DashboardPage } from '../pages/DashboardPage.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it('shows completion activity for the selected period and Habitat and keeps scopes distinct', async () => {
  const requests: string[] = [];
  localStorage.setItem('orcy_token', 'synthetic-token');
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://local.test');
    if (url.pathname !== '/api/dashboard') return new Response('{}', { status: 404 });
    requests.push(url.search);
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-token');
    const scope = `${url.searchParams.get('habitatId')}:${url.searchParams.get('period')}`;
    const counts: Record<string, number[]> = { 'alpha:7d': [1, 2], 'alpha:90d': [2, 5], 'beta:90d': [4, 5], 'beta:7d': [] };
    const throughput = (counts[scope] ?? [99]).map((count, i) => ({ date: `2026-11-2${i}`, count }));
    return Response.json({ throughput, cycleTime: [], rejectionRate: [], agentLeaderboard: [], taskByPriority: [], taskByStatus: [], wipHealth: [], webhookStats: { total: 0, success: 0, failed: 0, pending: 0, successRate: 0 }, summary: { totalTasksCompleted: 88, totalTasksInProgress: 6, averageCycleTimeMinutes: 0, overallRejectionRate: 0, activeAgents: 0 } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/dashboard?habitatId=alpha&period=7d']}><Link to="/dashboard?habitatId=beta&period=90d">Beta</Link><Link to="/dashboard?habitatId=alpha&period=7d">Alpha</Link><DashboardPage /></MemoryRouter></QueryClientProvider>);
  const card = async (value: string, period: string) => {
    const title = await screen.findByText('Tasks Completed');
    const container = title.parentElement!;
    expect(within(container).getByText(value)).toBeInTheDocument();
    expect(within(container).getByText(`In last ${period}`)).toBeInTheDocument();
  };
  await card('3', '7d');
  expect(screen.getByText('6')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '90d' } });
  await screen.findByText('In last 90d');
  await card('7', '90d');
  fireEvent.click(screen.getByText('Beta'));
  await screen.findByText('9');
  await card('9', '90d');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '7d' } });
  await screen.findByText('In last 7d');
  await card('0', '7d');
  fireEvent.click(screen.getByText('Alpha'));
  await screen.findByText('3');
  await card('3', '7d');
  expect(requests).toHaveLength(4);
  expect(requests).toEqual(expect.arrayContaining(['?habitatId=alpha&period=7d', '?habitatId=alpha&period=90d', '?habitatId=beta&period=90d', '?habitatId=beta&period=7d']));
});

it('uses the 30 day scope for an unsupported period in a deep link', async () => {
  const habitatId = '11111111-1111-4111-8111-111111111111';
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://local.test');
    requests.push(url.pathname + url.search);
    if (url.pathname !== '/api/dashboard') return new Response('{}', { status: 404 });
    if (url.searchParams.get('period') !== '30d') {
      return Response.json({ error: 'Invalid query params' }, { status: 400 });
    }
    return Response.json({ throughput: [{ date: '2026-11-20', count: 2 }], cycleTime: [], rejectionRate: [], agentLeaderboard: [], taskByPriority: [], taskByStatus: [], wipHealth: [], webhookStats: { total: 0, success: 0, failed: 0, pending: 0, successRate: 0 }, summary: { totalTasksCompleted: 88, totalTasksInProgress: 6, averageCycleTimeMinutes: 0, overallRejectionRate: 0, activeAgents: 0 } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/dashboard?habitatId=${habitatId}&period=bogus`]}><Link to={`/dashboard?habitatId=${habitatId}`}>Default period</Link><DashboardPage /></MemoryRouter></QueryClientProvider>);
  await waitFor(() => expect(requests.filter(url => url.startsWith('/api/dashboard'))).toEqual([`/api/dashboard?habitatId=${habitatId}&period=30d`]));
  const title = await screen.findByText('Tasks Completed');
  expect(within(title.parentElement!).getByText('2')).toBeInTheDocument();
  expect(within(title.parentElement!).getByText('In last 30d')).toBeInTheDocument();
  expect(screen.getByRole('combobox')).toHaveValue('30d');
  expect(requests).toContain(`/api/habitats/${habitatId}/burndown?days=30`);
  fireEvent.click(screen.getByText('Default period'));
  expect(await screen.findByText('In last 30d')).toBeInTheDocument();
  expect(requests.filter(url => url.startsWith('/api/dashboard'))).toHaveLength(1);
});
