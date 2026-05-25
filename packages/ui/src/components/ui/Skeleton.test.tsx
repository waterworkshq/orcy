import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { SkeletonCard } from './SkeletonCard.js';
import { SkeletonColumn } from './SkeletonColumn.js';
import { SkeletonHeader } from './SkeletonHeader.js';
import { SkeletonModal } from './SkeletonModal.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const cssPath = resolve(__dirname, '../../styles/design-system.css');
const cssContent = readFileSync(cssPath, 'utf-8');

function LoadingWrapper({ isLoading }: { isLoading: boolean }) {
  if (isLoading) return <SkeletonColumn cardCount={3} />;
  return <div data-testid="loaded-content">Loaded</div>;
}

function HeaderWrapper({ isLoading }: { isLoading: boolean }) {
  if (isLoading) return <SkeletonHeader />;
  return <div data-testid="real-header">Real Header</div>;
}

describe('Skeleton Components', () => {
  afterEach(() => {
    cleanup();
  });

  describe('SkeletonCard', () => {
    it('renders with correct shape', () => {
      const { container } = render(<SkeletonCard />);
      const card = container.querySelector('[data-testid="skeleton-card"]');
      expect(card).toBeTruthy();
      expect(card?.classList.contains('glass-card')).toBe(true);
    });

    it('renders skeleton pulse elements', () => {
      const { container } = render(<SkeletonCard />);
      const skeletons = container.querySelectorAll('.skeleton');
      expect(skeletons.length).toBeGreaterThanOrEqual(2);
    });

    it('shows badges by default', () => {
      const { container } = render(<SkeletonCard />);
      const badges = container.querySelectorAll('.rounded-full');
      expect(badges.length).toBeGreaterThanOrEqual(2);
    });

    it('hides badges when hasBadges is false', () => {
      const { container } = render(<SkeletonCard hasBadges={false} />);
      const badgeContainers = container.querySelectorAll('.flex.items-center.gap-1\\.5');
      expect(badgeContainers.length).toBe(0);
    });

    it('shows progress by default', () => {
      const { container } = render(<SkeletonCard />);
      const progressBars = container.querySelectorAll('.skeleton.h-1\\.5');
      expect(progressBars.length).toBe(1);
    });

    it('hides progress when hasProgress is false', () => {
      const { container } = render(<SkeletonCard hasProgress={false} />);
      const progressBars = container.querySelectorAll('.skeleton.h-1\\.5');
      expect(progressBars.length).toBe(0);
    });

    it('applies custom className', () => {
      const { container } = render(<SkeletonCard className="custom-class" />);
      const card = container.querySelector('[data-testid="skeleton-card"]');
      expect(card?.classList.contains('custom-class')).toBe(true);
    });
  });

  describe('SkeletonColumn', () => {
    it('renders with correct shape', () => {
      const { container } = render(<SkeletonColumn />);
      const column = container.querySelector('[data-testid="skeleton-column"]');
      expect(column).toBeTruthy();
    });

    it('renders default 4 cards', () => {
      const { container } = render(<SkeletonColumn />);
      const cards = container.querySelectorAll('[data-testid="skeleton-card"]');
      expect(cards.length).toBe(4);
    });

    it('renders custom card count', () => {
      const { container } = render(<SkeletonColumn cardCount={6} />);
      const cards = container.querySelectorAll('[data-testid="skeleton-card"]');
      expect(cards.length).toBe(6);
    });

    it('renders column header skeleton', () => {
      const { container } = render(<SkeletonColumn />);
      const headerArea = container.querySelector('.flex.items-center.justify-between');
      expect(headerArea).toBeTruthy();
      expect(headerArea!.querySelectorAll('.skeleton').length).toBe(2);
    });
  });

  describe('SkeletonHeader', () => {
    it('renders with correct shape', () => {
      const { container } = render(<SkeletonHeader />);
      const header = container.querySelector('[data-testid="skeleton-header"]');
      expect(header).toBeTruthy();
    });

    it('renders title placeholder', () => {
      const { container } = render(<SkeletonHeader />);
      const titleSkeleton = container.querySelector('.skeleton.h-6');
      expect(titleSkeleton).toBeTruthy();
    });

    it('renders badge placeholders', () => {
      const { container } = render(<SkeletonHeader />);
      const badges = container.querySelectorAll('.rounded-full');
      expect(badges.length).toBeGreaterThanOrEqual(2);
    });

    it('renders action button placeholders', () => {
      const { container } = render(<SkeletonHeader />);
      const actions = container.querySelector('.flex.items-center.gap-3');
      expect(actions).toBeTruthy();
      expect(actions!.querySelectorAll('.skeleton').length).toBeGreaterThanOrEqual(3);
    });

    it('applies custom className', () => {
      const { container } = render(<SkeletonHeader className="extra" />);
      const header = container.querySelector('[data-testid="skeleton-header"]');
      expect(header?.classList.contains('extra')).toBe(true);
    });
  });

  describe('SkeletonModal', () => {
    it('renders with correct shape', () => {
      const { container } = render(<SkeletonModal />);
      const modal = container.querySelector('[data-testid="skeleton-modal"]');
      expect(modal).toBeTruthy();
      expect(modal?.classList.contains('glass-modal')).toBe(true);
    });

    it('renders header with title and close button', () => {
      const { container } = render(<SkeletonModal />);
      const headerArea = container.querySelector('.flex.items-center.justify-between');
      expect(headerArea).toBeTruthy();
      const titleSkeleton = headerArea!.querySelector('.skeleton.h-6');
      expect(titleSkeleton).toBeTruthy();
      const closeSkeleton = headerArea!.querySelector('.skeleton.h-8');
      expect(closeSkeleton).toBeTruthy();
    });

    it('renders metadata row', () => {
      const { container } = render(<SkeletonModal />);
      const metaBadges = container.querySelectorAll('.flex.items-center.gap-4 .skeleton');
      expect(metaBadges.length).toBeGreaterThanOrEqual(3);
    });

    it('renders two-column layout', () => {
      const { container } = render(<SkeletonModal />);
      const grid = container.querySelector('.grid.grid-cols-7');
      expect(grid).toBeTruthy();
      const leftCol = grid!.querySelector('.col-span-4');
      const rightCol = grid!.querySelector('.col-span-3');
      expect(leftCol).toBeTruthy();
      expect(rightCol).toBeTruthy();
    });

    it('renders activity feed section in right column', () => {
      const { container } = render(<SkeletonModal />);
      const rightCol = container.querySelector('.col-span-3');
      const avatars = rightCol!.querySelectorAll('.rounded-full.skeleton');
      expect(avatars.length).toBe(4);
    });

    it('renders footer with action buttons', () => {
      const { container } = render(<SkeletonModal />);
      const footer = container.querySelector('.flex.items-center.justify-end');
      expect(footer).toBeTruthy();
      const buttons = footer!.querySelectorAll('.skeleton');
      expect(buttons.length).toBe(2);
    });

    it('applies custom className', () => {
      const { container } = render(<SkeletonModal className="extra-modal" />);
      const modal = container.querySelector('[data-testid="skeleton-modal"]');
      expect(modal?.classList.contains('extra-modal')).toBe(true);
    });
  });

  describe('Skeleton CSS animation', () => {
    it('.skeleton class exists in design-system.css', () => {
      expect(cssContent).toContain('.skeleton');
      expect(cssContent).toContain('skeleton-pulse');
    });

    it('.skeleton uses obsidian surface colors', () => {
      const skeletonBlock = cssContent.match(/\.skeleton\s*\{[^}]+\}/);
      expect(skeletonBlock).toBeTruthy();
      expect(skeletonBlock![0]).toContain('var(--surface-container-high)');
    });

    it('skeleton-pulse keyframes exist', () => {
      expect(cssContent).toContain('@keyframes skeleton-pulse');
    });

    it('skeleton-pulse animates opacity', () => {
      const keyframes = cssContent.match(/@keyframes skeleton-pulse\s*\{[^}]+\}/s);
      expect(keyframes).toBeTruthy();
      expect(keyframes![0]).toContain('opacity');
    });

    it('prefers-reduced-motion disables skeleton animation', () => {
      const reducedMotionSection = cssContent.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.skeleton\s*\{[^}]+\}/);
      expect(reducedMotionSection).toBeTruthy();
      expect(reducedMotionSection![0]).toContain('animation: none');
    });
  });

  describe('Skeleton integration — data loading', () => {
    it('renders skeleton column while data loads, then hides', () => {
      const { container, rerender } = render(<LoadingWrapper isLoading={true} />);
      expect(container.querySelector('[data-testid="skeleton-column"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="loaded-content"]')).toBeFalsy();

      rerender(<LoadingWrapper isLoading={false} />);
      expect(container.querySelector('[data-testid="skeleton-column"]')).toBeFalsy();
      expect(container.querySelector('[data-testid="loaded-content"]')).toBeTruthy();
    });

    it('renders skeleton header while data loads', () => {
      const { container, rerender } = render(<HeaderWrapper isLoading={true} />);
      expect(container.querySelector('[data-testid="skeleton-header"]')).toBeTruthy();

      rerender(<HeaderWrapper isLoading={false} />);
      expect(container.querySelector('[data-testid="skeleton-header"]')).toBeFalsy();
      expect(container.querySelector('[data-testid="real-header"]')).toBeTruthy();
    });
  });
});
