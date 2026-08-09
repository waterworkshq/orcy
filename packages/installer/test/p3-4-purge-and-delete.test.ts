import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import "./helpers/setup.js";
import { orcyHome } from "./helpers/setup.js";
import { uninstallAll } from "../src/lifecycle.js";
import { getContext } from "../src/context.js";
import { record } from "../src/manifest.js";

/** Type-safe accessor for the mocked global fetch (set up in helpers/setup.ts). */
const fetchCalls = (): [unknown, unknown][] =>
  (globalThis.fetch as unknown as { mock: { calls: [unknown, unknown][] } }).mock.calls;

/** Seed a minimal manifest entry so uninstallAll proceeds past the manifest check. */
function seedMinimalManifest(): void {
  const dummy = path.join(orcyHome(), "dummy");
  fs.writeFileSync(dummy, "x");
  record({ path: dummy, action: "created" });
}

/** Seed the three user data files that D1 preserve/purge governs. */
function seedDataFiles(): void {
  fs.writeFileSync(path.join(orcyHome(), ".env"), "ORCY_API_URL=http://127.0.0.1:4000\n");
  fs.writeFileSync(path.join(orcyHome(), "orcy.db"), "fake-db");
  fs.writeFileSync(
    path.join(orcyHome(), "credentials.json"),
    JSON.stringify({ agentId: "agent-test-001", apiKey: "orcy-key-test", agentName: "test-agent" }),
  );
}

describe("P3.4 D1: preserve-prompt + --purge", () => {
  beforeEach(() => {
    seedMinimalManifest();
  });

  it("preserves .env, orcy.db, credentials.json by default (non-interactive)", async () => {
    seedDataFiles();

    await uninstallAll(getContext());

    expect(fs.existsSync(path.join(orcyHome(), ".env")), ".env preserved").toBe(true);
    expect(fs.existsSync(path.join(orcyHome(), "orcy.db")), "orcy.db preserved").toBe(true);
    expect(fs.existsSync(path.join(orcyHome(), "credentials.json")), "credentials.json preserved").toBe(true);
  });

  it("removes .env, orcy.db, credentials.json when purge: true", async () => {
    seedDataFiles();

    await uninstallAll(getContext(), { purge: true });

    expect(fs.existsSync(path.join(orcyHome(), ".env")), ".env removed").toBe(false);
    expect(fs.existsSync(path.join(orcyHome(), "orcy.db")), "orcy.db removed").toBe(false);
    expect(fs.existsSync(path.join(orcyHome(), "credentials.json")), "credentials.json removed").toBe(false);
  });
});

describe("P3.4 G5: consent-gated remote DELETE", () => {
  let savedIsTTY: boolean | undefined;

  beforeEach(() => {
    savedIsTTY = process.stdin.isTTY;
    seedMinimalManifest();
    seedDataFiles();
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: savedIsTTY,
      configurable: true,
      writable: true,
    });
    // Clear fetch mock call history so assertions don't leak across tests.
    (globalThis.fetch as unknown as { mockClear: () => void }).mockClear();
  });

  /** Find a fetch call matching the given HTTP method. */
  const findCall = (method: string): [unknown, unknown] | undefined =>
    fetchCalls().find(([, init]) => {
      const opts = init as { method?: string } | undefined;
      return opts?.method === method;
    });

  it("sends DELETE /api/agents/:id/self with agent API key when interactive", async () => {
    // Simulate an interactive terminal.
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    await uninstallAll(getContext());

    const deleteCall = findCall("DELETE");
    expect(deleteCall, "DELETE /api/agents/:id/self was called").toBeTruthy();

    const [url, init] = deleteCall!;
    expect(url).toBe("http://127.0.0.1:4000/api/agents/agent-test-001/self");
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers["x-agent-api-key"]).toBe("orcy-key-test");
  });

  it("skips DELETE when non-interactive (--yes without --purge)", async () => {
    // process.stdin.isTTY is undefined in vitest → non-interactive.
    await uninstallAll(getContext(), { yes: true });

    expect(findCall("DELETE"), "DELETE must not be sent in non-interactive mode").toBeUndefined();
  });

  it("sends DELETE when purge: true even non-interactively (explicit consent)", async () => {
    await uninstallAll(getContext(), { purge: true, yes: true });

    expect(findCall("DELETE"), "DELETE sent when purge provides explicit consent").toBeTruthy();
  });
});
