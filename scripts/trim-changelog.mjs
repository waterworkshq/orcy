#!/usr/bin/env node

// Post-processes the git-cliff-generated CHANGELOG.md after each release.
// Caps the file at the MAX_ENTRIES most recent release sections and removes
// the mechanical noise cliff emits for merge-commit landings: identical body
// bullets repeated across a merged pair (each landing emits the same
// paragraph twice), and the empty-body placeholder bullet (`- ---------`).
// Squash-only landings stopped new duplicates at the source; this keeps the
// retained sections clean whenever they regenerate. Runs automatically from
// the release `after:bump` hook (immediately after git-cliff), or manually:
//   node scripts/trim-changelog.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const changelogPath = resolve(__dirname, '../CHANGELOG.md');
const MAX_ENTRIES = 3;

const HEADER = [
  '# Changelog',
  '',
  '> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).',
  '',
].join('\n');

const versionPattern = /^## v?\d+\.\d+/;
const PLACEHOLDER_BULLET = '- ---------';

/**
 * Pure transform over changelog text: cap at MAX_ENTRIES release sections,
 * drop repeated identical bullet lines within each release section (first
 * occurrence survives), drop cliff's empty-body placeholder bullets, and
 * collapse blank-line runs the removals leave behind.
 */
export function transform(content) {
  const lines = content.split('\n');

  let versionCount = 0;
  let cutLine = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (versionPattern.test(lines[i])) {
      versionCount++;
      if (versionCount > MAX_ENTRIES) {
        cutLine = i;
        break;
      }
    }
  }

  let bodyLines = lines.slice(0, cutLine);

  const hasHeader = bodyLines.some((l) => l === '# Changelog');
  if (hasHeader) {
    const headerEnd = bodyLines.findIndex((l) => l.startsWith('## '));
    if (headerEnd > 0) {
      bodyLines = bodyLines.slice(headerEnd);
    }
  }

  const cleaned = [];
  let seenInSection = new Set();
  let inSection = false;
  for (const line of bodyLines) {
    if (versionPattern.test(line)) {
      inSection = true;
      seenInSection = new Set();
      cleaned.push(line);
      continue;
    }
    if (line === PLACEHOLDER_BULLET) continue;
    if (inSection && line.startsWith('- ')) {
      const key = line.trim();
      if (seenInSection.has(key)) continue;
      seenInSection.add(key);
    }
    cleaned.push(line);
  }

  const collapsed = [];
  for (const line of cleaned) {
    if (line === '' && collapsed[collapsed.length - 1] === '') continue;
    collapsed.push(line);
  }

  return HEADER + '\n' + collapsed.join('\n').trim() + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(changelogPath, transform(readFileSync(changelogPath, 'utf-8')));
}
