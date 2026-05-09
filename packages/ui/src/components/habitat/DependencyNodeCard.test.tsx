import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { DependencyNodeCard } from './DependencyNodeCard.js';

afterEach(cleanup);

const defaultProps = {
  title: 'Auth Module',
  status: 'in_progress' as const,
  dependencyCount: 3,
  blockerCount: 0,
};

describe('DependencyNodeCard', () => {
  it('renders the title', () => {
    render(<DependencyNodeCard {...defaultProps} title="My Feature" />);
    expect(screen.getByText('My Feature')).toBeTruthy();
  });

  it('renders status dot with correct color for not_started', () => {
    render(<DependencyNodeCard {...defaultProps} status="not_started" />);
    const dot = screen.getByTestId('status-dot');
    expect(dot.className).toContain('bg-[var(--badge-low)]');
  });

  it('renders status dot with correct color for in_progress', () => {
    render(<DependencyNodeCard {...defaultProps} status="in_progress" />);
    const dot = screen.getByTestId('status-dot');
    expect(dot.className).toContain('bg-[var(--badge-active)]');
  });

  it('renders status dot with correct color for review', () => {
    render(<DependencyNodeCard {...defaultProps} status="review" />);
    const dot = screen.getByTestId('status-dot');
    expect(dot.className).toContain('bg-[var(--badge-review)]');
  });

  it('renders status dot with correct color for done', () => {
    render(<DependencyNodeCard {...defaultProps} status="done" />);
    const dot = screen.getByTestId('status-dot');
    expect(dot.className).toContain('bg-[var(--badge-done)]');
  });

  it('renders status dot with correct color for failed', () => {
    render(<DependencyNodeCard {...defaultProps} status="failed" />);
    const dot = screen.getByTestId('status-dot');
    expect(dot.className).toContain('bg-[var(--badge-blocked)]');
  });

  it('renders dependency count', () => {
    render(<DependencyNodeCard {...defaultProps} dependencyCount={5} />);
    expect(screen.getByTestId('dependency-count').textContent).toBe('Dep: 5');
  });

  it('renders blocker count when greater than zero', () => {
    render(<DependencyNodeCard {...defaultProps} blockerCount={2} />);
    expect(screen.getByTestId('blocker-count').textContent).toBe('Blocking: 2');
  });

  it('hides blocker count when zero', () => {
    render(<DependencyNodeCard {...defaultProps} blockerCount={0} />);
    expect(screen.queryByTestId('blocker-count')).toBeNull();
  });

  it('applies glass-card styling', () => {
    const { container } = render(<DependencyNodeCard {...defaultProps} />);
    expect(container.querySelector('.glass-card')).toBeTruthy();
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    render(<DependencyNodeCard {...defaultProps} onClick={onClick} />);
    fireEvent.click(screen.getByText('Auth Module').closest('.glass-card')!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('has role=button when onClick is provided', () => {
    const onClick = vi.fn();
    render(<DependencyNodeCard {...defaultProps} onClick={onClick} />);
    const card = screen.getByRole('button');
    expect(card).toBeTruthy();
  });

  it('has no role=button when onClick is not provided', () => {
    render(<DependencyNodeCard {...defaultProps} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('calls onClick on Enter key', () => {
    const onClick = vi.fn();
    render(<DependencyNodeCard {...defaultProps} onClick={onClick} />);
    const card = screen.getByRole('button');
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('calls onClick on Space key', () => {
    const onClick = vi.fn();
    render(<DependencyNodeCard {...defaultProps} onClick={onClick} />);
    const card = screen.getByRole('button');
    fireEvent.keyDown(card, { key: ' ' });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders status dot aria-label', () => {
    render(<DependencyNodeCard {...defaultProps} status="in_progress" />);
    const dot = screen.getByTestId('status-dot');
    expect(dot.getAttribute('aria-label')).toBe('Status: in progress');
  });
});
