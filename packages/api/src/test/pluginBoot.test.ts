import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// `vi.hoisted` keeps the mock fns available to the hoisted `vi.mock` factory
// (vitest hoists `vi.mock` above imports, so plain top-level consts are not
// yet initialized when the factory runs).
const mocks = vi.hoisted(() => ({
  loadPlugins: vi.fn(),
  initializePlugins: vi.fn(),
  getLoadedPlugins: vi.fn(),
}));

vi.mock("../plugins/pluginManager.js", () => ({
  loadPlugins: mocks.loadPlugins,
  initializePlugins: mocks.initializePlugins,
  getLoadedPlugins: mocks.getLoadedPlugins,
}));

import { runPluginBoot } from "../plugins/pluginBoot.js";

interface FakeLog {
  error: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
}

function makeFakeFastify(): FastifyInstance & { log: FakeLog } {
  const log: FakeLog = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  return { log } as unknown as FastifyInstance & { log: FakeLog };
}

// ADR-0041 boot-catch contract — pins the `index.ts`-level split that the
// existing pluginManager-level tests (pluginLoader.test.ts) do NOT cover,
// because those tests call initializePlugins directly and never execute the
// boot catches. These tests run against `runPluginBoot`, which `index.ts`
// invokes at exactly the point the inline try/catches used to live.
//
// The three regression mutations these tests MUST catch:
//   (1) re-merging the two catches into one,
//   (2) the fatal catch logging the non-fatal "continuing without plugins",
//   (3) dropping `process.exit(1)` from the fatal catch.
describe("pluginBoot: index.ts boot-catch contract (ADR-0041)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.loadPlugins.mockReset();
    mocks.initializePlugins.mockReset();
    mocks.getLoadedPlugins.mockReset();
    mocks.getLoadedPlugins.mockReturnValue([]);
    // `process.exit` is the crash-loud lever; stub it to throw so the fatal
    // regime halts inside the function without killing the test runner, and
    // so `toHaveBeenCalledWith(1)` remains assertable.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__PROCESS_EXIT__");
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("fatal regime: initializePlugins throwing logs the boot-failure message AND exits(1)", async () => {
    mocks.loadPlugins.mockResolvedValue(undefined);
    mocks.initializePlugins.mockRejectedValue(new Error("boom-at-mount"));
    const fastify = makeFakeFastify();

    // process.exit throws __PROCESS_EXIT__ (stubbed), surfacing as a rejection.
    await expect(runPluginBoot(fastify)).rejects.toThrow("__PROCESS_EXIT__");

    // Crash-loud lever fired with the operator-visible non-zero code.
    expect(exitSpy).toHaveBeenCalledWith(1);

    const errorMessages = fastify.log.error.mock.calls.map((c) => String(c[1]));

    // The fatal message — operator-specific, distinct from the load-phase one.
    expect(errorMessages).toContain("Plugin route initialization failed - server cannot boot");

    // Mutations (1) & (2): the fatal catch must NOT log the non-fatal message.
    // A merged catch, or a swapped message, would put "continuing without
    // plugins" here and fail this assertion.
    expect(errorMessages).not.toContain("Failed to load plugins - continuing without plugins");
  });

  it("non-fatal regime: loadPlugins throwing logs 'continuing without plugins' and boot CONTINUES (no exit)", async () => {
    mocks.loadPlugins.mockRejectedValue(new Error("import-failed"));
    mocks.initializePlugins.mockResolvedValue(undefined);
    const fastify = makeFakeFastify();

    // Resolves — a load-phase throw must NOT block boot.
    await expect(runPluginBoot(fastify)).resolves.toBeUndefined();

    // Mutation (3) drift check (false-positive guard): the non-fatal path must
    // never exit. (If the catches were merged and exit were shared, a
    // loadPlugins throw could trigger exit(1).)
    expect(exitSpy).not.toHaveBeenCalled();

    const errorMessages = fastify.log.error.mock.calls.map((c) => String(c[1]));
    expect(errorMessages).toContain("Failed to load plugins - continuing without plugins");

    // Boot continued past the loadPlugins catch: initializePlugins WAS reached.
    expect(mocks.initializePlugins).toHaveBeenCalledWith(fastify);
  });

  it("happy path: both phases succeed, no errors logged, no exit, loaded plugins announced", async () => {
    mocks.loadPlugins.mockResolvedValue(undefined);
    mocks.initializePlugins.mockResolvedValue(undefined);
    mocks.getLoadedPlugins.mockReturnValue([
      { id: "p1", version: "1.0.0" },
      { id: "p2", version: "2.0.0" },
    ]);
    const fastify = makeFakeFastify();

    await expect(runPluginBoot(fastify)).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(fastify.log.error).not.toHaveBeenCalled();
    expect(fastify.log.info).toHaveBeenCalledWith(
      {
        plugins: [
          { id: "p1", version: "1.0.0" },
          { id: "p2", version: "2.0.0" },
        ],
      },
      "Plugins loaded",
    );
  });
});
