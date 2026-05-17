import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExportHabitatDialog } from './ExportHabitatDialog.js';

vi.mock('../../api/index.js', () => ({
  api: {
    boards: {
      export: vi.fn(),
    },
  },
}));

vi.mock('../../lib/toast.js', () => ({
  notify: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('ExportHabitatDialog', () => {
  it('renders with Features checkbox label', () => {
    render(
      <ExportHabitatDialog
        habitatId="board-1"
        boardName="Test Board"
        open={true}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText('Missions (with tasks, dependencies, and status)')).toBeTruthy();
  });
});