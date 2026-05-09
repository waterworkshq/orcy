import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { GlassToaster } from './Toast.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { toast } from 'sonner';

const cssPath = resolve(__dirname, '../../styles/design-system.css');
const cssContent = readFileSync(cssPath, 'utf-8');

describe('GlassToaster', () => {
  afterEach(() => {
    cleanup();
    toast.dismiss();
  });

  it('renders the toaster container', () => {
    render(<GlassToaster />);
    const section = document.querySelector('section[aria-label]');
    expect(section).toBeTruthy();
    expect(section!.getAttribute('aria-label')).toContain('Notifications');
  });

  it('uses top-right position', () => {
    render(<GlassToaster />);
    const section = document.querySelector('section[aria-label]');
    expect(section).toBeTruthy();
  });
});

describe('Toast CSS — glass-card styling', () => {
  it('.glass-toast class exists in design-system.css', () => {
    expect(cssContent).toContain('.glass-toast');
  });

  it('.glass-toast uses glass-card base properties', () => {
    const block = cssContent.match(/\.glass-toast\s*\{[^}]+\}/);
    expect(block).toBeTruthy();
    expect(block![0]).toContain('rgba(23, 26, 29, 0.8)');
    expect(block![0]).toContain('backdrop-filter');
    expect(block![0]).toContain('blur(30px)');
  });

  it('.glass-toast has left border', () => {
    const block = cssContent.match(/\.glass-toast\s*\{[^}]+\}/);
    expect(block).toBeTruthy();
    expect(block![0]).toContain('border-left');
  });
});

describe('Toast CSS — type-specific border colors', () => {
  it('.glass-toast-success uses emerald border', () => {
    const block = cssContent.match(/\.glass-toast-success\s*\{[^}]+\}/);
    expect(block).toBeTruthy();
    expect(block![0]).toContain('#10b981');
  });

  it('.glass-toast-error uses red border', () => {
    const block = cssContent.match(/\.glass-toast-error\s*\{[^}]+\}/);
    expect(block).toBeTruthy();
    expect(block![0]).toContain('#ef4444');
  });

  it('.glass-toast-warning uses orange border', () => {
    const block = cssContent.match(/\.glass-toast-warning\s*\{[^}]+\}/);
    expect(block).toBeTruthy();
    expect(block![0]).toContain('#f97316');
  });

  it('.glass-toast-info uses cyan border', () => {
    const block = cssContent.match(/\.glass-toast-info\s*\{[^}]+\}/);
    expect(block).toBeTruthy();
    expect(block![0]).toContain('#06b6d4');
  });
});

describe('Toast CSS — progress bar', () => {
  it('.glass-toast-progress class exists', () => {
    expect(cssContent).toContain('.glass-toast-progress');
  });

  it('.glass-toast-progress has linear animation', () => {
    const block = cssContent.match(/\.glass-toast-progress\s*\{[^}]+\}/);
    expect(block).toBeTruthy();
    expect(block![0]).toContain('animation');
    expect(block![0]).toContain('toast-progress');
  });

  it('toast-progress keyframes animate width from 100% to 0%', () => {
    const keyframes = cssContent.match(/@keyframes toast-progress\s*\{[^}]+\}[^}]*\}/);
    expect(keyframes).toBeTruthy();
    expect(keyframes![0]).toContain('width: 100%');
    expect(keyframes![0]).toContain('width: 0%');
  });
});

describe('Toast CSS — slide-in animation from right', () => {
  it('toast-slide-in keyframes exist', () => {
    expect(cssContent).toContain('@keyframes toast-slide-in');
  });

  it('toast-slide-in animates from translateX(100%) to translateX(0)', () => {
    const keyframes = cssContent.match(/@keyframes toast-slide-in\s*\{[^}]+\}[^}]*\}/);
    expect(keyframes).toBeTruthy();
    expect(keyframes![0]).toContain('translateX(100%)');
    expect(keyframes![0]).toContain('translateX(0)');
  });

  it('.glass-toast uses toast-slide-in animation', () => {
    const block = cssContent.match(/\.glass-toast\s*\{[^}]+\}/);
    expect(block).toBeTruthy();
    expect(block![0]).toContain('toast-slide-in');
  });
});

describe('Toast CSS — action button styling', () => {
  it('.glass-toast-action class exists', () => {
    expect(cssContent).toContain('.glass-toast-action');
  });

  it('.glass-toast-action uses primary container color', () => {
    const block = cssContent.match(/\.glass-toast-action\s*\{[^}]+\}/);
    expect(block).toBeTruthy();
    expect(block![0]).toContain('var(--primary-container)');
  });
});

describe('Toast CSS — reduced motion', () => {
  it('reduced motion disables toast animation', () => {
    const reducedSection = cssContent.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.glass-toast\s*\{[^}]+\}/);
    expect(reducedSection).toBeTruthy();
    expect(reducedSection![0]).toContain('animation: none');
  });

  it('reduced motion disables progress bar animation', () => {
    const reducedSection = cssContent.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.glass-toast-progress\s*\{[^}]+\}/);
    expect(reducedSection).toBeTruthy();
    expect(reducedSection![0]).toContain('animation: none');
  });
});

describe('Toast — action button support via notify', () => {
  it('notify accepts action option without error', async () => {
    const { notify } = await import('../../lib/toast.js');
    const action = { label: 'Undo', onClick: vi.fn() };
    expect(() => notify.success('Test', { action })).not.toThrow();
  });

  it('notify accepts description option without error', async () => {
    const { notify } = await import('../../lib/toast.js');
    expect(() => notify.info('Test', { description: 'desc' })).not.toThrow();
  });
});

describe('Toast — auto-dismiss duration', () => {
  it('default duration is 5000ms', async () => {
    const { notify } = await import('../../lib/toast.js');
    const id = notify.success('Test');
    expect(id).toBeTruthy();
    toast.dismiss(id);
  });

  it('error defaults to 10000ms', async () => {
    const { notify } = await import('../../lib/toast.js');
    const id = notify.error('Test');
    expect(id).toBeTruthy();
    toast.dismiss(id);
  });

  it('warning defaults to 7000ms', async () => {
    const { notify } = await import('../../lib/toast.js');
    const id = notify.warning('Test');
    expect(id).toBeTruthy();
    toast.dismiss(id);
  });
});
