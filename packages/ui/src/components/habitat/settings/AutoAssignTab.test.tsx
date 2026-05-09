import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AutoAssignTab } from './AutoAssignTab.js';
import type { AutoAssignSettings } from '../../../types/index.js';

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
  NumberField: ({ label, value, onChange, id }: any) => (
    <div>
      <label htmlFor={id}>{label}</label>
      <input data-testid={`field-${id}`} id={id} value={value} onChange={(e: any) => onChange(e.target.value)} />
    </div>
  ),
}));

const defaultAutoAssign: AutoAssignSettings = {
  enabled: true,
  strategy: 'best_match',
  maxTasksPerAgent: 5,
  requireDomainMatch: false,
  requireCapabilityMatch: false,
  excludeOfflineAgents: true,
};

describe('AutoAssignTab', () => {
  const mockOnUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders Enable Auto-Assign toggle', () => {
    render(
      <AutoAssignTab
        boardId="b1"
        boardAutoAssignSettings={null}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.getByText('Enable Auto-Assign')).toBeTruthy();
    expect(screen.getByText('Automatically assign new tasks to the best available agent')).toBeTruthy();
  });

  it('shows strategy select when enabled', () => {
    render(
      <AutoAssignTab
        boardId="b1"
        boardAutoAssignSettings={defaultAutoAssign}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.getByText('Strategy')).toBeTruthy();
    expect(screen.getByText('Max Tasks Per Agent')).toBeTruthy();
  });

  it('renders checkbox options when enabled', () => {
    render(
      <AutoAssignTab
        boardId="b1"
        boardAutoAssignSettings={defaultAutoAssign}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.getByText('Require Domain Match')).toBeTruthy();
    expect(screen.getByText('Require Capability Match')).toBeTruthy();
    expect(screen.getByText('Exclude Offline Agents')).toBeTruthy();
  });

  it('renders strategy descriptions', () => {
    render(
      <AutoAssignTab
        boardId="b1"
        boardAutoAssignSettings={defaultAutoAssign}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.getByText('Only assign to agents matching the task domain')).toBeTruthy();
    expect(screen.getByText('Only assign if agent has all required capabilities')).toBeTruthy();
    expect(screen.getByText('Skip agents without recent heartbeat')).toBeTruthy();
  });

  it('initializes from board auto-assign settings', () => {
    render(
      <AutoAssignTab
        boardId="b1"
        boardAutoAssignSettings={defaultAutoAssign}
        onUpdate={mockOnUpdate}
      />
    );

    const maxTasksField = screen.getByTestId('field-auto-assign-max-tasks') as HTMLInputElement;
    expect(maxTasksField.value).toBe('5');
  });

  it('does not show fields when disabled', () => {
    render(
      <AutoAssignTab
        boardId="b1"
        boardAutoAssignSettings={null}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.queryByText('Strategy')).toBeNull();
  });
});
