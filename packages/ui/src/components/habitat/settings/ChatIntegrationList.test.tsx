import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ChatIntegrationList } from './ChatIntegrationList.js';
import type { ChatIntegration } from '../../../types/index.js';

vi.mock('../../ui/ToggleSwitch.js', () => ({
  ToggleSwitch: ({ checked, onChange }: any) => (
    <button data-testid={`toggle-${checked}`} onClick={() => onChange(!checked)} />
  ),
}));

vi.mock('../../ui/Button.js', () => ({
  Button: ({ children, onClick, loading }: any) => (
    <button onClick={onClick} disabled={loading}>{children}</button>
  ),
}));

const mockIntegration: ChatIntegration = {
  id: 'ci1',
  boardId: 'b1',
  provider: 'slack',
  webhookUrl: 'https://hooks.slack.com/test',
  channelId: null,
  botToken: null,
  enabled: 1,
  events: ['task_created'],
  createdAt: '',
  updatedAt: '',
};

describe('ChatIntegrationList', () => {
  const mockOnTest = vi.fn();
  const mockOnEdit = vi.fn();
  const mockOnDelete = vi.fn();
  const mockOnToggle = vi.fn();
  const mockOnAdd = vi.fn();

  const defaultProps = {
    integrations: [mockIntegration],
    testing: null,
    onTest: mockOnTest,
    onEdit: mockOnEdit,
    onDelete: mockOnDelete,
    onToggle: mockOnToggle,
    onAdd: mockOnAdd,
    loading: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders Add Integration button', () => {
    render(<ChatIntegrationList {...defaultProps} />);
    expect(screen.getByText('Add Integration')).toBeTruthy();
  });

  it('renders integration provider badge', () => {
    render(<ChatIntegrationList {...defaultProps} />);
    expect(screen.getByText('slack')).toBeTruthy();
  });

  it('renders integration webhook URL', () => {
    render(<ChatIntegrationList {...defaultProps} />);
    expect(screen.getByText('https://hooks.slack.com/test')).toBeTruthy();
  });

  it('renders action buttons', () => {
    render(<ChatIntegrationList {...defaultProps} />);
    expect(screen.getByText('Test')).toBeTruthy();
    expect(screen.getByText('Edit')).toBeTruthy();
    expect(screen.getByText('Delete')).toBeTruthy();
  });

  it('renders loading state', () => {
    render(<ChatIntegrationList {...defaultProps} loading={true} />);
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('renders empty state', () => {
    render(<ChatIntegrationList {...defaultProps} integrations={[]} />);
    expect(screen.getByText(/No chat integrations configured/)).toBeTruthy();
  });

  it('renders multiple integrations', () => {
    const integrations = [
      mockIntegration,
      { ...mockIntegration, id: 'ci2', provider: 'discord' as const, webhookUrl: 'https://discord.com/test' },
    ];
    render(<ChatIntegrationList {...defaultProps} integrations={integrations} />);
    expect(screen.getByText('slack')).toBeTruthy();
    expect(screen.getByText('discord')).toBeTruthy();
  });
});
