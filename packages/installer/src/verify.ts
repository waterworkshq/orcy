import fs from 'node:fs';
import path from 'node:path';
import { readManifest } from './manifest.js';
import { journalExists } from './journal.js';
import type { InstallContext } from './context.js';

/**
 * A single consistency finding discovered by {@link verify}.
 *
 * The `kind` discriminator keeps the shape extensible — future phases may add
 * categories (e.g. `hash-mismatch` reusing `hashFile`/`hashDir` from manifest.ts).
 */
export interface VerifyFinding {
  kind: 'missing' | 'duplicate' | 'footprint' | 'stale-journal';
  /** Filesystem path for missing/duplicate/footprint findings. */
  path?: string;
  /** Manifest action for missing/duplicate findings. */
  action?: string;
  /** Occurrence count for duplicate findings. */
  count?: number;
}

export interface VerifyResult {
  ok: boolean;
  findings: VerifyFinding[];
}

/** Disposable build-artifact dirs (G4, lifecycle.ts sweep list). */
const FOOTPRINT_DIRS = ['src', 'cache', 'node_modules'];

/**
 * Read-only installation consistency auditor (design §7 G10).
 *
 * Cross-references the install manifest against disk state and reports drift:
 * missing recorded paths, duplicate entries, orphaned footprint dirs, and stale
 * journals. **Does NOT mutate the filesystem** — report-only, no `--fix`.
 *
 * A machine with no manifest is consistent (not errored): returns `ok:true` with
 * no findings. Otherwise `ok` is `true` only when `findings` is empty — footprint
 * dirs count as findings because they represent disposable state worth addressing.
 */
export function verify(ctx: InstallContext): VerifyResult {
  const manifest = readManifest();

  // No install → nothing to verify; consistent by definition.
  if (!manifest) {
    console.log('verify: no install manifest found (nothing to verify)');
    return { ok: true, findings: [] };
  }

  const findings: VerifyFinding[] = [];

  // 1. Missing recorded paths — a manifest entry whose path no longer exists.
  for (const entry of manifest.files) {
    if (!fs.existsSync(entry.path)) {
      findings.push({ kind: 'missing', path: entry.path, action: entry.action });
    }
  }

  // 2. Duplicate entries — same {path, action} appearing more than once.
  //    P1.1 dedup prevents new ones, but hand-edited or pre-P1.1 manifests may
  //    still carry them.
  const groups = new Map<string, { path: string; action: string; count: number }>();
  for (const entry of manifest.files) {
    const key = `${entry.path}\0${entry.action}`;
    const g = groups.get(key);
    if (g) {
      g.count++;
    } else {
      groups.set(key, { path: entry.path, action: entry.action, count: 1 });
    }
  }
  for (const g of groups.values()) {
    if (g.count > 1) {
      findings.push({ kind: 'duplicate', path: g.path, action: g.action, count: g.count });
    }
  }

  // 3. Orphaned footprint — disposable build-artifact dirs that can be swept.
  for (const dir of FOOTPRINT_DIRS) {
    if (fs.existsSync(path.join(ctx.orcyHome, dir))) {
      findings.push({ kind: 'footprint', path: dir });
    }
  }

  // 4. Stale journal — an interrupted install (journal should be gone after commit).
  if (journalExists()) {
    findings.push({ kind: 'stale-journal' });
  }

  printReport(findings);

  return { ok: findings.length === 0, findings };
}

// --- Report -------------------------------------------------------------------

function printReport(findings: VerifyFinding[]): void {
  if (findings.length === 0) {
    console.log('verify: 0 findings [ok]');
    return;
  }

  const byKind = new Map<string, VerifyFinding[]>();
  for (const f of findings) {
    const arr = byKind.get(f.kind);
    if (arr) {
      arr.push(f);
    } else {
      byKind.set(f.kind, [f]);
    }
  }

  const labels: Record<VerifyFinding['kind'], string> = {
    missing: 'Missing recorded paths',
    duplicate: 'Duplicate entries',
    footprint: 'Orphaned footprint dirs',
    'stale-journal': 'Stale install journal',
  };

  for (const [kind, items] of byKind) {
    console.log(`\n  ${labels[kind as VerifyFinding['kind']] ?? kind}:`);
    for (const f of items) {
      switch (f.kind) {
        case 'missing':
          console.log(`    ${f.path} (${f.action})`);
          break;
        case 'duplicate':
          console.log(`    ${f.path} (${f.action}) ×${f.count}`);
          break;
        case 'footprint':
          console.log(`    ${f.path}/`);
          break;
        case 'stale-journal':
          console.log('    install-journal.json');
          break;
      }
    }
  }

  console.log(`\nverify: ${findings.length} finding(s) [drift]`);
}
