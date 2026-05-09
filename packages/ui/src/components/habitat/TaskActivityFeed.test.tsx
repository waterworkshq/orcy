import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  TaskActivityFeed,
  type ActivityEvent,
} from './TaskActivityFeed.js';

function makeEvent(overrides: Partial<ActivityEvent> & { id: string }): ActivityEvent {
  return {
    type: 'creation',
    description: 'created the task',
    userId: 'user-1',
    userName: 'Alice',
    userAvatar: undefined,
    timestamp: new Date('2024-06-15T12:00:00Z'),
    metadata: undefined,
    ...overrides,
  };
}

describe('TaskActivityFeed', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2024-06-15T14:30:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('shows empty state when no events', () => {
    render(<TaskActivityFeed events={[]} />);
    expect(screen.getByText('No activity yet')).toBeTruthy();
  });

  it('renders events in newest-first order', () => {
    const events = [
      makeEvent({ id: '1', description: 'older event', timestamp: new Date('2024-06-15T10:00:00Z') }),
      makeEvent({ id: '2', description: 'newer event', timestamp: new Date('2024-06-15T12:00:00Z') }),
    ];

    const { container } = render(<TaskActivityFeed events={events} />);
    const items = container.querySelectorAll('[class*="relative flex gap-3"]');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain('newer event');
    expect(items[1].textContent).toContain('older event');
  });

  it('displays user name in each event', () => {
    const events = [
      makeEvent({ id: '1', userName: 'Alice', description: 'created the task' }),
      makeEvent({ id: '2', userName: 'Bob', description: 'commented' }),
    ];

    render(<TaskActivityFeed events={events} />);
    expect(screen.getByText(/Alice/)).toBeTruthy();
    expect(screen.getByText(/Bob/)).toBeTruthy();
  });

  it('shows description text for events', () => {
    const events = [
      makeEvent({ id: '1', description: 'changed status to in_progress' }),
    ];

    render(<TaskActivityFeed events={events} />);
    expect(screen.getByText(/changed status to in_progress/)).toBeTruthy();
  });

  it('shows relative timestamps', () => {
    const events = [
      makeEvent({ id: '1', timestamp: new Date('2024-06-15T14:00:00Z') }),
    ];

    render(<TaskActivityFeed events={events} />);
    expect(screen.getByText('30m ago')).toBeTruthy();
  });

  it('shows "just now" for very recent events', () => {
    const events = [
      makeEvent({ id: '1', timestamp: new Date('2024-06-15T14:29:30Z') }),
    ];

    render(<TaskActivityFeed events={events} />);
    expect(screen.getByText('just now')).toBeTruthy();
  });

  it('shows hours ago for older events', () => {
    const events = [
      makeEvent({ id: '1', timestamp: new Date('2024-06-15T10:30:00Z') }),
    ];

    render(<TaskActivityFeed events={events} />);
    expect(screen.getByText('4h ago')).toBeTruthy();
  });

  it('shows days ago for events older than 24h', () => {
    const events = [
      makeEvent({ id: '1', timestamp: new Date('2024-06-13T14:30:00Z') }),
    ];

    render(<TaskActivityFeed events={events} />);
    expect(screen.getByText('2d ago')).toBeTruthy();
  });

  it('renders avatar with initials when no userAvatar', () => {
    const events = [
      makeEvent({ id: '1', userName: 'Alice Bob' }),
    ];

    const { container } = render(<TaskActivityFeed events={events} />);
    expect(container.textContent).toContain('AB');
  });

  it('renders avatar image when userAvatar provided', () => {
    const events = [
      makeEvent({
        id: '1',
        userName: 'Alice',
        userAvatar: 'https://example.com/avatar.png',
      }),
    ];

    const { container } = render(<TaskActivityFeed events={events} />);
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe('https://example.com/avatar.png');
  });

  it('renders event icons for each type', () => {
    const types: ActivityEvent['type'][] = [
      'status_change',
      'comment',
      'assignment',
      'creation',
      'dependency_added',
      'subtask_completed',
    ];

    const events = types.map((type, i) =>
      makeEvent({ id: `ev-${i}`, type, description: `${type} event` })
    );

    render(<TaskActivityFeed events={events} />);

    for (const type of types) {
      expect(screen.getByText(new RegExp(`${type} event`))).toBeTruthy();
    }
  });

  it('does not show timeline connector on last item', () => {
    const events = [
      makeEvent({ id: '1', timestamp: new Date('2024-06-15T12:00:00Z') }),
      makeEvent({ id: '2', timestamp: new Date('2024-06-15T10:00:00Z') }),
    ];

    const { container } = render(<TaskActivityFeed events={events} />);
    const connectors = container.querySelectorAll('.absolute.left-\\[13px\\]');
    expect(connectors.length).toBe(1);
  });

  it('updates when new events are added', () => {
    const { rerender } = render(
      <TaskActivityFeed
        events={[makeEvent({ id: '1', description: 'first event' })]}
      />
    );
    expect(screen.getByText(/first event/)).toBeTruthy();

    rerender(
      <TaskActivityFeed
        events={[
          makeEvent({ id: '1', description: 'first event' }),
          makeEvent({
            id: '2',
            description: 'second event',
            timestamp: new Date('2024-06-15T13:00:00Z'),
          }),
        ]}
      />
    );
    expect(screen.getByText(/first event/)).toBeTruthy();
    expect(screen.getByText(/second event/)).toBeTruthy();
  });

  it('renders single event without timeline connector', () => {
    const events = [
      makeEvent({ id: '1', description: 'only event' }),
    ];

    const { container } = render(<TaskActivityFeed events={events} />);
    const connectors = container.querySelectorAll('.absolute.left-\\[13px\\]');
    expect(connectors.length).toBe(0);
    expect(screen.getByText(/only event/)).toBeTruthy();
  });

  it('renders default User icon when userName is empty', () => {
    const events = [
      makeEvent({ id: '1', userName: '' }),
    ];

    const { container } = render(<TaskActivityFeed events={events} />);
    const userIcons = container.querySelectorAll('svg');
    expect(userIcons.length).toBeGreaterThan(0);
  });
});
