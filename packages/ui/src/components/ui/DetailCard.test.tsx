import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { AlertCircle, Clock } from 'lucide-react';
import { DetailCard } from './DetailCard.js';

describe('DetailCard', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders icon and title in header', () => {
    const { container } = render(
      <DetailCard icon={AlertCircle} title="Retry Policy">
        <span>content</span>
      </DetailCard>
    );

    const titleElement = container.querySelector('h3');
    expect(titleElement?.textContent).toContain('Retry Policy');
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders children content', () => {
    const { container } = render(
      <DetailCard icon={Clock} title="Time">
        <span test-id="child">Some content</span>
      </DetailCard>
    );

    expect(container.querySelector('[test-id="child"]')?.textContent).toBe('Some content');
  });

  it('renders Card structure correctly', () => {
    const { container } = render(
      <DetailCard icon={AlertCircle} title="Test">
        <span>Test</span>
      </DetailCard>
    );

    expect(container.querySelector('.rounded-lg')).toBeTruthy();
  });

  it('applies custom className', () => {
    const { container } = render(
      <DetailCard icon={Clock} title="Custom" className="custom-class">
        <span>Content</span>
      </DetailCard>
    );

    expect(container.querySelector('.custom-class')).toBeTruthy();
  });
});