// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';
import { SetupForm } from './SetupForm.js';

describe('SetupForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders setup form with all required fields', () => {
    const onSubmit = vi.fn();
    render(<SetupForm onSubmit={onSubmit} error={null} />, { wrapper: MemoryRouter });

    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Account' })).toBeInTheDocument();
  });

  it('has username, password, confirm password, and display name fields', () => {
    const onSubmit = vi.fn();
    render(<SetupForm onSubmit={onSubmit} error={null} />, { wrapper: MemoryRouter });

    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm Password')).toBeInTheDocument();
    expect(screen.getByLabelText(/Display Name/)).toBeInTheDocument();
  });

  it('shows password mismatch error when passwords do not match', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<SetupForm onSubmit={onSubmit} error={null} />, { wrapper: MemoryRouter });

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'newuser' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pass123' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'different' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));

    await waitFor(() => {
      expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onSubmit with username, password, and displayName on valid submit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<SetupForm onSubmit={onSubmit} error={null} />, { wrapper: MemoryRouter });

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'newuser' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pass123' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'pass123' } });
    fireEvent.change(screen.getByLabelText(/Display Name/), { target: { value: 'New User' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith('newuser', 'pass123', 'New User');
    });
  });

  it('does NOT call onSubmit when passwords do not match', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<SetupForm onSubmit={onSubmit} error={null} />, { wrapper: MemoryRouter });

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'newuser' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pass123' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'different' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));

    await waitFor(() => {
      expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('display name field is optional', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<SetupForm onSubmit={onSubmit} error={null} />, { wrapper: MemoryRouter });

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'newuser' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pass123' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'pass123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith('newuser', 'pass123', undefined);
    });
  });

  it('uses design-system classes (bg-surface-container-high, ghost-border, btn-primary)', () => {
    const onSubmit = vi.fn();
    render(<SetupForm onSubmit={onSubmit} error={null} />, { wrapper: MemoryRouter });

    expect(screen.getByLabelText('Username')).toHaveClass(
      'bg-surface-container-high',
      'ghost-border',
      'text-on-surface'
    );
    expect(screen.getByRole('button', { name: 'Create Account' })).toHaveClass('btn-primary');
  });
});
