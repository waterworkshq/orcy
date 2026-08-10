import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ORCY_PATHS } from "@orcy/shared";
import { journalExists, recordStep, addJournalComponent } from "./journal.js";
import { atomicWriteJson } from "./atomic-write.js";

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
  atomicWriteJson(MANIFEST_PATH, JSON.stringify(m, null, 2), 0o600);
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
  // duplicate entry for an artifact already recorded. When the entry already
  // exists, UPSERT the optional metadata (hash/keys/backup/marker) from the
  // incoming record — so a re-record after an update REFRESHES the hash instead
  // of being silently dropped (G2H.1: without this, a refreshed skill's stale
  // old hash survives and the artifact later looks "user-modified"). No path
  // appears with two different actions across the current call sites.
  const existing = m.files.find((f) => f.path === entry.path && f.action === entry.action);
  if (existing) {
    if (mergeEntryFields(existing, entry)) writeManifest(m);
  } else {
    m.files.push(entry);
    writeManifest(m);
  }
}

/**
 * Merge defined optional fields from `incoming` into `existing` (both share the
 * same {path, action}). Returns true if `existing` changed. Only overwrites when
 * the incoming field is defined and differs — undefined incoming fields never
 * clobber existing values. Used by {@link record} / journal `recordStep` /
 * `commitJournal` so re-records upsert metadata instead of being dropped.
 */
export function mergeEntryFields(existing: ManifestEntry, incoming: ManifestEntry): boolean {
  let changed = false;
  if (incoming.hash !== undefined && incoming.hash !== existing.hash) {
    existing.hash = incoming.hash;
    changed = true;
  }
  if (
    incoming.keys !== undefined &&
    incoming.keys.join("\0") !== (existing.keys ?? []).join("\0")
  ) {
    existing.keys = [...incoming.keys];
    changed = true;
  }
  if (incoming.backup !== undefined && incoming.backup !== existing.backup) {
    existing.backup = incoming.backup;
    changed = true;
  }
  if (incoming.marker !== undefined && incoming.marker !== existing.marker) {
    existing.marker = incoming.marker;
    changed = true;
  }
  return changed;
}

/** Look up a recorded entry by {path, action} (manifest only; not the journal). */
export function findEntry(
  entryPath: string,
  action: ManifestEntry["action"],
): ManifestEntry | undefined {
  return readManifest()?.files.find((f) => f.path === entryPath && f.action === action);
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
