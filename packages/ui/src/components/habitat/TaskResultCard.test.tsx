import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskResultCard } from './TaskResultCard.js';

vi.mock('../ui/Card.js', () => ({
  Card: ({ children, className }: any) => <div className={className}>{children}</div>,
  CardHeader: ({ children, className }: any) => <div className={className}>{children}</div>,
  CardTitle: ({ children, className }: any) => <div className={className}>{children}</div>,
  CardContent: ({ children, className }: any) => <div className={className}>{children}</div>,
}));

vi.mock('../ui/MarkdownContent.js', () => ({
  MarkdownContent: ({ content }: any) => <div>{content}</div>,
}));

describe('TaskResultCard', () => {
  it('renders nothing when no result and no rejection', () => {
    const { container } = render(
      <TaskResultCard result={null} rejectionReason={null} rejectedCount={0} />
    );
    expect(container.children.length).toBe(0);
  });

  it('renders result card', () => {
    render(<TaskResultCard result="Done!" rejectionReason={null} rejectedCount={0} />);
    expect(screen.getByText('Result')).toBeTruthy();
    expect(screen.getByText('Done!')).toBeTruthy();
  });

  it('renders rejection reason', () => {
    render(<TaskResultCard result={null} rejectionReason="Bad code" rejectedCount={1} />);
    expect(screen.getByText('Rejection Reason')).toBeTruthy();
    expect(screen.getByText('Bad code')).toBeTruthy();
  });

  it('shows rejected count when > 1', () => {
    render(<TaskResultCard result={null} rejectionReason="Bad" rejectedCount={3} />);
    expect(screen.getByText(/rejected 3x/)).toBeTruthy();
  });

  it('does not show rejected count when 1', () => {
    const { container } = render(
      <TaskResultCard result={null} rejectionReason="Bad" rejectedCount={1} />
    );
    expect(container.textContent).not.toContain('rejected 1x');
  });
});
