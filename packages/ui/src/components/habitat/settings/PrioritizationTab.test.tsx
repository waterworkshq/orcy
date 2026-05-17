import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { PrioritizationTab } from './PrioritizationTab.js';
import type { PrioritizationSettings } from '../../../types/index.js';

const mockUpdate = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

vi.mock('../../../api/index.js', () => ({
  api: {
    habitats: {
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

const defaultSettings: PrioritizationSettings = {
  enabled: true,
  evaluateIntervalMinutes: 5,
  rules: [
    {
      id: 'rule-1',
      name: 'Overdue tasks → critical',
      enabled: true,
      condition: { type: 'overdue' },
      action: { type: 'set_priority', value: 'critical' },
      priority: 1,
    },
  ],
  fallbackToManual: true,
};

describe('PrioritizationTab', () => {
  const mockOnUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders Enable Prioritization Engine toggle', () => {
    render(
      <PrioritizationTab
        habitatId="b1"
        boardPrioritizationSettings={null}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.getByText('Enable Prioritization Engine')).toBeTruthy();
    expect(screen.getByText('Automatically adjust task priorities based on configurable rules')).toBeTruthy();
  });

  it('renders JSON editor with current rules when enabled', () => {
    render(
      <PrioritizationTab
        habitatId="b1"
        boardPrioritizationSettings={defaultSettings}
        onUpdate={mockOnUpdate}
      />
    );
    const editor = screen.getByTestId('prio-rules-editor') as HTMLTextAreaElement;
    const parsed = JSON.parse(editor.value);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('rule-1');
  });

  it('shows all fields when enabled', () => {
    render(
      <PrioritizationTab
        habitatId="b1"
        boardPrioritizationSettings={defaultSettings}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.getByText('Evaluate Interval (min)')).toBeTruthy();
    expect(screen.getByText('Fallback to manual priority')).toBeTruthy();
    expect(screen.getByText('Rules (JSON)')).toBeTruthy();
    expect(screen.getByTestId('prio-rules-editor')).toBeTruthy();
  });

  it('does not show fields when disabled', () => {
    render(
      <PrioritizationTab
        habitatId="b1"
        boardPrioritizationSettings={null}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.queryByText('Rules (JSON)')).toBeNull();
    expect(screen.queryByTestId('prio-rules-editor')).toBeNull();
  });

  it('initializes from board prioritization settings', () => {
    render(
      <PrioritizationTab
        habitatId="b1"
        boardPrioritizationSettings={defaultSettings}
        onUpdate={mockOnUpdate}
      />
    );
    const intervalInput = screen.getByLabelText('Evaluate Interval (min)') as HTMLInputElement;
    expect(intervalInput.value).toBe('5');
  });

  it('rule template is visible and contains example JSON', () => {
    render(
      <PrioritizationTab
        habitatId="b1"
        boardPrioritizationSettings={defaultSettings}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.getByText(/Rule Template/)).toBeTruthy();
    const template = screen.getByTestId('prio-rule-template');
    expect(template.textContent).toContain('overdue');
    expect(template.textContent).toContain('sla_approaching');
    expect(template.textContent).toContain('due_soon');
    expect(template.textContent).toContain('pending_duration');
    expect(template.textContent).toContain('dependency_count');
    expect(template.textContent).toContain('rejection_count');
    expect(template.textContent).toContain('feature_status');
    expect(template.textContent).toContain('agent_idle');
    expect(template.textContent).toContain('label_match');
    expect(template.textContent).toContain('priority_is');
    expect(template.textContent).toContain('set_priority');
    expect(template.textContent).toContain('bump_priority');
    expect(template.textContent).toContain('add_label');
    expect(template.textContent).toContain('set_score_bonus');
    expect(template.textContent).toContain('"type": "and"');
  });

  it('save button calls API with updated rules via ref', async () => {
    mockUpdate.mockResolvedValue({
      board: { ...defaultSettings, id: 'b1', name: 'Test', description: '' },
    });

    const ref = React.createRef<{ save: () => Promise<void> }>();
    render(
      <PrioritizationTab
        ref={ref}
        habitatId="b1"
        boardPrioritizationSettings={defaultSettings}
        onUpdate={mockOnUpdate}
      />
    );

    await act(async () => {
      await ref.current!.save();
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      'b1',
      expect.objectContaining({
        prioritizationSettings: expect.objectContaining({
          enabled: true,
          rules: expect.any(Array),
        }),
      })
    );
    expect(mockNotifySuccess).toHaveBeenCalledWith('Prioritization rules saved');
  });

  it('invalid JSON shows error message', async () => {
    const ref = React.createRef<{ save: () => Promise<void> }>();
    render(
      <PrioritizationTab
        ref={ref}
        habitatId="b1"
        boardPrioritizationSettings={defaultSettings}
        onUpdate={mockOnUpdate}
      />
    );

    const editor = screen.getByTestId('prio-rules-editor');
    await act(async () => {
      fireEvent.change(editor, { target: { value: '{invalid json' } });
    });

    await act(async () => {
      await ref.current!.save();
    });

    const errorEl = screen.getByTestId('prio-validation-error');
    expect(errorEl).toBeTruthy();
    expect(errorEl.textContent).toContain('Invalid JSON');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('non-array JSON shows error message', async () => {
    const ref = React.createRef<{ save: () => Promise<void> }>();
    render(
      <PrioritizationTab
        ref={ref}
        habitatId="b1"
        boardPrioritizationSettings={defaultSettings}
        onUpdate={mockOnUpdate}
      />
    );

    const editor = screen.getByTestId('prio-rules-editor');
    await act(async () => {
      fireEvent.change(editor, { target: { value: '{"not": "array"}' } });
    });

    await act(async () => {
      await ref.current!.save();
    });

    const errorEl = screen.getByTestId('prio-validation-error');
    expect(errorEl).toBeTruthy();
    expect(errorEl.textContent).toContain('JSON array');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('enable/disable toggle updates rules.enabled field', async () => {
    mockUpdate.mockResolvedValue({
      board: { id: 'b1', name: 'Test', description: '' },
    });

    const ref = React.createRef<{ save: () => Promise<void> }>();
    render(
      <PrioritizationTab
        ref={ref}
        habitatId="b1"
        boardPrioritizationSettings={defaultSettings}
        onUpdate={mockOnUpdate}
      />
    );

    const toggle = screen.getByTestId('toggle');
    await act(async () => {
      fireEvent.click(toggle);
    });

    await act(async () => {
      await ref.current!.save();
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      'b1',
      expect.objectContaining({
        prioritizationSettings: expect.objectContaining({
          enabled: false,
        }),
      })
    );
  });

  it('clears validation error when editor content changes', async () => {
    const ref = React.createRef<{ save: () => Promise<void> }>();
    render(
      <PrioritizationTab
        ref={ref}
        habitatId="b1"
        boardPrioritizationSettings={defaultSettings}
        onUpdate={mockOnUpdate}
      />
    );

    const editor = screen.getByTestId('prio-rules-editor');
    await act(async () => {
      fireEvent.change(editor, { target: { value: 'bad json' } });
    });
    await act(async () => {
      await ref.current!.save();
    });
    expect(screen.getByTestId('prio-validation-error')).toBeTruthy();

    await act(async () => {
      fireEvent.change(editor, { target: { value: '[]' } });
    });
    expect(screen.queryByTestId('prio-validation-error')).toBeNull();
  });
});
