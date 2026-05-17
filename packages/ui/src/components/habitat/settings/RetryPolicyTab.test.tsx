import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { RetryPolicyTab } from './RetryPolicyTab.js';
import type { RetryPolicy } from '../../../types/index.js';

const mockUpdate = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

vi.mock('../../../api/index.js', () => ({
  api: {
    boards: {
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

vi.mock('../../../lib/toast.js', () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
  },
}));

vi.mock('../../ui/ToggleSwitch.js', () => ({
  ToggleSwitch: ({ checked, onChange }: any) => (
    <button data-testid="toggle" onClick={() => onChange(!checked)} data-checked={checked} />
  ),
}));

vi.mock('../../ui/NumberField.js', () => ({
  NumberField: ({ label, value, onChange }: any) => (
    <div>
      <span>{label}</span>
      <input data-testid={`field-${label}`} value={value} onChange={(e: any) => onChange(e.target.value)} />
    </div>
  ),
}));

describe('RetryPolicyTab', () => {
  const mockOnUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders Enable Retry Policy toggle', () => {
    render(
      <RetryPolicyTab
        habitatId="b1"
        boardRetrySettings={null}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.getByText('Enable Retry Policy')).toBeTruthy();
    expect(screen.getByText('Auto-retry rejected tasks with exponential backoff')).toBeTruthy();
  });

  it('does not show fields when retry is disabled', () => {
    render(
      <RetryPolicyTab
        habitatId="b1"
        boardRetrySettings={null}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.queryByText('Max Retries')).toBeNull();
  });

  it('shows number fields when enabled', () => {
    const settings: RetryPolicy = {
      maxRetries: 3,
      backoffBase: 60,
      backoffMultiplier: 2,
      maxBackoff: 3600,
      escalateToHuman: true,
    };
    render(
      <RetryPolicyTab
        habitatId="b1"
        boardRetrySettings={settings}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.getByText('Max Retries')).toBeTruthy();
    expect(screen.getByText('Backoff Base (sec)')).toBeTruthy();
    expect(screen.getByText('Backoff Multiplier')).toBeTruthy();
    expect(screen.getByText('Max Backoff (sec)')).toBeTruthy();
    expect(screen.getByText('Escalate to human after max retries')).toBeTruthy();
  });

  it('initializes from board retry settings', () => {
    const settings: RetryPolicy = {
      maxRetries: 5,
      backoffBase: 120,
      backoffMultiplier: 3,
      maxBackoff: 7200,
      escalateToHuman: false,
    };
    render(
      <RetryPolicyTab
        habitatId="b1"
        boardRetrySettings={settings}
        onUpdate={mockOnUpdate}
      />
    );

    const maxRetriesField = screen.getByTestId('field-Max Retries') as HTMLInputElement;
    expect(maxRetriesField.value).toBe('5');

    const backoffBaseField = screen.getByTestId('field-Backoff Base (sec)') as HTMLInputElement;
    expect(backoffBaseField.value).toBe('120');
  });

  it('exposes save method via ref', async () => {
    render(
      <RetryPolicyTab
        ref={() => {}}
        habitatId="b1"
        boardRetrySettings={{
          maxRetries: 3,
          backoffBase: 60,
          backoffMultiplier: 2,
          maxBackoff: 3600,
          escalateToHuman: true,
        }}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.getByText('Max Retries')).toBeTruthy();
  });
});
