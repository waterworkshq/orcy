import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { PrioritizationTab } from './PrioritizationTab.js';
import type { PrioritizationSettings } from '../../../types/index.js';

const mockUpdate = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

let capturedOnDragEnd: ((event: any) => void) | null = null;

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
    <button data-testid={`toggle-${checked}`} onClick={() => onChange(!checked)} data-checked={checked} />
  ),
}));

vi.mock('../../ui/Button.js', () => ({
  Button: ({ children, onClick, disabled, loading, ...props }: any) => (
    <button onClick={onClick} disabled={disabled || loading} data-testid={props['data-testid']}>
      {children}
    </button>
  ),
}));

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd }: any) => {
    capturedOnDragEnd = onDragEnd ?? null;
    return <div data-testid="dnd-context">{children}</div>;
  },
  DragOverlay: ({ children }: any) => <div>{children}</div>,
  closestCorners: {},
  PointerSensor: vi.fn(),
  TouchSensor: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: any) => <div data-testid="sortable-context">{children}</div>,
  verticalListSortingStrategy: {},
  useSortable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  })),
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: () => '',
    },
  },
}));

vi.mock('lucide-react', () => ({
  GripVertical: () => <span data-testid="grip-icon" />,
  Trash2: (props: any) => <button data-testid="trash-btn" onClick={props?.onClick} />,
  Plus: () => <span data-testid="plus-icon" />,
  ChevronDown: () => <span data-testid="chevron-down" />,
  ChevronRight: () => <span data-testid="chevron-right" />,
  AlertTriangle: () => <span data-testid="alert-icon" />,
}));

const defaultSettings: PrioritizationSettings = {
  enabled: true,
  evaluateIntervalMinutes: 5,
  rules: [
    {
      id: 'rule-1',
      name: 'Overdue tasks',
      enabled: true,
      condition: { type: 'overdue', byDays: 1 },
      action: { type: 'set_priority', value: 'critical' },
      priority: 1,
    },
  ],
  fallbackToManual: true,
};

const multiRuleSettings: PrioritizationSettings = {
  enabled: true,
  evaluateIntervalMinutes: 5,
  rules: [
    {
      id: 'rule-1',
      name: 'Overdue tasks',
      enabled: true,
      condition: { type: 'overdue', byDays: 1 },
      action: { type: 'set_priority', value: 'critical' },
      priority: 1,
    },
    {
      id: 'rule-2',
      name: 'SLA approaching',
      enabled: true,
      condition: { type: 'sla_approaching', withinHours: 4 },
      action: { type: 'set_priority', value: 'high' },
      priority: 2,
    },
  ],
  fallbackToManual: true,
};

const compositeSettings: PrioritizationSettings = {
  enabled: true,
  evaluateIntervalMinutes: 5,
  rules: [
    {
      id: 'rule-comp',
      name: 'Composite rule',
      enabled: true,
      condition: { type: 'and', conditions: [{ type: 'overdue' }, { type: 'label_match', labels: ['urgent'] }] },
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
    capturedOnDragEnd = null;
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

  it('shows settings when enabled, hides when disabled', () => {
    const { rerender } = render(
      <PrioritizationTab
        habitatId="b1"
        boardPrioritizationSettings={defaultSettings}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.getByText('Rules')).toBeTruthy();
    expect(screen.getByText('Evaluate Interval (min)')).toBeTruthy();

    rerender(
      <PrioritizationTab
        habitatId="b1"
        boardPrioritizationSettings={null}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.queryByText('Rules')).toBeNull();
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

  it('renders rule cards from settings', () => {
    render(
      <PrioritizationTab
        habitatId="b1"
        boardPrioritizationSettings={multiRuleSettings}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.getByText('Overdue tasks')).toBeTruthy();
    expect(screen.getByText('SLA approaching')).toBeTruthy();
    expect(screen.getAllByText('Edit').length).toBe(2);
  });

  it('shows empty state when no rules', () => {
    const emptySettings: PrioritizationSettings = {
      enabled: true,
      evaluateIntervalMinutes: 5,
      rules: [],
      fallbackToManual: true,
    };
    render(
      <PrioritizationTab
        habitatId="b1"
        boardPrioritizationSettings={emptySettings}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.getByText('No rules configured. Add a rule to start auto-prioritizing tasks.')).toBeTruthy();
  });

  it('shows rule preview text in collapsed cards', () => {
    render(
      <PrioritizationTab
        habitatId="b1"
        boardPrioritizationSettings={defaultSettings}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.getByText(/overdue by 1d/)).toBeTruthy();
    expect(screen.getByText(/set priority to critical/)).toBeTruthy();
  });

  it('adds a new rule on Add Rule click', () => {
    render(
      <PrioritizationTab
        habitatId="b1"
        boardPrioritizationSettings={defaultSettings}
        onUpdate={mockOnUpdate}
      />
    );
    const addBtn = screen.getByText('Add Rule');
    fireEvent.click(addBtn);
    expect(screen.getByPlaceholderText('Rule name')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
  });

  it('expands rule on Edit click and collapses on Done', () => {
    render(
      <PrioritizationTab
        habitatId="b1"
        boardPrioritizationSettings={defaultSettings}
        onUpdate={mockOnUpdate}
      />
    );
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText('Condition')).toBeTruthy();
    expect(screen.getByText('Action')).toBeTruthy();

    fireEvent.click(screen.getByText('Done'));
    expect(screen.queryByText('Condition')).toBeNull();
    expect(screen.getByText('Edit')).toBeTruthy();
  });

  it('deletes a rule', () => {
    render(
      <PrioritizationTab
        habitatId="b1"
        boardPrioritizationSettings={multiRuleSettings}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.getByText('Overdue tasks')).toBeTruthy();
    const trashButtons = screen.getAllByTestId('trash-btn');
    fireEvent.click(trashButtons[0]);
    expect(screen.queryByText('Overdue tasks')).toBeNull();
    expect(screen.getByText('SLA approaching')).toBeTruthy();
  });

  it('toggles individual rule enabled state', () => {
    render(
      <PrioritizationTab
        habitatId="b1"
        boardPrioritizationSettings={defaultSettings}
        onUpdate={mockOnUpdate}
      />
    );
    const toggles = screen.getAllByTestId(/toggle-/);
    const ruleToggle = toggles.find(t => t.closest('[data-testid^="rule-card-"]'));
    expect(ruleToggle).toBeTruthy();
  });

  it('shows warning for composite conditions when expanded', () => {
    render(
      <PrioritizationTab
        habitatId="b1"
        boardPrioritizationSettings={compositeSettings}
        onUpdate={mockOnUpdate}
      />
    );
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByText('Composite conditions can only be edited in Advanced Mode')).toBeTruthy();
    expect(screen.getByText('Replace with leaf condition')).toBeTruthy();
  });

  it('opens advanced mode with current rules as JSON', () => {
    render(
      <PrioritizationTab
        habitatId="b1"
        boardPrioritizationSettings={defaultSettings}
        onUpdate={mockOnUpdate}
      />
    );
    fireEvent.click(screen.getByText('Advanced Mode (JSON)'));
    const editor = screen.getByTestId('prio-rules-editor') as HTMLTextAreaElement;
    const parsed = JSON.parse(editor.value);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('rule-1');
  });

  it('shows validation error for invalid JSON in advanced mode', async () => {
    const ref = React.createRef<{ save: () => Promise<void> }>();
    render(
      <PrioritizationTab
        ref={ref}
        habitatId="b1"
        boardPrioritizationSettings={defaultSettings}
        onUpdate={mockOnUpdate}
      />
    );
    fireEvent.click(screen.getByText('Advanced Mode (JSON)'));
    const editor = screen.getByTestId('prio-rules-editor');
    await act(async () => {
      fireEvent.change(editor, { target: { value: '{invalid json' } });
    });
    expect(screen.getByTestId('prio-validation-error')).toBeTruthy();
    expect(screen.getByTestId('prio-validation-error').textContent).toContain('Invalid JSON');

    await act(async () => {
      await ref.current!.save();
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('shows validation error for non-array JSON in advanced mode on save', async () => {
    const ref = React.createRef<{ save: () => Promise<void> }>();
    render(
      <PrioritizationTab
        ref={ref}
        habitatId="b1"
        boardPrioritizationSettings={defaultSettings}
        onUpdate={mockOnUpdate}
      />
    );
    fireEvent.click(screen.getByText('Advanced Mode (JSON)'));
    const editor = screen.getByTestId('prio-rules-editor');
    await act(async () => {
      fireEvent.change(editor, { target: { value: '{"not": "array"}' } });
    });
    expect(screen.getByTestId('prio-validation-error').textContent).toContain('JSON array');

    await act(async () => {
      await ref.current!.save();
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('save via ref calls API with visual state', async () => {
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

  it('save with advanced open validates JSON first', async () => {
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

    fireEvent.click(screen.getByText('Advanced Mode (JSON)'));
    const editor = screen.getByTestId('prio-rules-editor');

    await act(async () => {
      fireEvent.change(editor, { target: { value: '[{"id":"r1","name":"test","enabled":true,"condition":{"type":"overdue"},"action":{"type":"set_priority","value":"high"},"priority":1}]' } });
    });

    await act(async () => {
      await ref.current!.save();
    });

    expect(mockUpdate).toHaveBeenCalled();
  });

  it('reorders rules on drag end', async () => {
    mockUpdate.mockResolvedValue({
      board: { id: 'b1', name: 'Test', description: '' },
    });

    const ref = React.createRef<{ save: () => Promise<void> }>();
    render(
      <PrioritizationTab
        ref={ref}
        habitatId="b1"
        boardPrioritizationSettings={multiRuleSettings}
        onUpdate={mockOnUpdate}
      />
    );

    act(() => {
      capturedOnDragEnd!({ active: { id: 'rule-1' }, over: { id: 'rule-2' } });
    });

    await act(async () => {
      await ref.current!.save();
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      'b1',
      expect.objectContaining({
        prioritizationSettings: expect.objectContaining({
          rules: expect.arrayContaining([
            expect.objectContaining({ id: 'rule-2', priority: 0 }),
            expect.objectContaining({ id: 'rule-1', priority: 1 }),
          ]),
        }),
      })
    );
  });
});
