import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskViewHeader } from './TaskViewHeader.js';

describe('TaskViewHeader', () => {
  it('renders task title', () => {
    render(
      <TaskViewHeader
        task={{ title: 'Test Task', status: 'pending', priority: 'medium', labels: [] }}
        isWatching={false}
        watchLoading={false}
        onToggleWatch={() => {}}
        onEdit={() => {}}
      />
    );
    expect(screen.getByText('Test Task')).toBeTruthy();
  });

  it('renders status badge', () => {
    render(
      <TaskViewHeader
        task={{ title: 'Test Task', status: 'in_review', priority: 'medium', labels: [] }}
        isWatching={false}
        watchLoading={false}
        onToggleWatch={() => {}}
        onEdit={() => {}}
      />
    );
    expect(screen.getByText('in review')).toBeTruthy();
  });

  it('renders priority badge', () => {
    render(
      <TaskViewHeader
        task={{ title: 'Test Task', status: 'pending', priority: 'critical', labels: [] }}
        isWatching={false}
        watchLoading={false}
        onToggleWatch={() => {}}
        onEdit={() => {}}
      />
    );
    expect(screen.getByText('critical')).toBeTruthy();
  });

  it('shows edit button for pending status', () => {
    render(
      <TaskViewHeader
        task={{ title: 'Test Task', status: 'pending', priority: 'medium', labels: [] }}
        isWatching={false}
        watchLoading={false}
        onToggleWatch={() => {}}
        onEdit={() => {}}
      />
    );
    // Edit button has Pencil icon
    const buttons = screen.getAllByRole('button', { hidden: true });
    const editButton = buttons.find(btn => btn.querySelector('svg.lucide-pencil'));
    expect(editButton).toBeTruthy();
  });
});
