import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(__dirname, '../tailwind.config.js');

function loadConfig() {
  const raw = readFileSync(configPath, 'utf-8');
  const fn = new Function(raw.replace('export default', 'return'));
  return fn();
}

describe('tailwind.config.js', () => {
  it('parses without syntax error', () => {
    const config = loadConfig();
    expect(config).toBeDefined();
    expect(config.darkMode).toBe('class');
    expect(config.content).toEqual(['./src/**/*.{js,ts,jsx,tsx,html}']);
    expect(config.safelist).toEqual(['font-headline', 'font-body', 'font-label']);
  });

  it('defines all obsidian glass color tokens', () => {
    const config = loadConfig();
    const colors = config.theme.extend.colors;

    expect(colors.surface.DEFAULT).toBe('var(--surface)');
    expect(colors.surface.container.lowest).toBe('var(--surface-container-lowest)');
    expect(colors.surface.container.low).toBe('var(--surface-container-low)');
    expect(colors.surface.container.DEFAULT).toBe('var(--surface-container)');
    expect(colors.surface.container.high).toBe('var(--surface-container-high)');
    expect(colors.surface.container.highest).toBe('var(--surface-container-highest)');
    expect(colors.surface.bright).toBe('var(--surface-bright)');
    expect(colors.surface.variant).toBe('var(--surface-variant)');

    expect(colors['on-surface'].DEFAULT).toBe('var(--on-surface)');
    expect(colors['on-surface'].variant).toBe('var(--on-surface-variant)');

    expect(colors.outline.DEFAULT).toBe('var(--outline)');
    expect(colors.outline.variant).toBe('var(--outline-variant)');

    expect(colors.primary.DEFAULT).toBe('var(--primary)');
    expect(colors.primary.container).toBe('var(--primary-container)');

    expect(colors.secondary.DEFAULT).toBe('var(--secondary)');
    expect(colors.secondary.container).toBe('var(--secondary-container)');

    expect(colors.error.DEFAULT).toBe('var(--error)');
    expect(colors.error.container).toBe('var(--error-container)');
  });

  it('includes Space Grotesk and Manrope in fontFamily', () => {
    const config = loadConfig();
    const fontFamily = config.theme.extend.fontFamily;

    expect(fontFamily.grotesk).toBeDefined();
    expect(fontFamily.grotesk[0]).toBe('"Space Grotesk"');
    expect(fontFamily.manrope).toBeDefined();
    expect(fontFamily.manrope[0]).toBe('"Manrope"');
    expect(fontFamily.headline).toEqual(['"Space Grotesk"', 'system-ui', 'sans-serif']);
    expect(fontFamily.display).toEqual(['"Space Grotesk"', 'system-ui', 'sans-serif']);
    expect(fontFamily.body).toEqual(['"Manrope"', 'system-ui', 'sans-serif']);
    expect(fontFamily.label).toEqual(['"Manrope"', 'system-ui', 'sans-serif']);
  });

  it('defines borderRadius with sm/md/lg pixel values', () => {
    const config = loadConfig();
    const borderRadius = config.theme.extend.borderRadius;

    expect(borderRadius.sm).toBe('2px');
    expect(borderRadius.md).toBe('6px');
    expect(borderRadius.lg).toBe('8px');
  });
});
