import fs from "node:fs";
import path from "node:path";
import { readManifest } from "./manifest.js";
import { journalExists } from "./journal.js";
import type { InstallContext } from "./context.js";

/**
 * A single consistency finding discovered by {@link verify}.
 *
 * The `kind` discriminator keeps the shape extensible — future phases may add
 * categories (e.g. `hash-mismatch` reusing `hashFile`/`hashDir` from manifest.ts).
 */
export interface VerifyFinding {
  kind: "missing" | "duplicate" | "stale-journal";
  /** Filesystem path for missing/duplicate findings. */
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

/** Disposable build-artifact dirs (G4, lifecycle.ts sweep list). Reported
 *  informationally — their presence is NORMAL after a healthy install
 *  (node_modules holds the @orcy/* packages), so they are NOT drift (T4.4). */
const FOOTPRINT_DIRS = ["src", "cache", "node_modules"];

/**
 * Read-only installation consistency auditor (design §7 G10).
 *
 * Cross-references the install manifest against disk state and reports DRIFT:
 * missing recorded paths, duplicate entries, and a stale journal. Footprint dirs
 * (src/cache/node_modules) are reported as informational NOTES, not drift — their
 * presence is expected on a healthy install. **Does NOT mutate the filesystem.**
 *
 * `ok` is `true` only when there are no drift findings. A machine with no
 * manifest AND no stale journal is consistent (ok:true). A stale journal alone
 * (e.g. an interrupted FIRST install, which has no manifest) IS drift (T4.6).
 */
export function verify(ctx: InstallContext): VerifyResult {
  const findings: VerifyFinding[] = [];

  // T4.6: a stale journal is drift whether or not a manifest exists — check it
  // first so an interrupted FIRST install (journal present, no manifest) reports.
  if (journalExists()) {
    findings.push({ kind: "stale-journal" });
  }

  const manifest = readManifest();
  if (!manifest) {
    if (findings.length === 0) {
      console.log("verify: no install manifest found (nothing to verify)");
    }
    printReport(findings, []);
    return { ok: findings.length === 0, findings };
  }

  // 1. Missing recorded paths — a manifest entry whose path no longer exists.
  for (const entry of manifest.files) {
    if (!fs.existsSync(entry.path)) {
      findings.push({ kind: "missing", path: entry.path, action: entry.action });
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
      findings.push({ kind: "duplicate", path: g.path, action: g.action, count: g.count });
    }
  }

  // 3. Footprint dirs — informational only (NOT a finding; see FOOTPRINT_DIRS).
  const footprint: string[] = [];
  for (const dir of FOOTPRINT_DIRS) {
    if (fs.existsSync(path.join(ctx.orcyHome, dir))) footprint.push(dir);
  }

  printReport(findings, footprint);

  return { ok: findings.length === 0, findings };
}

// --- Report -------------------------------------------------------------------

function printReport(findings: VerifyFinding[], footprint: string[]): void {
  // Footprint is a note, not drift.
  if (footprint.length) {
    console.log(`\n  Footprint present (informational, not drift): ${footprint.join(", ")}`);
  }

  if (findings.length === 0) {
    console.log("verify: 0 findings [ok]");
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

  const labels: Record<VerifyFinding["kind"], string> = {
    missing: "Missing recorded paths",
    duplicate: "Duplicate entries",
    "stale-journal": "Stale install journal",
  };

  for (const [kind, items] of byKind) {
    console.log(`\n  ${labels[kind as VerifyFinding["kind"]] ?? kind}:`);
    for (const f of items) {
      switch (f.kind) {
        case "missing":
          console.log(`    ${f.path} (${f.action})`);
          break;
        case "duplicate":
          console.log(`    ${f.path} (${f.action}) ×${f.count}`);
          break;
        case "stale-journal":
          console.log("    install-journal.json");
          break;
      }
    }
  }

  console.log(`\nverify: ${findings.length} finding(s) [drift]`);
}
