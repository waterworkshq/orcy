import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { DependencyGraphModal } from './DependencyGraphModal.js';

vi.mock('./DependencyGraph.js', () => ({
  DependencyGraph: ({ onSelectFeature }: { boardId: string; onSelectFeature: (id: string) => void }) => (
    <div data-testid="dependency-graph-mock">
      <button onClick={() => onSelectFeature('feat-1')}>Select Feature</button>
    </div>
  ),
}));

afterEach(cleanup);

const defaultProps = {
  boardId: 'board-1',
  onClose: vi.fn(),
  onSelectFeature: vi.fn(),
};

describe('DependencyGraphModal', () => {
  it('renders with glass-modal styling', () => {
    render(<DependencyGraphModal {...defaultProps} />);
    const modal = screen.getByTestId('dependency-graph-modal');
    expect(modal.className).toContain('glass-modal');
  });

  it('renders header with cool-glow styling', () => {
    render(<DependencyGraphModal {...defaultProps} />);
    const header = document.querySelector('.cool-glow');
    expect(header).toBeTruthy();
  });

  it('renders the title', () => {
    render(<DependencyGraphModal {...defaultProps} />);
    expect(screen.getByText('Dependency Graph')).toBeTruthy();
  });

  it('renders the GitBranch icon', () => {
    render(<DependencyGraphModal {...defaultProps} />);
    expect(document.querySelector('svg.lucide-git-branch')).toBeTruthy();
  });

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn();
    render(<DependencyGraphModal {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('close-button'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders DependencyGraph component', () => {
    render(<DependencyGraphModal {...defaultProps} />);
    expect(screen.getByTestId('dependency-graph-mock')).toBeTruthy();
  });

  it('passes boardId and onSelectFeature to DependencyGraph', () => {
    const onSelectFeature = vi.fn();
    render(<DependencyGraphModal {...defaultProps} onSelectFeature={onSelectFeature} />);
    fireEvent.click(screen.getByText('Select Feature'));
    expect(onSelectFeature).toHaveBeenCalledWith('feat-1');
  });

  it('renders status legend items', () => {
    render(<DependencyGraphModal {...defaultProps} />);
    expect(screen.getByText('Pending')).toBeTruthy();
    expect(screen.getByText('In Progress')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Unmet dep.')).toBeTruthy();
  });

  it('renders header with ghost-border-b separator', () => {
    render(<DependencyGraphModal {...defaultProps} />);
    const header = document.querySelector('.cool-glow');
    expect(header?.className).toContain('ghost-border-b');
  });

  it('uses obsidian text colors in header', () => {
    render(<DependencyGraphModal {...defaultProps} />);
    const title = screen.getByText('Dependency Graph');
    expect(title.className).toContain('text-on-surface');
  });
});
