import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { NumberField } from './NumberField.js';

describe('NumberField', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders label correctly', () => {
    const { container } = render(
      <NumberField label="Max Retries" value="3" onChange={vi.fn()} />
    );
    expect(container.querySelector('label')?.textContent).toBe('Max Retries');
  });

  it('renders input with correct type=number', () => {
    const { container } = render(
      <NumberField label="Max Retries" value="3" onChange={vi.fn()} />
    );
    expect(container.querySelector('input')?.getAttribute('type')).toBe('number');
  });

  it('renders input with correct min/max', () => {
    const { container } = render(
      <NumberField label="Max Retries" value="3" onChange={vi.fn()} min={0} max={10} />
    );
    const input = container.querySelector('input')!;
    expect(input.getAttribute('min')).toBe('0');
    expect(input.getAttribute('max')).toBe('10');
  });

  it('renders input with correct step', () => {
    const { container } = render(
      <NumberField label="Multiplier" value="2" onChange={vi.fn()} step={0.5} />
    );
    expect(container.querySelector('input')?.getAttribute('step')).toBe('0.5');
  });

  it('renders input with correct value', () => {
    const { container } = render(
      <NumberField label="Max Retries" value="5" onChange={vi.fn()} />
    );
    expect(container.querySelector('input')?.value).toBe('5');
  });

  it('calls onChange with new value on input change', () => {
    const handleChange = vi.fn();
    const { container } = render(
      <NumberField label="Max Retries" value="3" onChange={handleChange} />
    );

    fireEvent.change(container.querySelector('input')!, { target: { value: '7' } });
    expect(handleChange).toHaveBeenCalledWith('7');
  });

  it('renders with htmlFor id on label', () => {
    const { container } = render(
      <NumberField label="Max Retries" value="3" onChange={vi.fn()} id="max-retries" />
    );
    expect(container.querySelector('label')?.getAttribute('for')).toBe('max-retries');
    expect(container.querySelector('input')?.getAttribute('id')).toBe('max-retries');
  });

  it('renders description text when provided', () => {
    const { container } = render(
      <NumberField
        label="Max Retries"
        value="3"
        onChange={vi.fn()}
        description="Maximum number of retry attempts"
      />
    );
    expect(container.textContent).toContain('Maximum number of retry attempts');
  });

  it('applies custom className', () => {
    const { container } = render(
      <NumberField label="Max Retries" value="3" onChange={vi.fn()} className="custom-class" />
    );
    expect(container.querySelector('div')?.className.includes('custom-class')).toBe(true);
  });
});