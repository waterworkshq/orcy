import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskRetryPolicy } from './TaskRetryPolicy.js';

describe('TaskRetryPolicy', () => {
  it('renders nothing when no retry policy', () => {
    const { container } = render(
      <TaskRetryPolicy
        task={{ retryPolicy: null, retryCount: 0, nextRetryAt: null }}
      />
    );
    expect(container.children.length).toBe(0);
  });

  it('renders retry policy details', () => {
    render(
      <TaskRetryPolicy
        task={{
          retryPolicy: {
            maxRetries: 3,
            backoffBase: 60,
            backoffMultiplier: 2,
            maxBackoff: 3600,
            escalateToHuman: true,
          },
          retryCount: 0,
          nextRetryAt: null,
        }}
      />
    );
    expect(screen.getByText('Max Retries')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('Backoff Base')).toBeTruthy();
    expect(screen.getByText('60s')).toBeTruthy();
  });
});
