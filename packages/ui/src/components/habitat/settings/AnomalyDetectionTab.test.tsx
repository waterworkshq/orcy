import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AnomalyDetectionTab } from './AnomalyDetectionTab.js';
import type { AnomalySettings } from '../../../types/index.js';

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

const defaultAnomalySettings: AnomalySettings = {
  enabled: true,
  scanIntervalMinutes: 5,
  thresholds: {
    staleInProgressMinutes: 240,
    rejectionRatePercent: 40,
    rejectionWindowTasks: 10,
    cycleTimeIncreasePercent: 50,
    backlogToAgentRatio: 2,
    agentOfflineMinutes: 15,
  },
  notifications: {
    email: true,
    sse: true,
    chat: true,
  },
};

describe('AnomalyDetectionTab', () => {
  const mockOnUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders Enable Anomaly Detection toggle', () => {
    render(
      <AnomalyDetectionTab
        boardId="b1"
        boardAnomalySettings={null}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.getByText('Enable Anomaly Detection')).toBeTruthy();
    expect(screen.getByText('Automatically detect unusual patterns and alert')).toBeTruthy();
  });

  it('shows all number fields when enabled', () => {
    render(
      <AnomalyDetectionTab
        boardId="b1"
        boardAnomalySettings={defaultAnomalySettings}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.getByText('Scan Interval (min)')).toBeTruthy();
    expect(screen.getByText('Stale In-Progress (min)')).toBeTruthy();
    expect(screen.getByText('Rejection Rate (%)')).toBeTruthy();
    expect(screen.getByText('Rejection Window (tasks)')).toBeTruthy();
    expect(screen.getByText('Cycle Time Increase (%)')).toBeTruthy();
    expect(screen.getByText('Backlog-to-Agent Ratio')).toBeTruthy();
    expect(screen.getByText('Agent Offline (min)')).toBeTruthy();
  });

  it('renders Notification Channels section', () => {
    render(
      <AnomalyDetectionTab
        boardId="b1"
        boardAnomalySettings={defaultAnomalySettings}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.getByText('Notification Channels')).toBeTruthy();
    expect(screen.getByText('Real-time (SSE)')).toBeTruthy();
    expect(screen.getByText('Email (high/critical only)')).toBeTruthy();
    expect(screen.getByText('Chat (Slack/Discord)')).toBeTruthy();
  });

  it('initializes from board anomaly settings', () => {
    render(
      <AnomalyDetectionTab
        boardId="b1"
        boardAnomalySettings={defaultAnomalySettings}
        onUpdate={mockOnUpdate}
      />
    );

    const scanIntervalField = screen.getByTestId('field-anomaly-scan-interval') as HTMLInputElement;
    expect(scanIntervalField.value).toBe('5');

    const staleField = screen.getByTestId('field-anomaly-stale') as HTMLInputElement;
    expect(staleField.value).toBe('240');
  });

  it('shows fields by default when no settings provided', () => {
    render(
      <AnomalyDetectionTab
        boardId="b1"
        boardAnomalySettings={null}
        onUpdate={mockOnUpdate}
      />
    );
    expect(screen.getByText('Scan Interval (min)')).toBeTruthy();
  });
});
