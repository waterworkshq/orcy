import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskTimeConstraints } from './TaskTimeConstraints.js';

describe('TaskTimeConstraints', () => {
  it('renders nothing when no estimatedMinutes', () => {
    const { container } = render(
      <TaskTimeConstraints estimatedMinutes={null} />
    );
    expect(container.children.length).toBe(0);
  });

  it('renders estimated minutes', () => {
    render(<TaskTimeConstraints estimatedMinutes={30} />);
    expect(screen.getByText('Estimated: 30min')).toBeTruthy();
  });

  it('renders with large estimated minutes', () => {
    render(<TaskTimeConstraints estimatedMinutes={120} />);
    expect(screen.getByText('Estimated: 120min')).toBeTruthy();
  });
});
