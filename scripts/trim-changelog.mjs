#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const changelogPath = resolve(__dirname, '../CHANGELOG.md');
const MAX_ENTRIES = 3;

const content = readFileSync(changelogPath, 'utf-8');
const lines = content.split('\n');

const HEADER = [
  '# Changelog',
  '',
  '> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).',
  '',
].join('\n');

let versionCount = 0;
let cutLine = lines.length;
const versionPattern = /^## v?\d+\.\d+/;

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

const hasHeader = bodyLines.some(l => l === '# Changelog');
if (hasHeader) {
  const headerEnd = bodyLines.findIndex(l => l.startsWith('## '));
  if (headerEnd > 0) {
    bodyLines = bodyLines.slice(headerEnd);
  }
}

const result = HEADER + '\n' + bodyLines.join('\n').trim() + '\n';
writeFileSync(changelogPath, result);
