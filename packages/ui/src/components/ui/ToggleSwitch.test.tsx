import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { ToggleSwitch } from './ToggleSwitch.js';

describe('ToggleSwitch', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders unchecked state correctly', () => {
    const handleChange = vi.fn();
    const { container } = render(<ToggleSwitch checked={false} onChange={handleChange} />);

    const button = container.querySelector('button')!;
    expect(button.getAttribute('aria-checked')).toBe('false');
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it('renders checked state correctly', () => {
    const handleChange = vi.fn();
    const { container } = render(<ToggleSwitch checked={true} onChange={handleChange} />);

    const button = container.querySelector('button')!;
    expect(button.getAttribute('aria-checked')).toBe('true');
  });

  it('calls onChange with !checked on click', () => {
    const handleChange = vi.fn();
    const { container } = render(<ToggleSwitch checked={false} onChange={handleChange} />);

    fireEvent.click(container.querySelector('button')!);
    expect(handleChange).toHaveBeenCalledWith(true);
  });

  it('calls onChange with false when toggled from true', () => {
    const handleChange = vi.fn();
    const { container } = render(<ToggleSwitch checked={true} onChange={handleChange} />);

    fireEvent.click(container.querySelector('button')!);
    expect(handleChange).toHaveBeenCalledWith(false);
  });

  it('has correct role attribute', () => {
    const handleChange = vi.fn();
    const { container } = render(<ToggleSwitch checked={false} onChange={handleChange} />);

    const button = container.querySelector('button')!;
    expect(button.getAttribute('role')).toBe('switch');
  });

  it('respects disabled prop', () => {
    const handleChange = vi.fn();
    const { container } = render(<ToggleSwitch checked={false} onChange={handleChange} disabled />);

    const button = container.querySelector('button')!;
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('does not call onChange when disabled', () => {
    const handleChange = vi.fn();
    const { container } = render(<ToggleSwitch checked={false} onChange={handleChange} disabled />);

    fireEvent.click(container.querySelector('button')!);
    expect(handleChange).not.toHaveBeenCalled();
  });

  it('applies custom className', () => {
    const handleChange = vi.fn();
    const { container } = render(
      <ToggleSwitch checked={false} onChange={handleChange} className="custom-class" />
    );

    expect(container.querySelector('button')?.className.includes('custom-class')).toBe(true);
  });
});