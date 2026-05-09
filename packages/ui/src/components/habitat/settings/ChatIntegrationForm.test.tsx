import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ChatIntegrationForm } from './ChatIntegrationForm.js';
import type { ChatIntegration } from '../../../types/index.js';

vi.mock('../../ui/Button.js', () => ({
  Button: ({ children, onClick, loading }: any) => (
    <button onClick={onClick} disabled={loading}>{children}</button>
  ),
}));

describe('ChatIntegrationForm', () => {
  const mockOnSave = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders provider select', () => {
    render(<ChatIntegrationForm saving={false} onSave={mockOnSave} onCancel={mockOnCancel} />);
    expect(screen.getByText('Provider')).toBeTruthy();
  });

  it('renders Webhook URL input', () => {
    render(<ChatIntegrationForm saving={false} onSave={mockOnSave} onCancel={mockOnCancel} />);
    expect(screen.getByText('Webhook URL')).toBeTruthy();
  });

  it('renders Channel ID input', () => {
    render(<ChatIntegrationForm saving={false} onSave={mockOnSave} onCancel={mockOnCancel} />);
    expect(screen.getByText('Channel ID (optional)')).toBeTruthy();
  });

  it('renders Bot Token input', () => {
    render(<ChatIntegrationForm saving={false} onSave={mockOnSave} onCancel={mockOnCancel} />);
    expect(screen.getByText('Bot Token (optional)')).toBeTruthy();
  });

  it('renders Events section', () => {
    render(<ChatIntegrationForm saving={false} onSave={mockOnSave} onCancel={mockOnCancel} />);
    expect(screen.getByText('Events')).toBeTruthy();
    expect(screen.getByText('Task Created')).toBeTruthy();
    expect(screen.getByText('Task Claimed')).toBeTruthy();
    expect(screen.getByText('Task Submitted')).toBeTruthy();
  });

  it('renders Create button for new integration', () => {
    render(<ChatIntegrationForm saving={false} onSave={mockOnSave} onCancel={mockOnCancel} />);
    expect(screen.getByText('Create')).toBeTruthy();
  });

  it('renders Update button when editing', () => {
    const existing: ChatIntegration = {
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
    render(<ChatIntegrationForm existing={existing} saving={false} onSave={mockOnSave} onCancel={mockOnCancel} />);
    expect(screen.getByText('Update')).toBeTruthy();
  });

  it('renders Cancel button', () => {
    render(<ChatIntegrationForm saving={false} onSave={mockOnSave} onCancel={mockOnCancel} />);
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  it('calls onSave with form state when Create is clicked', () => {
    render(<ChatIntegrationForm saving={false} onSave={mockOnSave} onCancel={mockOnCancel} />);
    fireEvent.click(screen.getByText('Create'));
    expect(mockOnSave).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'slack',
        events: expect.arrayContaining(['task_created', 'task_claimed', 'task_submitted', 'task_approved', 'task_rejected', 'task_overdue']),
      })
    );
  });
});
