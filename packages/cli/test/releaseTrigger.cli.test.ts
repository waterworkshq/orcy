import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

/**
 * AC-DETECT-9 — `orcy triage release-trigger` CLI command parses args and
 * POSTs the expected payload to `/api/triage/release-trigger`.
 *
 * The CLI command module imports the `api` HTTP client at module-load time
 * (`client.ts` reads `getOrcyConfig()` at import). To intercept the POST we
 * mock the entire `../src/client.js` module so the command's `api.post` call
 * lands in our spy.
 *
 * The command is invoked via commander's `parse(...)` with the same argv
 * shape `orcy triage release-trigger <habitat> --version ...` would produce
 * in production.
 */

const apiMock = vi.hoisted(() => ({
  post: vi.fn().mockResolvedValue({ release: { id: "rel-1", version: "0.1.0" } }),
}));

vi.mock("../src/client.js", () => ({
  api: {
    post: (...args: unknown[]) => apiMock.post(...args),
  },
}));

import { registerTriageCommands } from "../src/commands/triage.js";

function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerTriageCommands(program);
  try {
    program.parse(argv);
  } catch (err) {
    // commander throws on --help / unknown flags; the action runs sync via
    // withErrorHandling which itself returns a deferred promise. We don't
    // await here — the microtask is flushed by the await in the test.
    if (!(err instanceof Error) || !err.message.includes("exited")) throw err;
  }
  return Promise.resolve();
}

describe("AC-DETECT-9: orcy triage release-trigger CLI command", () => {
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;

  beforeEach(() => {
    apiMock.post.mockClear();
    console.log = vi.fn();
    console.error = vi.fn();
    process.exit = vi.fn() as unknown as typeof process.exit;
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  });

  it("POSTs to /api/triage/release-trigger with version + detectedBy=cli", async () => {
    runCli(["node", "orcy", "triage", "release-trigger", "habitat-123", "--version", "v0.24.0"]);
    await new Promise((r) => setImmediate(r));

    expect(apiMock.post).toHaveBeenCalledTimes(1);
    const [path, body] = apiMock.post.mock.calls[0];
    expect(path).toBe("/api/triage/release-trigger");
    expect(body).toMatchObject({
      habitatId: "habitat-123",
      version: "v0.24.0",
      detectedBy: "cli",
    });
    expect(body).not.toHaveProperty("releaseType");
    expect(body).not.toHaveProperty("releaseNotes");
  });

  it("forwards --type and --notes into the payload as releaseType / releaseNotes", async () => {
    runCli([
      "node",
      "orcy",
      "triage",
      "release-trigger",
      "habitat-123",
      "--version",
      "v0.24.0",
      "--type",
      "minor",
      "--notes",
      "shipped the thing",
    ]);
    await new Promise((r) => setImmediate(r));

    expect(apiMock.post).toHaveBeenCalledTimes(1);
    const [, body] = apiMock.post.mock.calls[0];
    expect(body).toMatchObject({
      habitatId: "habitat-123",
      version: "v0.24.0",
      detectedBy: "cli",
      releaseType: "minor",
      releaseNotes: "shipped the thing",
    });
  });

  it("rejects an invalid --type without POSTing", async () => {
    runCli([
      "node",
      "orcy",
      "triage",
      "release-trigger",
      "habitat-123",
      "--version",
      "v0.24.0",
      "--type",
      "garbage",
    ]);
    await new Promise((r) => setImmediate(r));

    // The action validates `--type` against RELEASE_TYPES before POSTing;
    // an invalid value surfaces via withErrorHandling → process.exit(1).
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(apiMock.post).not.toHaveBeenCalled();
  });
});
