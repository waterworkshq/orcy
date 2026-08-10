/**
 * G2.2 — wizard resume/rollback + --recover flag tests.
 *
 * Tests the viability-aware stale-journal recovery paths:
 *   - Non-interactive + --recover + viable → resume (discardJournal, install completes)
 *   - Non-interactive + --recover + not viable → rollback (reverse done steps, discard, install)
 *   - Non-interactive without --recover → throws (P1.4 safe-by-default)
 *   - Interactive select → resume / rollback / abort
 *   - resolveAction dispatches --recover to noninteractive-wizard
 *
 * MOCK BOUNDARY: imports ./helpers/setup.js FIRST (mocks @orcy/shared, child_process,
 * fetch, @clack/prompts including select).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import './helpers/setup.js';
import { orcyHome } from './helpers/setup.js';
import * as clack from '@clack/prompts';
import { wizard } from '../src/wizard.js';
import { journalPath } from '../src/journal.js';
import { resolveAction } from '../src/index.js';

/** Write a stale journal with the given done-steps directly to disk. */
function seedJournal(steps: Array<{ path: string; action: string }>): void {
  const journal = {
    version: 1,
    startedAt: new Date().toISOString(),
    components: ['cli'],
    steps: steps.map((s, i) => ({
      step: i,
      status: 'done',
      ts: new Date().toISOString(),
      path: s.path,
      action: s.action,
    })),
  };
  fs.writeFileSync(journalPath(), JSON.stringify(journal), 'utf-8');
}

const nonInteractive = {
  components: ['cli'] as string[],
  mcpClients: [] as string[],
  patchFiles: [] as string[],
  skillRoots: [] as string[],
  interactive: false,
};

describe('non-interactive --recover', () => {
  it('resume path: viable journal → discard + install completes', async () => {
    // Seed a journal whose done-step path EXISTS on disk → viable.
    const artifact = path.join(orcyHome(), 'existing-artifact.txt');
    fs.writeFileSync(artifact, 'test', 'utf-8');
    seedJournal([{ path: artifact, action: 'created' }]);

    await wizard({ ...nonInteractive, recover: true });

    // Journal discarded (committed install deletes it; stale one was discarded pre-install).
    expect(fs.existsSync(journalPath())).toBe(false);
    // Install completed — manifest exists.
    expect(fs.existsSync(path.join(orcyHome(), 'install-manifest.json'))).toBe(true);
  });

  it('rollback path: not-viable journal → reverse done steps + discard + install', async () => {
    // Two done steps: one whose path EXISTS (will be reversed), one whose path
    // does NOT exist (makes the journal not-viable).
    const existingArtifact = path.join(orcyHome(), 'reversible-artifact.txt');
    const missingArtifact = path.join(orcyHome(), 'missing-artifact.txt');
    fs.writeFileSync(existingArtifact, 'test', 'utf-8');
    // missingArtifact deliberately not created → isJournalViable returns false.
    seedJournal([
      { path: existingArtifact, action: 'created' },
      { path: missingArtifact, action: 'created' },
    ]);

    await wizard({ ...nonInteractive, recover: true });

    // The existing artifact was reversed (deleted by rollbackJournal).
    expect(fs.existsSync(existingArtifact)).toBe(false);
    // Journal discarded, install completed.
    expect(fs.existsSync(journalPath())).toBe(false);
    expect(fs.existsSync(path.join(orcyHome(), 'install-manifest.json'))).toBe(true);
  });
});

describe('non-interactive without --recover (P1.4 safe-by-default)', () => {
  it('stale journal → throws structured error', async () => {
    const artifact = path.join(orcyHome(), 'stale-artifact.txt');
    fs.writeFileSync(artifact, 'test', 'utf-8');
    seedJournal([{ path: artifact, action: 'created' }]);

    await expect(wizard({ ...nonInteractive })).rejects.toThrow(/stale installation journal/);

    // Journal NOT discarded — still on disk for manual resolution.
    expect(fs.existsSync(journalPath())).toBe(true);
  });
});

describe('interactive select menu', () => {
  const interactive = {
    components: ['cli'] as string[],
    mcpClients: [] as string[],
    patchFiles: [] as string[],
    skillRoots: [] as string[],
    interactive: true,
  };

  it('resume: viable journal → select "resume" → discard + install completes', async () => {
    const artifact = path.join(orcyHome(), 'interactive-viable.txt');
    fs.writeFileSync(artifact, 'test', 'utf-8');
    seedJournal([{ path: artifact, action: 'created' }]);

    vi.mocked(clack.select).mockResolvedValueOnce('resume' as never);

    await wizard(interactive);

    expect(fs.existsSync(journalPath())).toBe(false);
    expect(fs.existsSync(path.join(orcyHome(), 'install-manifest.json'))).toBe(true);
  });

  it('rollback: select "rollback" → reverse + discard + install completes', async () => {
    const artifact = path.join(orcyHome(), 'interactive-rollback.txt');
    fs.writeFileSync(artifact, 'test', 'utf-8');
    seedJournal([{ path: artifact, action: 'created' }]);

    vi.mocked(clack.select).mockResolvedValueOnce('rollback' as never);

    await wizard(interactive);

    // Artifact reversed by rollbackJournal.
    expect(fs.existsSync(artifact)).toBe(false);
    expect(fs.existsSync(journalPath())).toBe(false);
    expect(fs.existsSync(path.join(orcyHome(), 'install-manifest.json'))).toBe(true);
  });

  it('abort: select "abort" → returns, journal preserved', async () => {
    const artifact = path.join(orcyHome(), 'interactive-abort.txt');
    fs.writeFileSync(artifact, 'test', 'utf-8');
    seedJournal([{ path: artifact, action: 'created' }]);

    vi.mocked(clack.select).mockResolvedValueOnce('abort' as never);

    await wizard(interactive);

    // Journal NOT discarded — abort preserves everything.
    expect(fs.existsSync(journalPath())).toBe(true);
    // No manifest — install did not run.
    expect(fs.existsSync(path.join(orcyHome(), 'install-manifest.json'))).toBe(false);
  });
});

describe('resolveAction — --recover dispatch', () => {
  it('--recover → recognized noninteractive-wizard with recover:true', () => {
    const action = resolveAction(['--recover']);
    expect(action.kind).toBe('noninteractive-wizard');
    if (action.kind === 'noninteractive-wizard') {
      expect(action.opts['recover']).toBe('true');
    }
  });

  it('--recover combined with --yes → noninteractive with both opts', () => {
    const action = resolveAction(['--yes', '--recover']);
    expect(action.kind).toBe('noninteractive-wizard');
    if (action.kind === 'noninteractive-wizard') {
      expect(action.opts['yes']).toBe('true');
      expect(action.opts['recover']).toBe('true');
    }
  });
});
