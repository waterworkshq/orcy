import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { StoredCredentials } from "./types.js";

const CREDENTIALS_FILE = "credentials.json";

export class Store {
  private dir: string;

  constructor(dataDir: string) {
    this.dir = dataDir;
  }

  init(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
      try {
        chmodSync(this.dir, 0o700);
      } catch {}
    }
  }

  saveCredentials(creds: StoredCredentials): void {
    this.init();
    const path = this.credPath();
    writeFileSync(path, JSON.stringify(creds, null, 2), "utf-8");
    try {
      chmodSync(path, 0o600);
    } catch {}
  }

  loadCredentials(): StoredCredentials | null {
    const path = this.credPath();
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as StoredCredentials;
    } catch {
      return null;
    }
  }

  clearCredentials(): void {
    const path = this.credPath();
    if (existsSync(path)) writeFileSync(path, "", "utf-8");
  }

  private credPath(): string {
    return join(this.dir, CREDENTIALS_FILE);
  }
}

export { CREDENTIALS_FILE };
