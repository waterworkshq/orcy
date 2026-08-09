/**
 * verify.ts consistency auditor — test suite.
 *
 * MOCK BOUNDARY: imports `./helpers/setup.js` FIRST (mocks `@orcy/shared`
 * ORCY_PATHS, `node:child_process`, `fetch`). The real `node:fs` operates on
 * the temp ORCY_HOME. Each test seeds a manifest + on-disk state, then calls
 * `verify()` and asserts findings. The non-mutation test snapshots orcyHome
 * before/after a verify run to enforce read-only behavior.
 *
 * Footprint decision: footprint findings ARE included in `findings` and DO make
 * `ok` false. They represent disposable build-artifact state worth addressing.
 * A freshly wizard-installed machine has src/cache/node_modules present →
 * ok:false is the expected post-install state. Note that node_modules is both a
 * footprint dir AND holds manifest-recorded entries (@orcy/* packages) — sweeping
 * it would create `missing` findings. For the clean ok:true test, we therefore
 * use a manifest-only fixture with no footprint dirs, avoiding this tension.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import './helpers/setup.js';
import { orcyHome, manifestPath } from './helpers/setup.js';
import { getContext } from '../src/context.js';
import { verify } from '../src/verify.js';
import type { Manifest } from '../src/manifest.js';

// --- Test helpers -------------------------------------------------------------

/** Write a minimal valid manifest with the given file entries. */
function seedManifest(files: { path: string; action: string }[]): void {
  const manifest: Manifest = {
    version: 1,
    installedAt: new Date().toISOString(),
    components: ['cli', 'api'],
    files: files as Manifest['files'],
  };
  fs.writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2));
}

/** Create a file on disk (with parent dirs). */
function touch(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'content\n');
}

/** Recursively walk a directory and return sorted relative file paths. */
function walkDir(dir: string): string[] {
  const result: string[] = [];
  function walk(d: string, prefix: string): void {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full, rel);
      } else {
        result.push(rel);
      }
    }
  }
  walk(dir, '');
  return result;
}

// --- Tests --------------------------------------------------------------------

describe('verify — consistency auditor', () => {
  it('(a) clean: manifest-only fixture, all paths exist → ok:true, no findings', () => {
    // A manifest-only clean state (no footprint dirs, no journal). This is the
    // clearest ok:true fixture: a wizard install creates src/cache/node_modules
    // which make ok:false (footprint findings). node_modules also holds
    // manifest-recorded @orcy/* entries, so sweeping it would create `missing`
    // findings — we avoid that tension by seeding a minimal fixture here.
    const f1 = path.join(orcyHome(), 'bin', 'orcy');
    const f2 = path.join(orcyHome(), 'bin', 'orcy-api');
    touch(f1);
    touch(f2);
    seedManifest([
      { path: f1, action: 'created' },
      { path: f2, action: 'created' },
    ]);

    const result = verify(getContext());
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('(b) missing: deleted recorded file → reports missing', () => {
    const f1 = path.join(orcyHome(), 'bin', 'orcy');
    const f2 = path.join(orcyHome(), 'bin', 'orcy-api');
    touch(f1);
    touch(f2);
    seedManifest([
      { path: f1, action: 'created' },
      { path: f2, action: 'created' },
    ]);

    // Delete the first file to simulate drift.
    fs.unlinkSync(f1);

    const result = verify(getContext());
    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual({
      kind: 'missing',
      path: f1,
      action: 'created',
    });
  });

  it('(c) duplicate: hand-edited manifest with dup entry → reports duplicate', () => {
    const f1 = path.join(orcyHome(), 'bin', 'orcy');
    touch(f1);
    // Inject a duplicate {path, action} pair.
    seedManifest([
      { path: f1, action: 'created' },
      { path: f1, action: 'created' },
    ]);

    const result = verify(getContext());
    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual({
      kind: 'duplicate',
      path: f1,
      action: 'created',
      count: 2,
    });
  });

  it('(d) footprint: src/ dir exists → reports footprint', () => {
    const f1 = path.join(orcyHome(), 'bin', 'orcy');
    touch(f1);
    seedManifest([{ path: f1, action: 'created' }]);

    // Create the src/ footprint dir.
    fs.mkdirSync(path.join(orcyHome(), 'src'), { recursive: true });

    const result = verify(getContext());
    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual({
      kind: 'footprint',
      path: 'src',
    });
  });

  it('(e) stale-journal: journal file exists → reports stale-journal', () => {
    const f1 = path.join(orcyHome(), 'bin', 'orcy');
    touch(f1);
    seedManifest([{ path: f1, action: 'created' }]);

    // Write a fake journal file.
    fs.writeFileSync(
      path.join(orcyHome(), 'install-journal.json'),
      JSON.stringify({ version: 1, startedAt: '2024-01-01T00:00:00Z', components: [], steps: [] }),
    );

    const result = verify(getContext());
    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual({ kind: 'stale-journal' });
  });

  it('(f) no manifest → ok:true, no findings', () => {
    // beforeEach already wiped orcyHome — no manifest exists.
    const result = verify(getContext());
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('non-mutation: verify does not change filesystem state', () => {
    // Seed a drift-laden fixture: missing file, duplicate, footprint, stale journal.
    const f1 = path.join(orcyHome(), 'bin', 'orcy');
    touch(f1);
    touch(path.join(orcyHome(), 'bin', 'orcy-api'));
    seedManifest([
      { path: f1, action: 'created' },
      { path: f1, action: 'created' }, // duplicate
      { path: path.join(orcyHome(), 'bin', 'orcy-mcp'), action: 'created' }, // missing (never created)
    ]);
    fs.mkdirSync(path.join(orcyHome(), 'src'), { recursive: true }); // footprint
    fs.mkdirSync(path.join(orcyHome(), 'cache'), { recursive: true }); // footprint
    fs.writeFileSync(
      path.join(orcyHome(), 'install-journal.json'),
      '{"version":1}',
    ); // stale journal

    // Snapshot orcyHome contents before verify.
    const before = walkDir(orcyHome());

    const result = verify(getContext());
    expect(result.ok).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);

    // Snapshot orcyHome contents after verify — must be identical.
    const after = walkDir(orcyHome());
    expect(after).toEqual(before);
  });
});
