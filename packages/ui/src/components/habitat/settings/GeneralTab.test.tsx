import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { GeneralTab } from './GeneralTab.js';
import type { Habitat } from '../../../types/index.js';

vi.mock('../../ui/Button.js', () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>{children}</button>
  ),
}));

describe('GeneralTab', () => {
  const mockOnUpdate = vi.fn();
  const mockOnClose = vi.fn();
  const mockOnExportOpen = vi.fn();
  const mockOnImportOpen = vi.fn();
  const mockOnDeleteOpen = vi.fn();

  const defaultProps = {
    habitatId: 'b1',
    boardName: 'Test Habitat',
    boardDescription: 'A test board',
    onUpdate: mockOnUpdate,
    onClose: mockOnClose,
    onExportOpen: mockOnExportOpen,
    onImportOpen: mockOnImportOpen,
    onDeleteOpen: mockOnDeleteOpen,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders board name input with current value', () => {
    render(<GeneralTab {...defaultProps} />);
    const input = screen.getByDisplayValue('Test Habitat');
    expect(input).toBeTruthy();
    expect(input.tagName).toBe('INPUT');
  });

  it('renders description textarea with current value', () => {
    render(<GeneralTab {...defaultProps} />);
    const textarea = screen.getByDisplayValue('A test board');
    expect(textarea).toBeTruthy();
    expect(textarea.tagName).toBe('TEXTAREA');
  });

  it('renders Import / Export section with buttons', () => {
    render(<GeneralTab {...defaultProps} />);
    expect(screen.getByText('Import / Export')).toBeTruthy();
    expect(screen.getByText('Export')).toBeTruthy();
    expect(screen.getByText('Import')).toBeTruthy();
  });

  it('renders Danger Zone with Delete Habitat button', () => {
    render(<GeneralTab {...defaultProps} />);
    expect(screen.getByText('Danger Zone')).toBeTruthy();
    expect(screen.getByText('Delete Habitat')).toBeTruthy();
  });

  it('renders Habitat Name label', () => {
    render(<GeneralTab {...defaultProps} />);
    expect(screen.getByText('Habitat Name')).toBeTruthy();
  });

  it('renders Description label', () => {
    render(<GeneralTab {...defaultProps} />);
    expect(screen.getByText('Description')).toBeTruthy();
  });
});
