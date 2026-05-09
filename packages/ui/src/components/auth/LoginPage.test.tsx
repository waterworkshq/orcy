// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';
import { LoginPage } from './LoginPage.js';

vi.mock('../../api/index.js', () => ({
  api: {
    auth: {
      login: vi.fn(),
    },
  },
}));

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the login form in a glass card on the obsidian surface', () => {
    const { container } = render(<LoginPage />, { wrapper: MemoryRouter });

    expect(container.firstElementChild).toHaveClass('bg-surface', 'min-h-screen');
    expect(container.querySelector('form')).toHaveClass('glass-card');
  });

  it('shows ORCY POD branding', () => {
    render(<LoginPage />, { wrapper: MemoryRouter });

    expect(screen.getByText('ORCY POD')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign In' })).toHaveClass('font-headline');
  });

  it('uses design-system classes for input fields', () => {
    render(<LoginPage />, { wrapper: MemoryRouter });

    expect(screen.getByLabelText('Username')).toHaveClass(
      'bg-surface-container-high',
      'ghost-border',
      'text-on-surface'
    );
    expect(screen.getByLabelText('Password')).toHaveClass(
      'bg-surface-container-high',
      'ghost-border',
      'text-on-surface'
    );
  });

  it('uses the primary button token for the login action', () => {
    render(<LoginPage />, { wrapper: MemoryRouter });

    expect(screen.getByRole('button', { name: 'Sign In' })).toHaveClass('btn-primary');
  });
});
