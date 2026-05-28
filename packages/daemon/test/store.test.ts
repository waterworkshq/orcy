import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import type { StoredCredentials } from "../src/types.js";

describe("Store", () => {
  let testDir: string;
  let store: Store;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "orcy-daemon-test-"));
    store = new Store(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const sampleCreds: StoredCredentials = {
    daemonId: "d1",
    daemonToken: "daemon-secret-token",
    apiUrl: "http://localhost:3000",
    agents: [{ id: "a1", name: "daemon-ws-claude", type: "claude-code", apiKey: "agent-key-123" }],
    registeredAt: "2026-05-28T00:00:00Z",
  };

  it("saves and loads credentials", () => {
    store.saveCredentials(sampleCreds);
    const loaded = store.loadCredentials();
    expect(loaded).toEqual(sampleCreds);
  });

  it("creates data directory on save", () => {
    const nestedDir = join(testDir, "nested", "dir");
    const nestedStore = new Store(nestedDir);
    nestedStore.saveCredentials(sampleCreds);
    expect(existsSync(nestedDir)).toBe(true);
  });

  it("returns null when no credentials file exists", () => {
    expect(store.loadCredentials()).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    store.init();
    writeFileSync(join(testDir, "credentials.json"), "not json{");
    expect(store.loadCredentials()).toBeNull();
  });

  it("clears credentials", () => {
    store.saveCredentials(sampleCreds);
    store.clearCredentials();
    const loaded = store.loadCredentials();
    expect(loaded).toBeNull();
  });
});
