import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
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

vi.mock('../../api/index.js', () => ({
  api: {
    savedFilters: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

function renderWithRouter(ui: React.ReactElement, initialEntries?: string[]) {
  return render(
    <MemoryRouter initialEntries={initialEntries ?? ['/']}>
      {ui}
    </MemoryRouter>
  );
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

  it('renders view toggle with Board and Table buttons', () => {
    renderWithRouter(<FilterBar />);
    expect(screen.getByTestId('view-toggle-board')).toBeTruthy();
    expect(screen.getByTestId('view-toggle-table')).toBeTruthy();
  });

  it('defaults to board view when no view param', () => {
    renderWithRouter(<FilterBar />);
    const boardBtn = screen.getByTestId('view-toggle-board');
    expect(boardBtn.className).toContain('bg-primary');
  });

  it('highlights table toggle when ?view=table', () => {
    renderWithRouter(<FilterBar />, ['/?view=table']);
    const tableBtn = screen.getByTestId('view-toggle-table');
    expect(tableBtn.className).toContain('bg-primary');
  });

  it('does not show Clear button when only view param is set', () => {
    renderWithRouter(<FilterBar />, ['/?view=table']);
    expect(screen.queryByText('Clear')).toBeNull();
  });

  it('preserves view param when applying a saved filter', async () => {
    const { api } = await import('../../api/index.js');
    const savedFilter = {
      id: 'sf1',
      boardId: 'board-1',
      userId: 'u1',
      name: 'My Filter',
      filterConfig: { priority: 'high' },
      isBuiltin: false,
      createdAt: new Date().toISOString(),
    };
    (api.savedFilters.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([savedFilter]);

    renderWithRouter(<FilterBar />, ['/?view=table']);

    const viewsBtn = await screen.findByText('Views');
    fireEvent.click(viewsBtn);

    const filterBtn = await screen.findByText('My Filter');
    fireEvent.click(filterBtn);

    const tableBtn = screen.getByTestId('view-toggle-table');
    expect(tableBtn.className).toContain('bg-primary');
    const boardBtn = screen.getByTestId('view-toggle-board');
    expect(boardBtn.className).not.toContain('bg-primary');
  });

  describe('React.memo wrapping', () => {
    it('FilterBar is wrapped in React.memo', () => {
      expect((FilterBar as any).$$typeof).toBe(Symbol.for('react.memo'));
      expect(typeof (FilterBar as any).type).toBe('function');
    });
  });
});
