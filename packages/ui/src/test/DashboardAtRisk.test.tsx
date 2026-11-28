import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPage } from '../pages/DashboardPage.js';
import type { AtRiskTask } from '../types/index.js';

const data = vi.hoisted(() => ({ risks: [] as unknown[] }));
// Replace the data-fetching boundary; mount the actual Dashboard and prediction components.
vi.mock('../lib/useHabitatData.js', () => ({
  useDashboardStats: () => ({ data: null, isLoading: false, error: null }),
  useHabitatPredictions: () => ({ data: { velocity: { days7: 0, days14: 0, days30: 0, perAgent: {} }, estimates: [], forecasts: [], atRiskTasks: data.risks } }),
  useHabitatBurndown: () => ({ data: { data: [], remainingTasks: 1, totalTasks: 1, averageDailyVelocity: 0, estimatedCompletionDate: null } }),
}));

afterEach(cleanup);

it('counts a Task once while displaying each of its risk reasons', () => {
  const common = { taskId: 'task-1', taskTitle: 'Late task', assignedAgentId: null, dueAt: null, lastActivityAt: null };
  data.risks = [
    { ...common, reason: 'overdue_prediction', severity: 'critical', details: 'Forecast is late' },
    { ...common, reason: 'past_due', severity: 'critical', details: 'Task is past due' },
    { ...common, reason: 'no_activity', severity: 'high', details: 'Task is stale' },
  ] satisfies AtRiskTask[];
  render(<MemoryRouter><DashboardPage /></MemoryRouter>);
  const label = screen.getAllByText('At-Risk Tasks')[0];
  const card = label.parentElement!;
  expect(within(card).getByText('1')).toBeInTheDocument();
  expect(within(card).getByText('1 critical')).toBeInTheDocument();
  expect(['Forecast is late', 'Task is past due', 'Task is stale'].map(text => screen.getByText(text))).toHaveLength(3);
});

it('handles no risks and the same reason on three different Tasks', () => {
  data.risks = [];
  const view = render(<MemoryRouter><DashboardPage /></MemoryRouter>);
  let card = screen.getAllByText('At-Risk Tasks')[0].parentElement!;
  expect(within(card).getByText('0')).toBeInTheDocument();
  expect(within(card).getByText('0 critical')).toBeInTheDocument();
  expect(screen.getByText('No at-risk tasks detected')).toBeInTheDocument();

  data.risks = ['a', 'b', 'c'].map(taskId => ({ taskId, taskTitle: taskId, reason: 'past_due', severity: 'critical', details: `Late ${taskId}`, assignedAgentId: null, dueAt: null, lastActivityAt: null })) satisfies AtRiskTask[];
  view.rerender(<MemoryRouter><DashboardPage /></MemoryRouter>);
  card = screen.getAllByText('At-Risk Tasks')[0].parentElement!;
  expect(within(card).getByText('3')).toBeInTheDocument();
  expect(within(card).getByText('3 critical')).toBeInTheDocument();
  expect(screen.getAllByText('Past Due')).toHaveLength(3);
});
