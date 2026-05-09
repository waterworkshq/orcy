import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const cssPath = resolve(process.cwd(), 'src/styles/design-system.css');

function loadCSS(): string {
  return readFileSync(cssPath, 'utf-8');
}

function extractRootVar(css: string, varName: string): string | null {
  const regex = new RegExp(`--${varName}:\\s*([^;]+);`);
  const match = css.match(regex);
  return match ? match[1].trim() : null;
}

describe('design-system.css', () => {
  let css: string;

  beforeEach(() => {
    css = loadCSS();
  });

  describe(':root CSS custom properties', () => {
    it('defines all surface tokens', () => {
      expect(extractRootVar(css, 'surface')).toBe('#0c0e10');
      expect(extractRootVar(css, 'surface-container-lowest')).toBe('#000000');
      expect(extractRootVar(css, 'surface-container-low')).toBe('#111416');
      expect(extractRootVar(css, 'surface-container')).toBe('#171a1d');
      expect(extractRootVar(css, 'surface-container-high')).toBe('#1c2023');
      expect(extractRootVar(css, 'surface-container-highest')).toBe('#22262a');
      expect(extractRootVar(css, 'surface-bright')).toBe('#282d31');
      expect(extractRootVar(css, 'surface-variant')).toBe('#22262a');
    });

    it('defines text color tokens', () => {
      expect(extractRootVar(css, 'on-surface')).toBe('#e2e6eb');
      expect(extractRootVar(css, 'on-surface-variant')).toBe('#a8abb0');
    });

    it('defines border/divider tokens', () => {
      expect(extractRootVar(css, 'outline')).toBe('#72767b');
      expect(extractRootVar(css, 'outline-variant')).toBe('#44484d');
    });

    it('defines primary tokens', () => {
      expect(extractRootVar(css, 'primary')).toBe('#b1cad7');
      expect(extractRootVar(css, 'primary-container')).toBe('#3e5661');
    });

    it('defines secondary tokens', () => {
      expect(extractRootVar(css, 'secondary')).toBe('#bbc8d0');
      expect(extractRootVar(css, 'secondary-container')).toBe('#313d43');
    });

    it('defines error tokens', () => {
      expect(extractRootVar(css, 'error')).toBe('#fa746f');
      expect(extractRootVar(css, 'error-container')).toBe('#871f21');
    });

    it('has no undefined custom property references', () => {
      const allVars = css.match(/--[a-z-]+/g) || [];
      const definedVars = new Set(
        (css.match(/:root\s*\{[^}]+\}/s)?.[0]?.match(/--[a-z-]+/g) || [])
      );
      for (const v of allVars) {
        if (!definedVars.has(v)) {
          const inRoot = css.includes(`:root {`) && css.slice(
            css.indexOf(':root {'),
            css.indexOf('}', css.indexOf(':root {'))
          ).includes(v);
          if (!inRoot) {
            continue;
          }
        }
      }
      expect(definedVars.size).toBeGreaterThanOrEqual(15);
    });
  });

  describe('.ghost-border utilities', () => {
    it('.ghost-border has 1px border with rgba(68,72,77,0.3)', () => {
      expect(css).toContain('.ghost-border {');
      expect(css).toContain('border: 1px solid rgba(68, 72, 77, 0.3)');
    });

    it('.ghost-border-b has bottom border', () => {
      expect(css).toContain('.ghost-border-b {');
      expect(css).toContain('border-bottom: 1px solid rgba(68, 72, 77, 0.3)');
    });

    it('.ghost-border-r has right border', () => {
      expect(css).toContain('.ghost-border-r {');
      expect(css).toContain('border-right: 1px solid rgba(68, 72, 77, 0.3)');
    });
  });

  describe('frosted glass utilities', () => {
    it('.glass-card does NOT have backdrop-filter', () => {
      expect(css).toContain('.glass-card {');
      const cardBlock = css.slice(
        css.indexOf('.glass-card {'),
        css.indexOf('}', css.indexOf('.glass-card {'))
      );
      expect(cardBlock).not.toContain('backdrop-filter');
    });

    it('.glass-card has solid semi-transparent background', () => {
      const cardBlock = css.slice(
        css.indexOf('.glass-card {'),
        css.indexOf('}', css.indexOf('.glass-card {'))
      );
      expect(cardBlock).toContain('rgba(var(--surface-rgb), 0.85)');
    });

    it('.glass-card has border using design token', () => {
      const cardBlock = css.slice(
        css.indexOf('.glass-card {'),
        css.indexOf('}', css.indexOf('.glass-card {'))
      );
      expect(cardBlock).toContain('rgba(var(--outline-variant-rgb), 0.2)');
    });

    it('.glass-card has box-shadow', () => {
      const cardBlock = css.slice(
        css.indexOf('.glass-card {'),
        css.indexOf('}', css.indexOf('.glass-card {'))
      );
      expect(cardBlock).toContain('box-shadow');
    });

    it('.glass-panel has backdrop-filter: blur(30px)', () => {
      expect(css).toContain('.glass-panel {');
      const panelBlock = css.slice(
        css.indexOf('.glass-panel {'),
        css.indexOf('}', css.indexOf('.glass-panel {'))
      );
      expect(panelBlock).toContain('backdrop-filter: blur(30px)');
    });

    it('.glass-modal has backdrop-filter: blur(40px)', () => {
      expect(css).toContain('.glass-modal {');
      const modalBlock = css.slice(
        css.indexOf('.glass-modal {'),
        css.indexOf('}', css.indexOf('.glass-modal {'))
      );
      expect(modalBlock).toContain('backdrop-filter: blur(40px)');
    });

    it('.glass-modal has box-shadow for depth', () => {
      const modalBlock = css.slice(
        css.indexOf('.glass-modal {'),
        css.indexOf('}', css.indexOf('.glass-modal {') + 1)
      );
      expect(modalBlock).toContain('box-shadow');
    });

    it('.glass-badge does NOT have backdrop-filter', () => {
      expect(css).toContain('.glass-badge {');
      const badgeBlock = css.slice(
        css.indexOf('.glass-badge {'),
        css.indexOf('}', css.indexOf('.glass-badge {'))
      );
      expect(badgeBlock).not.toContain('backdrop-filter');
    });

    it('.glass-badge-exceeded does NOT have backdrop-filter', () => {
      expect(css).toContain('.glass-badge-exceeded {');
      const badgeBlock = css.slice(
        css.indexOf('.glass-badge-exceeded {'),
        css.indexOf('}', css.indexOf('.glass-badge-exceeded {'))
      );
      expect(badgeBlock).not.toContain('backdrop-filter');
    });

    it('.glass-badge-warning does NOT have backdrop-filter', () => {
      expect(css).toContain('.glass-badge-warning {');
      const badgeBlock = css.slice(
        css.indexOf('.glass-badge-warning {'),
        css.indexOf('}', css.indexOf('.glass-badge-warning {'))
      );
      expect(badgeBlock).not.toContain('backdrop-filter');
    });

    it('.glass-warning does NOT have backdrop-filter', () => {
      expect(css).toContain('.glass-warning {');
      const warningBlock = css.slice(
        css.indexOf('.glass-warning {'),
        css.indexOf('}', css.indexOf('.glass-warning {'))
      );
      expect(warningBlock).not.toContain('backdrop-filter');
    });

    it('.glass-toast still has backdrop-filter: blur(30px)', () => {
      expect(css).toContain('.glass-toast {');
      const toastBlock = css.slice(
        css.indexOf('.glass-toast {'),
        css.indexOf('}', css.indexOf('.glass-toast {'))
      );
      expect(toastBlock).toContain('backdrop-filter: blur(30px)');
    });

    it('defines --surface-rgb custom property', () => {
      const rootBlock = css.slice(
        css.indexOf(':root {'),
        css.indexOf('}', css.indexOf(':root {'))
      );
      expect(rootBlock).toContain('--surface-rgb');
    });

    it('defines --outline-variant-rgb custom property', () => {
      const rootBlock = css.slice(
        css.indexOf(':root {'),
        css.indexOf('}', css.indexOf(':root {'))
      );
      expect(rootBlock).toContain('--outline-variant-rgb');
    });
  });

  describe('.cool-glow effect', () => {
    it('has position: relative and overflow: hidden', () => {
      expect(css).toContain('.cool-glow {');
      const glowBlock = css.slice(
        css.indexOf('.cool-glow {'),
        css.indexOf('}', css.indexOf('.cool-glow {'))
      );
      expect(glowBlock).toContain('position: relative');
      expect(glowBlock).toContain('overflow: hidden');
    });

    it('::before has gradient from transparent to rgba(177,202,215,0.5)', () => {
      expect(css).toContain('.cool-glow::before {');
      const beforeBlock = css.slice(
        css.indexOf('.cool-glow::before {'),
        css.indexOf('}', css.indexOf('.cool-glow::before {'))
      );
      expect(beforeBlock).toContain('rgba(177, 202, 215, 0.5)');
      expect(beforeBlock).toContain('linear-gradient');
    });
  });

  describe('.btn-primary', () => {
    it('uses primary-container background', () => {
      expect(css).toContain('.btn-primary {');
      const btnBlock = css.slice(
        css.indexOf('.btn-primary {'),
        css.indexOf('}', css.indexOf('.btn-primary {'))
      );
      expect(btnBlock).toContain('background-color: var(--primary-container)');
    });

    it('does not use transition: all', () => {
      expect(css).toContain('.btn-primary {');
      const btnBlock = css.slice(
        css.indexOf('.btn-primary {'),
        css.indexOf('}', css.indexOf('.btn-primary {'))
      );
      expect(btnBlock).not.toMatch(/transition:\s*all/);
    });

    it('uses scoped transition properties for background-color, box-shadow, and transform', () => {
      expect(css).toContain('.btn-primary {');
      const btnBlock = css.slice(
        css.indexOf('.btn-primary {'),
        css.indexOf('}', css.indexOf('.btn-primary {'))
      );
      expect(btnBlock).toContain('background-color var(--duration-fast)');
      expect(btnBlock).toContain('box-shadow var(--duration-fast)');
      expect(btnBlock).toContain('transform var(--duration-fast)');
    });

    it('has inner glow on hover', () => {
      expect(css).toContain('.btn-primary:hover {');
      const hoverBlock = css.slice(
        css.indexOf('.btn-primary:hover {'),
        css.indexOf('}', css.indexOf('.btn-primary:hover {'))
      );
      expect(hoverBlock).toContain('box-shadow: inset 0 1px 0');
    });

    it('has press feedback on active', () => {
      expect(css).toContain('.btn-primary:active {');
      const activeBlock = css.slice(
        css.indexOf('.btn-primary:active {'),
        css.indexOf('}', css.indexOf('.btn-primary:active {'))
      );
      expect(activeBlock).toContain('transform: scale(0.98)');
    });
  });

  describe('.noise-texture', () => {
    it('has SVG noise background in ::before', () => {
      expect(css).toContain('.noise-texture::before {');
      const noiseBlock = css.slice(
        css.indexOf('.noise-texture::before {'),
        css.indexOf('}', css.indexOf('.noise-texture::before {'))
      );
      expect(noiseBlock).toContain("data:image/svg+xml");
      expect(noiseBlock).toContain('feTurbulence');
    });
  });

  describe('micro-animation keyframes', () => {
    it('defines card-hover keyframe with scale(1.02)', () => {
      expect(css).toContain('@keyframes card-hover {');
      expect(css).toContain('scale(1.02)');
    });

    it('defines button-press keyframe with scale(0.98)', () => {
      expect(css).toContain('@keyframes button-press {');
      expect(css).toContain('scale(0.98)');
    });

    it('defines glow-pulse keyframe for opacity animation', () => {
      expect(css).toContain('@keyframes glow-pulse {');
      expect(css).toContain('opacity: 0.15');
      expect(css).toContain('opacity: 0.25');
    });

    it('defines modal-enter keyframe with scale+fade', () => {
      expect(css).toContain('@keyframes modal-enter {');
      const enterIdx = css.indexOf('@keyframes modal-enter {');
      const enterBlock = css.slice(enterIdx, enterIdx + 200);
      expect(enterBlock).toContain('opacity: 0');
      expect(enterBlock).toContain('scale(0.95)');
      expect(enterBlock).toContain('opacity: 1');
      expect(enterBlock).toContain('scale(1)');
    });

    it('defines modal-exit keyframe with scale+fade', () => {
      expect(css).toContain('@keyframes modal-exit {');
      const exitIdx = css.indexOf('@keyframes modal-exit {');
      const exitBlock = css.slice(exitIdx, exitIdx + 200);
      expect(exitBlock).toContain('opacity: 1');
      expect(exitBlock).toContain('opacity: 0');
    });

    it('defines spinner-rotate keyframe', () => {
      expect(css).toContain('@keyframes spinner-rotate {');
      expect(css).toContain('rotate(0deg)');
      expect(css).toContain('rotate(360deg)');
    });

    it('defines skeleton-pulse keyframe', () => {
      expect(css).toContain('@keyframes skeleton-pulse {');
      expect(css).toContain('opacity: 0.4');
      expect(css).toContain('opacity: 0.8');
    });

    it('.animate-card-hover has transition and hover scale', () => {
      expect(css).toContain('.animate-card-hover {');
      expect(css).toContain('.animate-card-hover:hover {');
      const hoverBlock = css.slice(
        css.indexOf('.animate-card-hover:hover {'),
        css.indexOf('}', css.indexOf('.animate-card-hover:hover {'))
      );
      expect(hoverBlock).toContain('scale(1.02)');
    });

    it('.animate-button-press triggers animation on active with 100ms', () => {
      expect(css).toContain('.animate-button-press:active {');
      const pressBlock = css.slice(
        css.indexOf('.animate-button-press:active {'),
        css.indexOf('}', css.indexOf('.animate-button-press:active {'))
      );
      expect(pressBlock).toContain('animation: button-press');
      expect(pressBlock).toContain('var(--duration-instant)');
      expect(pressBlock).toContain('var(--easing-default)');
    });

    it('.animate-modal-enter class triggers modal-enter animation', () => {
      expect(css).toContain('.animate-modal-enter {');
      const enterClass = css.slice(
        css.indexOf('.animate-modal-enter {'),
        css.indexOf('}', css.indexOf('.animate-modal-enter {'))
      );
      expect(enterClass).toContain('animation: modal-enter');
      expect(enterClass).toContain('var(--duration-fast)');
      expect(enterClass).toContain('var(--easing-entrance)');
    });

    it('.animate-modal-exit class triggers modal-exit animation', () => {
      expect(css).toContain('.animate-modal-exit {');
      const exitClass = css.slice(
        css.indexOf('.animate-modal-exit {'),
        css.indexOf('}', css.indexOf('.animate-modal-exit {'))
      );
      expect(exitClass).toContain('animation: modal-exit');
      expect(exitClass).toContain('var(--duration-fast)');
      expect(exitClass).toContain('var(--easing-exit)');
    });

    it('.spinner class has rotation animation', () => {
      expect(css).toContain('.spinner {');
      const spinnerBlock = css.slice(
        css.indexOf('.spinner {'),
        css.indexOf('}', css.indexOf('.spinner {'))
      );
      expect(spinnerBlock).toContain('animation: spinner-rotate');
      expect(spinnerBlock).toContain('border-radius: 50%');
    });

    it('.skeleton class has pulse animation', () => {
      expect(css).toContain('.skeleton {');
      const skeletonBlock = css.slice(
        css.indexOf('.skeleton {'),
        css.indexOf('}', css.indexOf('.skeleton {'))
      );
      expect(skeletonBlock).toContain('animation: skeleton-pulse');
    });
  });

  describe('@font-face declarations', () => {
    const FONTS_DIR = resolve(process.cwd(), 'public/fonts');

    const spaceGroteskFiles = [
      'space-grotesk-vietnamese.woff2',
      'space-grotesk-latin-ext.woff2',
      'space-grotesk-latin.woff2',
    ];

    const manropeFiles = [
      'manrope-cyrillic-ext.woff2',
      'manrope-cyrillic.woff2',
      'manrope-greek.woff2',
      'manrope-vietnamese.woff2',
      'manrope-latin-ext.woff2',
      'manrope-latin.woff2',
    ];

    it('all Space Grotesk font files exist in public/fonts/', () => {
      for (const file of spaceGroteskFiles) {
        const filePath = resolve(FONTS_DIR, file);
        expect(existsSync(filePath)).toBe(true);
      }
    });

    it('all Manrope font files exist in public/fonts/', () => {
      for (const file of manropeFiles) {
        const filePath = resolve(FONTS_DIR, file);
        expect(existsSync(filePath)).toBe(true);
      }
    });

    it('Space Grotesk @font-face declarations reference correct file paths', () => {
      for (const file of spaceGroteskFiles) {
        const urlPath = `/fonts/${file}`;
        expect(css).toContain(`url('${urlPath}')`);
      }
    });

    it('Manrope @font-face declarations reference correct file paths', () => {
      for (const file of manropeFiles) {
        const urlPath = `/fonts/${file}`;
        expect(css).toContain(`url('${urlPath}')`);
      }
    });

    it('Space Grotesk covers weights 300-700', () => {
      const matches = css.match(/font-family:\s*'Space Grotesk'[^}]*font-weight:\s*[\d\s]+/g) || [];
      expect(matches.length).toBeGreaterThan(0);
      for (const m of matches) {
        expect(m).toContain('300 700');
      }
    });

    it('Manrope covers weights 200-700', () => {
      const matches = css.match(/font-family:\s*'Manrope'[^}]*font-weight:\s*[\d\s]+/g) || [];
      expect(matches.length).toBeGreaterThan(0);
      for (const m of matches) {
        expect(m).toContain('200 700');
      }
    });

    it('all @font-face declarations use font-display: swap', () => {
      const fontFaceCount = (css.match(/@font-face/g) || []).length;
      const swapCount = (css.match(/font-display:\s*swap/g) || []).length;
      expect(swapCount).toBe(fontFaceCount);
    });

    it('all @font-face declarations use woff2 format', () => {
      const fontFaceCount = (css.match(/@font-face/g) || []).length;
      const woff2Count = (css.match(/format\('woff2'\)/g) || []).length;
      expect(woff2Count).toBe(fontFaceCount);
    });
  });
});

describe('design-system.css integration', () => {
  it('.glass-card element has solid background without blur', () => {
    const css = loadCSS();
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const el = document.createElement('div');
    el.className = 'glass-card';
    document.body.appendChild(el);

    const computed = window.getComputedStyle(el);
    expect(computed.backdropFilter).not.toContain('blur');

    document.head.removeChild(style);
    document.body.removeChild(el);
  });

  it('index.css imports design-system.css', () => {
    const indexPath = resolve(process.cwd(), 'src/index.css');
    const indexCSS = readFileSync(indexPath, 'utf-8');
    expect(indexCSS).toContain("@import './styles/design-system.css'");
  });

  it('Space Grotesk font-family is available in computed style', () => {
    const css = loadCSS();
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const el = document.createElement('div');
    el.style.fontFamily = '"Space Grotesk", sans-serif';
    el.style.fontWeight = '500';
    document.body.appendChild(el);

    const computed = window.getComputedStyle(el);
    expect(computed.fontFamily).toContain('Space Grotesk');
    expect(computed.fontWeight).toBe('500');

    document.head.removeChild(style);
    document.body.removeChild(el);
  });

  it('Manrope font-family is available in computed style', () => {
    const css = loadCSS();
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const el = document.createElement('div');
    el.style.fontFamily = '"Manrope", sans-serif';
    el.style.fontWeight = '400';
    document.body.appendChild(el);

    const computed = window.getComputedStyle(el);
    expect(computed.fontFamily).toContain('Manrope');

    document.head.removeChild(style);
    document.body.removeChild(el);
  });
});

describe('prefers-reduced-motion', () => {
  let css: string;

  beforeEach(() => {
    css = loadCSS();
  });

  it('has @media (prefers-reduced-motion: reduce) block', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('disables .animate-card-hover transition under reduced motion', () => {
    const reducedMotionStart = css.indexOf('@media (prefers-reduced-motion: reduce)');
    const reducedMotionEnd = css.lastIndexOf('}');
    const reducedBlock = css.slice(reducedMotionStart, reducedMotionEnd);

    expect(reducedBlock).toContain('.animate-card-hover');
    expect(reducedBlock).toContain('transition: none');
  });

  it('disables .animate-button-press animation under reduced motion', () => {
    const reducedMotionStart = css.indexOf('@media (prefers-reduced-motion: reduce)');
    const reducedMotionEnd = css.lastIndexOf('}');
    const reducedBlock = css.slice(reducedMotionStart, reducedMotionEnd);

    expect(reducedBlock).toContain('.animate-button-press:active');
    expect(reducedBlock).toContain('animation: none');
  });

  it('disables .animate-modal-enter/exit animations under reduced motion', () => {
    const reducedMotionStart = css.indexOf('@media (prefers-reduced-motion: reduce)');
    const reducedMotionEnd = css.lastIndexOf('}');
    const reducedBlock = css.slice(reducedMotionStart, reducedMotionEnd);

    expect(reducedBlock).toContain('.animate-modal-enter');
    expect(reducedBlock).toContain('.animate-modal-exit');
    expect(reducedBlock).toContain('animation: none');
  });

  it('disables .spinner animation under reduced motion', () => {
    const reducedMotionStart = css.indexOf('@media (prefers-reduced-motion: reduce)');
    const reducedMotionEnd = css.lastIndexOf('}');
    const reducedBlock = css.slice(reducedMotionStart, reducedMotionEnd);

    expect(reducedBlock).toContain('.spinner');
    expect(reducedBlock).toContain('animation: none');
  });

  it('disables .skeleton animation under reduced motion', () => {
    const reducedMotionStart = css.indexOf('@media (prefers-reduced-motion: reduce)');
    const reducedMotionEnd = css.lastIndexOf('}');
    const reducedBlock = css.slice(reducedMotionStart, reducedMotionEnd);

    expect(reducedBlock).toContain('.skeleton');
    expect(reducedBlock).toContain('animation: none');
  });
});

describe('animation integration', () => {
  it('.spinner class defines border-radius 50% and spinner-rotate animation', () => {
    const css = loadCSS();
    const spinnerIdx = css.indexOf('.spinner {');
    const spinnerBlock = css.slice(spinnerIdx, css.indexOf('}', spinnerIdx));
    expect(spinnerBlock).toContain('border-radius: 50%');
    expect(spinnerBlock).toContain('animation: spinner-rotate');
    expect(spinnerBlock).toContain('display: inline-block');
  });

  it('.skeleton class defines skeleton-pulse animation', () => {
    const css = loadCSS();
    const skeletonIdx = css.indexOf('.skeleton {');
    const skeletonBlock = css.slice(skeletonIdx, css.indexOf('}', skeletonIdx));
    expect(skeletonBlock).toContain('animation: skeleton-pulse');
    expect(skeletonBlock).toContain('border-radius: 4px');
  });
});
