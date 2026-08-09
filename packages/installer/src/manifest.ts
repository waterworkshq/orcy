import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ORCY_PATHS } from "@orcy/shared";
import { journalExists, recordStep, addJournalComponent } from "./journal.js";

const MANIFEST_PATH = path.join(ORCY_PATHS.home, "install-manifest.json");

export interface ManifestEntry {
  path: string;
  action: "created" | "appended" | "fenced" | "merged-json" | "copied";
  marker?: string;
  keys?: string[];
  backup?: string;
  /**
   * Content hash of the artifact at install time (SHA-256). When present,
   * {@link hashFile} / {@link hashDir} compute the on-disk hash at uninstall
   * time; a mismatch means the user modified the artifact, so it is preserved
   * instead of removed (P3.2 G4/G6 data-loss prevention). Optional so existing
   * manifest entries and callers that don't need the guard are unaffected.
   */
  hash?: string;
}

export interface InstallIntent {
  components: string[];
  mcpClients: string[];
  patchFiles: string[];
  skillRoots: string[];
  apiConfig?: { port: number; host: string; autostart: boolean };
}

export interface Manifest {
  version: number;
  installedAt: string;
  components: string[];
  files: ManifestEntry[];
  intent?: InstallIntent;
}

export function readManifest(): Manifest | null {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export function writeManifest(m: Manifest): void {
  const dir = path.dirname(MANIFEST_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = MANIFEST_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2), { mode: 0o600 });
  // fsync the temp file's data so the atomic rename is durable on power loss
  // (rename alone is not sufficient — the directory entry may persist while
  // the file contents are still in the page cache).
  const fd = fs.openSync(tmp, "r");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, MANIFEST_PATH);
}

export function record(entry: ManifestEntry): void {
  // Journal-aware seam (P1.4): when an in-flight journal exists, redirect to
  // the journal instead of the manifest. The manifest is written ONLY at
  // commitJournal() — the manifest path never holds in-flight state (G1).
  if (journalExists()) {
    recordStep(entry);
    return;
  }
  let m = readManifest();
  if (!m) {
    m = { version: 1, installedAt: new Date().toISOString(), components: [], files: [] };
  }
  // Dedup on {path, action}: a second install/update must not append a
  // duplicate entry for an artifact already recorded. No path appears with
  // two different actions across the current call sites, so this collapses
  // only true duplicates. Skips the write entirely when nothing changed.
  if (!m.files.some((f) => f.path === entry.path && f.action === entry.action)) {
    m.files.push(entry);
    writeManifest(m);
  }
}

export function addComponent(name: string): void {
  if (journalExists()) {
    addJournalComponent(name);
    return;
  }
  let m = readManifest();
  if (!m) {
    m = { version: 1, installedAt: new Date().toISOString(), components: [], files: [] };
  }
  if (!m.components.includes(name)) m.components.push(name);
  writeManifest(m);
}

// --- Hash helpers (P3.2) --------------------------------------------------------
// SHA-256 content hashes for user-modifiable artifacts. Recorded at install time
// in {@link ManifestEntry.hash}; compared at uninstall time to detect user
// modifications and prevent data loss (design §7 G4, G6).

/** SHA-256 of a file's contents. */
export function hashFile(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/**
 * Deterministic SHA-256 for a directory tree. Walks recursively, collects
 * `"<relative-path>:<sha256-of-file-contents>"` for every regular file (sorted
 * lexicographically by relative path), then hashes the newline-joined manifest.
 * This is order-independent and detects any content change. Empty dirs
 * contribute no entries but still hash consistently.
 */
export function hashDir(dir: string): string {
  const entries: string[] = [];
  function walk(d: string, prefix: string): void {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full, rel);
      } else {
        const h = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
        entries.push(`${rel}:${h}`);
      }
    }
  }
  walk(dir, "");
  return crypto.createHash("sha256").update(entries.join("\n")).digest("hex");
}
