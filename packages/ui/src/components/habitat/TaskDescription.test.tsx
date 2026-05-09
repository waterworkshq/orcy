import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskDescription } from './TaskDescription.js';

vi.mock('../ui/DetailCard.js', () => ({
  DetailCard: ({ children, title }: any) => (
    <div data-testid="detail-card" data-title={title}>{children}</div>
  ),
}));

vi.mock('../ui/MarkdownContent.js', () => ({
  MarkdownContent: ({ content }: any) => <div>{content}</div>,
}));

vi.mock('../ui/RichTextEditor.js', () => ({
  RichTextViewer: ({ content }: any) => <div>{content}</div>,
  isHtmlContent: (s: string) => s.startsWith('<'),
}));

describe('TaskDescription', () => {
  it('renders nothing when description is empty', () => {
    const { container } = render(<TaskDescription description="" />);
    expect(container.children.length).toBe(0);
  });

  it('renders markdown description', () => {
    render(<TaskDescription description="Hello **world**" />);
    expect(screen.getByText('Hello **world**')).toBeTruthy();
  });

  it('renders html description with RichTextViewer', () => {
    render(<TaskDescription description="<p>Hello</p>" />);
    expect(screen.getByText('<p>Hello</p>')).toBeTruthy();
  });
});
