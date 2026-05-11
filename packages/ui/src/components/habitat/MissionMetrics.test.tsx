import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { FeatureMetrics } from './MissionMetrics.js';
import type { Task } from '../../types/index.js';

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    featureId: 'feat-1',
    title: 'Task',
    description: '',
    priority: 'medium',
    assignedAgentId: null,
    delegatedToAgentId: null,
    requiredDomain: null,
    requiredCapabilities: [],
    status: 'pending',
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    estimatedMinutes: null,
    actualMinutes: null,
    cycleTimeMinutes: null,
    leadTimeMinutes: null,
    estimationAccuracy: null,
    retryPolicy: null,
    retryCount: 0,
    nextRetryAt: null,
    labels: [],
    ...overrides,
  };
}

const baseProgress = {
  completed: 3,
  total: 6,
  percentage: 50,
  byStatus: {
    pending: 1,
    claimed: 1,
    in_progress: 1,
    submitted: 1,
    done: 2,
    failed: 0,
  } as Record<string, number>,
};

const baseDeps = { dependsOn: [] as string[], blocks: [] as string[] };

describe('FeatureMetrics', () => {
  afterEach(cleanup);

  it('renders completion percentage', () => {
    render(
      <FeatureMetrics
        progress={baseProgress}
        tasks={[]}
        dependencies={baseDeps}
      />
    );
    expect(screen.getByText('50%')).toBeTruthy();
  });

  it('renders completed/total tasks count', () => {
    render(
      <FeatureMetrics
        progress={baseProgress}
        tasks={[]}
        dependencies={baseDeps}
      />
    );
    expect(screen.getByText('3 / 6 tasks')).toBeTruthy();
  });

  it('renders progress bar with correct width', () => {
    const { container } = render(
      <FeatureMetrics
        progress={baseProgress}
        tasks={[]}
        dependencies={baseDeps}
      />
    );
    const bar = container.querySelector(
      '.bg-\\[var\\(--primary\\)\\]'
    ) as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.style.width).toBe('50%');
  });

  it('renders task count from tasks array', () => {
    const tasks = [
      makeTask({ id: 't1', status: 'pending' }),
      makeTask({ id: 't2', status: 'in_progress' }),
      makeTask({ id: 't3', status: 'done' }),
    ];
    render(
      <FeatureMetrics
        progress={baseProgress}
        tasks={tasks}
        dependencies={baseDeps}
      />
    );
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('renders task counts by status category', () => {
    const progress = {
      ...baseProgress,
      byStatus: {
        pending: 2,
        claimed: 1,
        in_progress: 3,
        submitted: 1,
        approved: 1,
        rejected: 0,
        done: 4,
        failed: 1,
      },
    };
    render(
      <FeatureMetrics
        progress={progress}
        tasks={[]}
        dependencies={baseDeps}
      />
    );
    expect(screen.getByText(/Todo: 3/)).toBeTruthy();
    expect(screen.getByText(/Active: 3/)).toBeTruthy();
    expect(screen.getByText(/Review: 2/)).toBeTruthy();
    expect(screen.getByText(/Done: 5/)).toBeTruthy();
  });

  it('renders dependency blocked count', () => {
    const deps = { dependsOn: ['f1', 'f2'], blocks: ['f3'] };
    render(
      <FeatureMetrics
        progress={baseProgress}
        tasks={[]}
        dependencies={deps}
      />
    );
    expect(screen.getByText('2 blocked')).toBeTruthy();
    expect(screen.getByText('Blocking 1 others')).toBeTruthy();
  });

  it('renders healthy dependencies with primary color', () => {
    const { container } = render(
      <FeatureMetrics
        progress={baseProgress}
        tasks={[]}
        dependencies={{ dependsOn: [], blocks: ['f1'] }}
      />
    );
    const depsCard = screen.getByText('0 blocked').closest('.glass-card');
    expect(depsCard).toBeTruthy();
    expect(depsCard!.className).not.toContain('border-[var(--error)]');
  });

  it('renders unhealthy dependencies with error border', () => {
    render(
      <FeatureMetrics
        progress={baseProgress}
        tasks={[]}
        dependencies={{ dependsOn: ['f1'], blocks: [] }}
      />
    );
    const depsCard = screen.getByText('1 blocked').closest('.glass-card');
    expect(depsCard!.className).toContain('border-[var(--error)]');
  });

  it('renders task health dots for tasks', () => {
    const tasks = [
      makeTask({ id: 't1', status: 'done' }),
      makeTask({ id: 't2', status: 'in_progress' }),
      makeTask({ id: 't3', status: 'failed' }),
      makeTask({ id: 't4', status: 'pending' }),
    ];
    const { container } = render(
      <FeatureMetrics
        progress={baseProgress}
        tasks={tasks}
        dependencies={baseDeps}
      />
    );
    const dots = container.querySelectorAll('.w-2.h-2.rounded-full');
    expect(dots.length).toBe(4);
  });

  it('renders time tracking when tasks have estimatedMinutes', () => {
    const tasks = [
      makeTask({ id: 't1', estimatedMinutes: 120, actualMinutes: 90 }),
      makeTask({ id: 't2', estimatedMinutes: 60, actualMinutes: 60 }),
    ];
    render(
      <FeatureMetrics
        progress={baseProgress}
        tasks={tasks}
        dependencies={baseDeps}
      />
    );
    expect(screen.getByText('3h')).toBeTruthy();
    expect(screen.getByText('2h 30m')).toBeTruthy();
    expect(screen.getByText('est')).toBeTruthy();
    expect(screen.getByText('actual')).toBeTruthy();
  });

  it('renders time tracking in minutes when under 60', () => {
    const tasks = [
      makeTask({ id: 't1', estimatedMinutes: 30, actualMinutes: 0 }),
    ];
    render(
      <FeatureMetrics
        progress={baseProgress}
        tasks={tasks}
        dependencies={baseDeps}
      />
    );
    expect(screen.getByText('30m')).toBeTruthy();
    expect(screen.getByText('est')).toBeTruthy();
  });

  it('hides time tracking when no tasks have time data', () => {
    const tasks = [makeTask({ id: 't1' })];
    const { container } = render(
      <FeatureMetrics
        progress={baseProgress}
        tasks={tasks}
        dependencies={baseDeps}
      />
    );
    expect(screen.queryByText('Time Tracking')).toBeNull();
  });

  it('renders time tracking bar as error when actual exceeds estimate', () => {
    const tasks = [
      makeTask({ id: 't1', estimatedMinutes: 60, actualMinutes: 120 }),
    ];
    const { container } = render(
      <FeatureMetrics
        progress={baseProgress}
        tasks={tasks}
        dependencies={baseDeps}
      />
    );
    const timeCard = screen.getByText('Time Tracking').closest('.glass-card');
    expect(timeCard).toBeTruthy();
  });

  it('applies glass-card class to all metric cards', () => {
    const tasks = [
      makeTask({ id: 't1', estimatedMinutes: 30, actualMinutes: 20 }),
    ];
    const { container } = render(
      <FeatureMetrics
        progress={baseProgress}
        tasks={tasks}
        dependencies={baseDeps}
      />
    );
    const cards = container.querySelectorAll('.glass-card');
    expect(cards.length).toBe(4);
  });

  it('renders 100% progress bar at full completion', () => {
    const progress = {
      completed: 5,
      total: 5,
      percentage: 100,
      byStatus: { done: 5 },
    };
    const { container } = render(
      <FeatureMetrics
        progress={progress}
        tasks={[]}
        dependencies={baseDeps}
      />
    );
    expect(screen.getByText('100%')).toBeTruthy();
    expect(screen.getByText('5 / 5 tasks')).toBeTruthy();
  });

  it('renders 0% progress bar with no tasks', () => {
    const progress = {
      completed: 0,
      total: 0,
      percentage: 0,
      byStatus: {},
    };
    render(
      <FeatureMetrics
        progress={progress}
        tasks={[]}
        dependencies={baseDeps}
      />
    );
    expect(screen.getByText('0%')).toBeTruthy();
    expect(screen.getByText('0 / 0 tasks')).toBeTruthy();
  });
});
