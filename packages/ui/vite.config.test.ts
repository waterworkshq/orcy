import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(__dirname, 'vite.config.ts');

function extractGroupTests(): { name: string; test: string; priority: number }[] {
  const raw = readFileSync(configPath, 'utf-8');
  const startIdx = raw.indexOf('codeSplitting:');
  if (startIdx === -1) throw new Error('codeSplitting not found');
  const content = raw.slice(startIdx);
  const groups: { name: string; test: string; priority: number }[] = [];
  const groupRegex = /\{\s*name:\s*['"]([^'"]+)['"](?:[\s\S]*?test:\s*([^,\n]+))?(?:[\s\S]*?priority:\s*(\d+))?/g;
  let match;
  while ((match = groupRegex.exec(content)) !== null) {
    groups.push({
      name: match[1],
      test: match[2]?.trim(),
      priority: match[3] ? parseInt(match[3]) : 0,
    });
  }
  return groups;
}

function testModule(groupName: string, modulePath: string): boolean {
  const groups = extractGroupTests();
  const group = groups.find(g => g.name === groupName);
  if (!group || !group.test) return false;
  const regex = new Function(`return ${group.test}`)();
  return regex.test(modulePath);
}

describe('vite.config.ts codeSplitting groups', () => {
  const groups = extractGroupTests();

  it('has all expected vendor groups', () => {
    const names = groups.map(g => g.name);
    expect(names).toContain('vendor-react');
    expect(names).toContain('vendor-icons');
    expect(names).toContain('vendor-editor');
    expect(names).toContain('vendor-flow');
    expect(names).toContain('vendor-dnd');
    expect(names).toContain('vendor-charts');
    expect(names).toContain('vendor-router');
    expect(names).toContain('vendor-dagre');
    expect(names).toContain('vendor-markdown');
    expect(names).toContain('vendor');
  });

  describe('group priorities', () => {
    it('specialized groups have priority >= generic vendor', () => {
      const vendorPriority = groups.find(g => g.name === 'vendor')?.priority ?? 0;
      const specialized = groups.filter(g => g.name.startsWith('vendor-'));
      for (const g of specialized) {
        expect(g.priority).toBeGreaterThanOrEqual(vendorPriority);
      }
    });
  });

  describe('vendor-react chunk', () => {
    it('routes react, react-dom, scheduler, zustand to vendor-react', () => {
      expect(testModule('vendor-react', '/app/node_modules/react/index.js')).toBe(true);
      expect(testModule('vendor-react', '/app/node_modules/react-dom/index.js')).toBe(true);
      expect(testModule('vendor-react', '/app/node_modules/scheduler/index.js')).toBe(true);
      expect(testModule('vendor-react', '/app/node_modules/zustand/esm/index.js')).toBe(true);
    });

    it('does not route lucide-react or react-router to vendor-react', () => {
      expect(testModule('vendor-react', '/app/node_modules/lucide-react/dist/esm/icons/index.js')).toBe(false);
      expect(testModule('vendor-react', '/app/node_modules/react-router-dom/index.js')).toBe(false);
    });
  });

  describe('vendor-icons chunk', () => {
    it('routes lucide-react to vendor-icons', () => {
      expect(testModule('vendor-icons', '/app/node_modules/lucide-react/dist/esm/icons/check.js')).toBe(true);
      expect(testModule('vendor-icons', '/app/node_modules/lucide-react/dist/esm/lucide-react.js')).toBe(true);
    });
  });

  describe('vendor-editor chunk', () => {
    it('routes @tiptap, prosemirror, lowlight to vendor-editor', () => {
      expect(testModule('vendor-editor', '/app/node_modules/@tiptap/core/index.js')).toBe(true);
      expect(testModule('vendor-editor', '/app/node_modules/prosemirror-model/index.js')).toBe(true);
      expect(testModule('vendor-editor', '/app/node_modules/lowlight/index.js')).toBe(true);
    });
  });

  describe('vendor-flow chunk', () => {
    it('routes @xyflow to vendor-flow', () => {
      expect(testModule('vendor-flow', '/app/node_modules/@xyflow/react/index.js')).toBe(true);
    });
  });

  describe('vendor-dnd chunk', () => {
    it('routes @dnd-kit to vendor-dnd', () => {
      expect(testModule('vendor-dnd', '/app/node_modules/@dnd-kit/core/index.js')).toBe(true);
    });
  });

  describe('vendor-charts chunk', () => {
    it('routes recharts and d3- to vendor-charts', () => {
      expect(testModule('vendor-charts', '/app/node_modules/recharts/es6/index.js')).toBe(true);
      expect(testModule('vendor-charts', '/app/node_modules/d3-scale/index.js')).toBe(true);
    });
  });

  describe('vendor-router chunk', () => {
    it('routes react-router and @remix-run to vendor-router', () => {
      expect(testModule('vendor-router', '/app/node_modules/react-router-dom/index.js')).toBe(true);
      expect(testModule('vendor-router', '/app/node_modules/react-router/index.js')).toBe(true);
      expect(testModule('vendor-router', '/app/node_modules/@remix-run/router/index.js')).toBe(true);
    });
  });

  describe('vendor-dagre chunk', () => {
    it('routes dagre and graphlib to vendor-dagre', () => {
      expect(testModule('vendor-dagre', '/app/node_modules/dagre/index.js')).toBe(true);
      expect(testModule('vendor-dagre', '/app/node_modules/graphlib/index.js')).toBe(true);
    });
  });

  describe('vendor-markdown chunk', () => {
    it('routes react-markdown and remark ecosystem to vendor-markdown', () => {
      expect(testModule('vendor-markdown', '/app/node_modules/react-markdown/index.js')).toBe(true);
      expect(testModule('vendor-markdown', '/app/node_modules/remark-gfm/index.js')).toBe(true);
    });
  });

  describe('generic vendor chunk', () => {
    it('routes other node_modules to vendor', () => {
      expect(testModule('vendor', '/app/node_modules/some-lib/index.js')).toBe(true);
    });
  });
});
