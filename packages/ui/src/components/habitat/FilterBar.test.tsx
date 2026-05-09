import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FilterBar } from './FilterBar.js';

const mockStoreState = {
  agents: [
    { id: 'a1', name: 'Agent-1' },
    { id: 'a2', name: 'Agent-2' },
  ],
  board: { id: 'board-1' },
};

vi.mock('../../store/habitatStore.js', () => ({
  useBoardStore: (selector?: any) => {
    return selector ? selector(mockStoreState) : mockStoreState;
  },
}));

vi.mock('../../hooks/useMediaQuery.js', () => ({
  useIsMobile: () => false,
}));

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('FilterBar', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders search input', () => {
    renderWithRouter(<FilterBar />);
    expect(screen.getByPlaceholderText('Search features...')).toBeTruthy();
  });

  it('renders agent filter dropdown', () => {
    renderWithRouter(<FilterBar />);
    expect(screen.getByText('All Agents')).toBeTruthy();
  });

  it('renders priority filter buttons', () => {
    renderWithRouter(<FilterBar />);
    expect(screen.getByText('critical')).toBeTruthy();
    expect(screen.getByText('high')).toBeTruthy();
    expect(screen.getByText('medium')).toBeTruthy();
    expect(screen.getByText('low')).toBeTruthy();
  });

  it('renders status filter buttons', () => {
    renderWithRouter(<FilterBar />);
    expect(screen.getByText('not started')).toBeTruthy();
    expect(screen.getByText('in progress')).toBeTruthy();
    expect(screen.getByText('review')).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
    expect(screen.getByText('failed')).toBeTruthy();
  });

  it('renders Views button', () => {
    renderWithRouter(<FilterBar />);
    expect(screen.getByText('Views')).toBeTruthy();
  });

  describe('React.memo wrapping', () => {
    it('FilterBar is wrapped in React.memo', () => {
      expect((FilterBar as any).$$typeof).toBe(Symbol.for('react.memo'));
      expect(typeof (FilterBar as any).type).toBe('function');
    });
  });
});
