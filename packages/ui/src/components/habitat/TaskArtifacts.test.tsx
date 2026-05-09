import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskArtifacts } from './TaskArtifacts.js';

vi.mock('../ui/DetailCard.js', () => ({
  DetailCard: ({ children, title }: any) => (
    <div data-testid="detail-card" data-title={title}>{children}</div>
  ),
}));

describe('TaskArtifacts', () => {
  it('renders nothing when no artifacts and no labels', () => {
    const { container } = render(<TaskArtifacts artifacts={[]} labels={[]} />);
    expect(container.children.length).toBe(0);
  });

  it('renders labels', () => {
    render(<TaskArtifacts artifacts={[]} labels={['bug', 'urgent']} />);
    expect(screen.getByText('bug')).toBeTruthy();
    expect(screen.getByText('urgent')).toBeTruthy();
  });

  it('renders artifacts', () => {
    render(
      <TaskArtifacts
        artifacts={[{ type: 'pr', url: 'https://github.com/pr/1', description: 'PR #1' }]}
        labels={[]}
      />
    );
    expect(screen.getByText('PR #1')).toBeTruthy();
    expect(screen.getByText('pr')).toBeTruthy();
  });

  it('renders artifact url when no description', () => {
    render(
      <TaskArtifacts
        artifacts={[{ type: 'file', url: 'https://example.com/file', description: '' }]}
        labels={[]}
      />
    );
    expect(screen.getByText('https://example.com/file')).toBeTruthy();
  });
});
