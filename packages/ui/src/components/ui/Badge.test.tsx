import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Badge, badgeVariants } from './Badge.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

describe('Badge desaturated palette', () => {
  it('renders priority badges with desaturated glass classes', () => {
    render(<Badge variant="high">High</Badge>);

    expect(screen.getByText('High')).toHaveClass('glass-badge');
    expect(screen.getByText('High')).toHaveClass('glass-badge-high');
  });

  it('renders status badges with slate/ice semantic classes', () => {
    render(<Badge variant="in_progress">Active</Badge>);

    expect(screen.getByText('Active')).toHaveClass('glass-badge-active');
  });

  it('keeps priority indicator classes distinct', () => {
    const high = badgeVariants({ variant: 'high' });
    const medium = badgeVariants({ variant: 'medium' });
    const low = badgeVariants({ variant: 'low' });

    expect(high).toContain('glass-badge-high');
    expect(medium).toContain('glass-badge-medium');
    expect(low).toContain('glass-badge-low');
    expect(new Set([high, medium, low]).size).toBe(3);
  });

  it('does not use saturated Tailwind background classes in badge/status/avatar surfaces', () => {
    const files = [
      'packages/ui/src/components/ui/Badge.tsx',
      'packages/ui/src/components/habitat/MissionCard.tsx',
      'packages/ui/src/components/habitat/TaskCard.tsx',
      'packages/ui/src/components/habitat/Column.tsx',
      'packages/ui/src/components/habitat/HabitatPage.tsx',
      'packages/ui/src/components/layout/TopAppBar.tsx',
    ];
    const saturatedBackground = /bg-(red|orange|cyan|blue|purple|green|yellow|emerald|rose)-(400|500|900|100)\b/;

    for (const file of files) {
      const source = readFileSync(resolve(repoRoot, file), 'utf8');
      expect(source, `${file} contains a saturated badge-context background`).not.toMatch(saturatedBackground);
    }
  });

  it('does not use saturated Tailwind background classes in severity/role badge surfaces', () => {
    const files = [
      'packages/ui/src/components/dashboard/AtRiskTasks.tsx',
      'packages/ui/src/components/habitat/TeamsPage.tsx',
    ];
    const saturatedBackground = /bg-(red|orange|cyan|blue|purple|green|yellow|emerald|rose|gray|amber)-(200|300|400|500|600|700|800|900)\b/;

    for (const file of files) {
      const source = readFileSync(resolve(repoRoot, file), 'utf8');
      expect(source, `${file} contains a saturated badge-context background`).not.toMatch(saturatedBackground);
    }
  });

  it('does not use saturated text colors for status icons in TaskCard', () => {
    const source = readFileSync(resolve(repoRoot, 'packages/ui/src/components/habitat/TaskCard.tsx'), 'utf8');
    const saturatedText = /text-(amber|orange|red|yellow)-(400|500|600)\b/;
    expect(source, 'TaskCard contains a saturated status icon text color').not.toMatch(saturatedText);
  });

  it('does not use saturated green in Button success variant', () => {
    const source = readFileSync(resolve(repoRoot, 'packages/ui/src/components/ui/Button.tsx'), 'utf8');
    expect(source).not.toMatch(/bg-green-(500|600|700)/);
  });

  it('status colors remain distinct from each other', () => {
    const active = badgeVariants({ variant: 'in_progress' });
    const review = badgeVariants({ variant: 'submitted' });
    const done = badgeVariants({ variant: 'done' });
    const blocked = badgeVariants({ variant: 'rejected' });

    expect(active).toContain('glass-badge-active');
    expect(review).toContain('glass-badge-review');
    expect(done).toContain('glass-badge-done');
    expect(blocked).toContain('glass-badge-blocked');
    expect(new Set([active, review, done, blocked]).size).toBe(4);
  });
});
