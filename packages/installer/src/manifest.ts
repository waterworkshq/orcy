import fs from "node:fs";
import path from "node:path";
import { ORCY_PATHS } from "@orcy/shared";

const MANIFEST_PATH = path.join(ORCY_PATHS.home, "install-manifest.json");

export interface ManifestEntry {
  path: string;
  action: "created" | "appended" | "fenced" | "merged-json" | "copied";
  marker?: string;
  keys?: string[];
  backup?: string;
}

export interface Manifest {
  version: number;
  installedAt: string;
  components: string[];
  files: ManifestEntry[];
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
  let m = readManifest();
  if (!m) {
    m = { version: 1, installedAt: new Date().toISOString(), components: [], files: [] };
  }
  if (!m.components.includes(name)) m.components.push(name);
  writeManifest(m);
}
