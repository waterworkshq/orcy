import fs from 'node:fs';
import path from 'node:path';
import { ORCY_PATHS } from '@orcy/shared';

const MANIFEST_PATH = path.join(ORCY_PATHS.home, 'install-manifest.json');

export interface ManifestEntry {
  path: string;
  action: 'created' | 'appended' | 'fenced' | 'merged-json' | 'copied';
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
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeManifest(m: Manifest): void {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2), { mode: 0o600 });
}

export function record(entry: ManifestEntry): void {
  let m = readManifest();
  if (!m) {
    m = { version: 1, installedAt: new Date().toISOString(), components: [], files: [] };
  }
  m.files.push(entry);
  writeManifest(m);
}

export function addComponent(name: string): void {
  let m = readManifest();
  if (!m) {
    m = { version: 1, installedAt: new Date().toISOString(), components: [], files: [] };
  }
  if (!m.components.includes(name)) m.components.push(name);
  writeManifest(m);
}
