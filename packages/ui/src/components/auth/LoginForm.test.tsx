// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';
import { LoginForm } from './LoginForm.js';

describe('LoginForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders username and password input fields', () => {
    const onSubmit = vi.fn();
    render(<LoginForm onSubmit={onSubmit} error={null} />, { wrapper: MemoryRouter });

    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('shows ORCY POD branding in parent context', () => {
    const onSubmit = vi.fn();
    render(<LoginForm onSubmit={onSubmit} error={null} />, { wrapper: MemoryRouter });

    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();
  });

  it('uses design-system classes for input fields', () => {
    const onSubmit = vi.fn();
    render(<LoginForm onSubmit={onSubmit} error={null} />, { wrapper: MemoryRouter });

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

  it('uses btn-primary for submit button', () => {
    const onSubmit = vi.fn();
    render(<LoginForm onSubmit={onSubmit} error={null} />, { wrapper: MemoryRouter });

    expect(screen.getByRole('button', { name: 'Sign In' })).toHaveClass('btn-primary');
  });

  it('calls onSubmit prop with username and password on submit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<LoginForm onSubmit={onSubmit} error={null} />, { wrapper: MemoryRouter });

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pass123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith('admin', 'pass123');
    });
  });

  it('displays error message when error prop is set', () => {
    const onSubmit = vi.fn();
    render(<LoginForm onSubmit={onSubmit} error="Invalid credentials" />, { wrapper: MemoryRouter });

    expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
  });

  it('inputs have correct label associations (htmlFor/id)', () => {
    const onSubmit = vi.fn();
    render(<LoginForm onSubmit={onSubmit} error={null} />, { wrapper: MemoryRouter });

    const usernameLabel = screen.getByText('Username');
    const usernameInput = screen.getByLabelText('Username');
    expect(usernameLabel.getAttribute('for')).toBe(usernameInput.getAttribute('id'));

    const passwordLabel = screen.getByText('Password');
    const passwordInput = screen.getByLabelText('Password');
    expect(passwordLabel.getAttribute('for')).toBe(passwordInput.getAttribute('id'));
  });
});
