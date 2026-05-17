import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { FeatureHeader, formatStatus, formatRelativeTime } from './MissionHeader.js';
import type { MissionWithProgress } from '../../types/index.js';

vi.mock('../ui/Button.js', () => ({
  Button: ({ children, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('../ui/Badge.js', () => ({
  Badge: ({ children, variant }: any) => (
    <span data-testid="badge" data-variant={variant}>
      {children}
    </span>
  ),
}));

vi.mock('lucide-react', () => ({
  ArrowLeft: () => <span data-testid="icon-arrow-left">\u2190</span>,
  Clock: () => <span data-testid="icon-clock">\u25F7</span>,
  Tag: () => <span data-testid="icon-tag">\uD83C\uDFF7</span>,
  Calendar: () => <span data-testid="icon-calendar">\uD83D\uDCC5</span>,
}));

vi.mock('react-markdown', () => ({
  default: ({ children }: any) => <div data-testid="markdown">{children}</div>,
}));

function makeFeature(
  overrides: Partial<MissionWithProgress> & { id: string }
): MissionWithProgress {
  return {
    habitatId: 'board-1',
    columnId: 'col-1',
    title: 'Test Feature',
    description: 'A test feature description',
    acceptanceCriteria: '',
    priority: 'high',
    labels: ['frontend', 'urgent'],
    status: 'in_progress',
    displayOrder: 0,
    dependsOn: [],
    blocks: [],
    dueAt: null,
    slaMinutes: null,
    slaDeadlineAt: null,
    createdBy: 'user-1',
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    actualMinutes: null,
    plannedMinutes: null,
    planningAccuracy: null,
    completedAt: null,
    isArchived: false,
    progress: {
      total: 4,
      pending: 1,
      claimed: 0,
      inProgress: 1,
      submitted: 1,
      approved: 0,
      done: 1,
      failed: 0,
      rejected: 0, percentage: 0,
    },
    ...overrides,
  };
}

function renderWithRouter(ui: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={['/features/feat-123']}>
      <Routes>
        <Route path="/features/:id" element={ui} />
        <Route path="/boards/:habitatId" element={<div>Board Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('FeatureHeader', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2024-06-15T14:30:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('renders feature title as h1', () => {
    const feature = makeFeature({ id: 'feat-1', title: 'My Feature Title' });
    renderWithRouter(<FeatureHeader feature={feature} />);

    const h1 = screen.getByText('My Feature Title');
    expect(h1.tagName).toBe('SPAN');
    expect(h1.closest('h1')).toBeTruthy();
  });

  it('renders priority badge', () => {
    const feature = makeFeature({ id: 'feat-1', priority: 'critical' });
    renderWithRouter(<FeatureHeader feature={feature} />);

    const badges = screen.getAllByTestId('badge');
    const priorityBadge = badges.find(
      (b) => b.dataset.variant === 'critical'
    );
    expect(priorityBadge).toBeTruthy();
    expect(priorityBadge?.textContent).toBe('critical');
  });

  it('renders status badge', () => {
    const feature = makeFeature({ id: 'feat-1', status: 'in_progress' });
    renderWithRouter(<FeatureHeader feature={feature} />);

    const badges = screen.getAllByTestId('badge');
    const statusBadge = badges.find(
      (b) => b.dataset.variant === 'in_progress'
    );
    expect(statusBadge).toBeTruthy();
    expect(statusBadge?.textContent).toBe('In Progress');
  });

  it('renders labels as pills', () => {
    const feature = makeFeature({
      id: 'feat-1',
      labels: ['frontend', 'bug', 'urgent'],
    });
    renderWithRouter(<FeatureHeader feature={feature} />);

    expect(screen.getByText('frontend')).toBeTruthy();
    expect(screen.getByText('bug')).toBeTruthy();
    expect(screen.getByText('urgent')).toBeTruthy();
  });

  it('renders no labels section when labels empty', () => {
    const feature = makeFeature({ id: 'feat-1', labels: [] });
    renderWithRouter(<FeatureHeader feature={feature} />);

    expect(screen.queryByTestId('icon-tag')).toBeNull();
  });

  it('renders description as markdown', () => {
    const feature = makeFeature({
      id: 'feat-1',
      description: '# Heading\n\nSome **bold** text',
    });
    renderWithRouter(<FeatureHeader feature={feature} />);

    const markdown = screen.getByTestId('markdown');
    expect(markdown.textContent).toContain('Heading');
    expect(markdown.textContent).toContain('bold');
  });

  it('renders no description when empty', () => {
    const feature = makeFeature({ id: 'feat-1', description: '' });
    renderWithRouter(<FeatureHeader feature={feature} />);

    expect(screen.queryByTestId('markdown')).toBeNull();
  });

  it('renders created date', () => {
    const feature = makeFeature({
      id: 'feat-1',
      createdAt: new Date('2024-06-15T13:30:00Z').toISOString(),
    });
    renderWithRouter(<FeatureHeader feature={feature} />);

    expect(screen.getByText(/1h ago/)).toBeTruthy();
  });

  it('renders updated date', () => {
    const feature = makeFeature({
      id: 'feat-1',
      updatedAt: new Date('2024-06-15T14:00:00Z').toISOString(),
    });
    renderWithRouter(<FeatureHeader feature={feature} />);

    expect(screen.getByText(/Updated/)).toBeTruthy();
  });

  it('renders due date when present', () => {
    const feature = makeFeature({
      id: 'feat-1',
      dueAt: new Date('2024-06-16T14:30:00Z').toISOString(),
    });
    renderWithRouter(<FeatureHeader feature={feature} />);

    expect(screen.getByText(/Due/)).toBeTruthy();
  });

  it('does not render due date when null', () => {
    const feature = makeFeature({ id: 'feat-1', dueAt: null });
    renderWithRouter(<FeatureHeader feature={feature} />);

    expect(screen.queryByText(/Due/)).toBeNull();
  });

  it('renders feature ID prefix', () => {
    const feature = makeFeature({ id: 'feat-abcdef12' });
    renderWithRouter(<FeatureHeader feature={feature} />);

    expect(screen.getByText(/ID: feat-abc/)).toBeTruthy();
  });

  it('renders back to habitat link', () => {
    const feature = makeFeature({ id: 'feat-1', habitatId: 'board-42' });
    renderWithRouter(<FeatureHeader feature={feature} />);

    const backLink = screen.getByText('Back to Habitat').closest('a');
    expect(backLink?.getAttribute('href')).toBe('/boards/board-42');
  });

  it('applies cool-glow class', () => {
    const feature = makeFeature({ id: 'feat-1' });
    const { container } = renderWithRouter(<FeatureHeader feature={feature} />);

    expect(container.querySelector('.cool-glow')).toBeTruthy();
  });

  it('renders done status badge correctly', () => {
    const feature = makeFeature({ id: 'feat-1', status: 'done' });
    renderWithRouter(<FeatureHeader feature={feature} />);

    const badges = screen.getAllByTestId('badge');
    const statusBadge = badges.find((b) => b.dataset.variant === 'done');
    expect(statusBadge).toBeTruthy();
    expect(statusBadge?.textContent).toBe('Done');
  });

  it('renders failed status badge correctly', () => {
    const feature = makeFeature({ id: 'feat-1', status: 'failed' });
    renderWithRouter(<FeatureHeader feature={feature} />);

    const badges = screen.getAllByTestId('badge');
    const statusBadge = badges.find((b) => b.dataset.variant === 'failed');
    expect(statusBadge).toBeTruthy();
    expect(statusBadge?.textContent).toBe('Failed');
  });
});

describe('formatStatus', () => {
  it('formats snake_case status', () => {
    expect(formatStatus('in_progress')).toBe('In Progress');
  });

  it('formats single word status', () => {
    expect(formatStatus('done')).toBe('Done');
  });

  it('formats not_started', () => {
    expect(formatStatus('not_started')).toBe('Not Started');
  });
});

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2024-06-15T14:30:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns dash for null', () => {
    expect(formatRelativeTime(null)).toBe('\u2014');
  });

  it('returns "just now" for <1 minute', () => {
    const date = new Date('2024-06-15T14:29:30Z').toISOString();
    expect(formatRelativeTime(date)).toBe('just now');
  });

  it('returns minutes for <1 hour', () => {
    const date = new Date('2024-06-15T14:00:00Z').toISOString();
    expect(formatRelativeTime(date)).toBe('30m ago');
  });

  it('returns hours for <24 hours', () => {
    const date = new Date('2024-06-15T12:30:00Z').toISOString();
    expect(formatRelativeTime(date)).toBe('2h ago');
  });

  it('returns days for >=24 hours', () => {
    const date = new Date('2024-06-13T14:30:00Z').toISOString();
    expect(formatRelativeTime(date)).toBe('2d ago');
  });
});
