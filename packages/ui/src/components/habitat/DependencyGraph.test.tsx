import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DependencyGraph } from './DependencyGraph.js';
import { useDependencyGraph } from '../../hooks/useDependencyGraph.js';

vi.mock('../../hooks/useDependencyGraph.js', () => ({
  useDependencyGraph: vi.fn(() => ({
    nodes: [],
    edges: [],
    isLoading: false,
    error: null,
    highlightedNodeId: null,
    setHighlightedNode: vi.fn(),
    clearHighlight: vi.fn(),
    featureCount: 0,
  })),
}));

vi.mock('../../hooks/useMediaQuery.js', () => ({
  useIsMobile: vi.fn(() => false),
}));

describe('DependencyGraph', () => {
  it('shows empty state when no features', () => {
    render(<DependencyGraph habitatId="board-1" onSelectFeature={vi.fn()} />);
    expect(screen.getByText('No features on this board.')).toBeTruthy();
    expect(screen.getByText('Add features to see them in the graph.')).toBeTruthy();
  });

  it('shows loading spinner when loading', () => {
    vi.mocked(useDependencyGraph).mockReturnValue({
      nodes: [],
      edges: [],
      isLoading: true,
      error: null,
      highlightedNodeId: null,
      setHighlightedNode: vi.fn(),
      clearHighlight: vi.fn(),
      featureCount: 0,
    });
    render(<DependencyGraph habitatId="board-1" onSelectFeature={vi.fn()} />);
    expect(document.querySelector('.animate-spin')).toBeTruthy();
  });

  it('shows error message on error', () => {
    vi.mocked(useDependencyGraph).mockReturnValue({
      nodes: [],
      edges: [],
      isLoading: false,
      error: 'Failed to load',
      highlightedNodeId: null,
      setHighlightedNode: vi.fn(),
      clearHighlight: vi.fn(),
      featureCount: 0,
    });
    render(<DependencyGraph habitatId="board-1" onSelectFeature={vi.fn()} />);
    expect(screen.getByText('Failed to load')).toBeTruthy();
  });
});
