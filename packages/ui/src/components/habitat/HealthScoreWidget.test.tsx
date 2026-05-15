import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { HealthScoreWidget } from './HealthScoreWidget.js';

const mockHealthGet = vi.fn();

vi.mock('../../api/index.js', () => ({
  api: {
    health: {
      get: (...args: any[]) => mockHealthGet(...args),
    },
  },
}));

vi.mock('lucide-react', () => ({
  Activity: () => <span data-testid="icon-activity">Activity</span>,
  TrendingUp: () => <span data-testid="icon-trending-up">TrendingUp</span>,
  TrendingDown: () => <span data-testid="icon-trending-down">TrendingDown</span>,
  AlertTriangle: () => <span data-testid="icon-alert">AlertTriangle</span>,
  CheckCircle: () => <span data-testid="icon-check">CheckCircle</span>,
  Clock: () => <span data-testid="icon-clock">Clock</span>,
  Users: () => <span data-testid="icon-users">Users</span>,
  Shield: () => <span data-testid="icon-shield">Shield</span>,
}));

const baseHealth = {
  boardId: 'board-1',
  score: 85,
  grade: 'A',
  dimensions: {
    flow: { score: 90 },
    quality: { score: 80 },
    delivery: { score: 85 },
    capacity: { score: 75 },
    stability: { score: 95 },
  },
  recommendations: ['Consider reducing WIP limits'],
  snapshotAt: '2024-01-01T00:00:00Z',
};

function renderWithQC(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>{ui}</QueryClientProvider>,
  );
}

describe('HealthScoreWidget', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockHealthGet.mockResolvedValue(baseHealth);
  });

  afterEach(() => {
    cleanup();
  });

  it('shows loading skeleton while fetching health data', () => {
    mockHealthGet.mockReturnValue(new Promise(() => {}));

    renderWithQC(<HealthScoreWidget boardId="board-1" />);

    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders health score button after loading', async () => {
    renderWithQC(<HealthScoreWidget boardId="board-1" />);

    await waitFor(() => {
      expect(screen.getByText('85')).toBeTruthy();
    });
  });

  it('renders grade badge', async () => {
    renderWithQC(<HealthScoreWidget boardId="board-1" />);

    await waitFor(() => {
      expect(screen.getByText('A')).toBeTruthy();
    });
  });

  it('returns null when no health data', async () => {
    mockHealthGet.mockResolvedValue(null as any);

    const { container } = renderWithQC(<HealthScoreWidget boardId="board-1" />);

    await waitFor(() => {
      expect(container.innerHTML).toBe('');
    });
  });

  it('expands detail panel on click', async () => {
    renderWithQC(<HealthScoreWidget boardId="board-1" />);

    await waitFor(() => {
      expect(screen.getByText('85')).toBeTruthy();
    });

    fireEvent.click(screen.getByTitle('Board Health Score'));

    await waitFor(() => {
      expect(screen.getByText('Board Health')).toBeTruthy();
    });
  });

  it('shows recommendations when expanded', async () => {
    renderWithQC(<HealthScoreWidget boardId="board-1" />);

    await waitFor(() => {
      expect(screen.getByText('85')).toBeTruthy();
    });

    fireEvent.click(screen.getByTitle('Board Health Score'));

    await waitFor(() => {
      expect(screen.getByText('Recommendations')).toBeTruthy();
      expect(screen.getByText('Consider reducing WIP limits')).toBeTruthy();
    });
  });

  it('shows dimensions when expanded', async () => {
    renderWithQC(<HealthScoreWidget boardId="board-1" />);

    await waitFor(() => {
      expect(screen.getByText('85')).toBeTruthy();
    });

    fireEvent.click(screen.getByTitle('Board Health Score'));

    await waitFor(() => {
      expect(screen.getByText('Flow')).toBeTruthy();
      expect(screen.getByText('Quality')).toBeTruthy();
    });
  });

  it('renders low score with alert icon', async () => {
    mockHealthGet.mockResolvedValue({
      ...baseHealth,
      score: 25,
      grade: 'F',
    });

    renderWithQC(<HealthScoreWidget boardId="board-1" />);

    await waitFor(() => {
      expect(screen.getByText('25')).toBeTruthy();
      expect(screen.getByTestId('icon-alert')).toBeTruthy();
    });
  });

  it('renders medium score with trending down icon', async () => {
    mockHealthGet.mockResolvedValue({
      ...baseHealth,
      score: 55,
      grade: 'C',
    });

    renderWithQC(<HealthScoreWidget boardId="board-1" />);

    await waitFor(() => {
      expect(screen.getByText('55')).toBeTruthy();
      expect(screen.getByTestId('icon-trending-down')).toBeTruthy();
    });
  });
});
