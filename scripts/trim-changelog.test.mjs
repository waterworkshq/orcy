// Regression check for the changelog post-processor: the 3-section cap, the
// per-section duplicate-bullet dedupe (merge-commit landings emit the same
// body paragraph once per landing), the empty-body placeholder bullet drop,
// and blank-run collapsing. Run: node --test scripts/ (or pnpm test:scripts).
import assert from "node:assert/strict";
import test from "node:test";

import { transform } from "./trim-changelog.mjs";

function fixture() {
  return [
    '# Changelog',
    '',
    '## 2.0.0 — 2026-01-03',
    '',
    '### Bug Fixes',
    '',
    '#### third heading ([`c3`](https://example.org/c3))',
    '',
    '- fix(c): third',
    '',
    '- Same body paragraph appears here.',
    '',
    '## 1.1.0 — 2026-01-02',
    '',
    '#### second heading ([`c2`](https://example.org/c2))',
    '',
    '- fix(b): second',
    '',
    '- ---------',
    '',
    '- Same body paragraph appears here.',
    '',
    '- Same body paragraph appears here.',
    '',
    '## 1.0.1 — 2026-01-01',
    '',
    '#### first heading ([`c1`](https://example.org/c1))',
    '',
    '- fix(a): first',
    '',
    '## 0.9.0 — 2025-12-31',
    '',
    '- old world',
    '',
  ].join('\n');
}

test('caps at three release sections and regenerates the header', () => {
  const out = transform(fixture());
  assert.match(out, /^# Changelog\n/);
  assert.ok(out.includes('## 2.0.0'));
  assert.ok(out.includes('## 1.0.1'));
  assert.ok(!out.includes('## 0.9.0'));
  assert.ok(!out.includes('old world'));
  assert.ok(out.includes('> Older releases:'));
});

test('duplicate bullets survive once per section but persist across sections', () => {
  const out = transform(fixture());
  const occurrences = out.split('- Same body paragraph appears here.').length - 1;
  assert.equal(occurrences, 2);
  assert.ok(out.includes('- fix(b): second'));
  assert.ok(out.includes('- fix(c): third'));
});

test('drops the empty-body placeholder bullet and collapses blank runs', () => {
  const out = transform(fixture());
  assert.ok(!out.includes('- ---------'));
  assert.ok(!/\n{3,}/.test(out));
});

test('distinct bullets with shared prefixes are all kept', () => {
  const content = [
    '## 1.0.0 — 2026-01-01',
    '',
    '- fix: alpha',
    '',
    '- fix: alpha',
    '',
    '- fix: alpha beta',
    '',
  ].join('\n');
  const out = transform(content);
  assert.equal(out.split('- fix: alpha\n').length - 1, 1);
  assert.ok(out.includes('- fix: alpha beta'));
});
