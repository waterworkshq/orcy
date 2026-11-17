/**
 * Unit regression tests for the watch-mode half of the wire coordinator.
 *
 * The coordinator's non-watch half (the one-shot build) is covered by every
 * real wire run; these tests pin the WATCH edges that a `vitest run` cannot
 * exercise:
 *
 *  - sibling package tsconfig edits must be under the watcher (an unwatched
 *    productionInputs match silently schedules nothing);
 *  - a newly created production-input file must arm the rebuild flag (chokidar
 *    emits "add", not "change").
 *
 * NOTE: this file deliberately never references the wireBuild module via a
 * static `import ... from` statement — `isWireConsumer` classifies by that
 * import text, and such an import here would turn this unit test into a wire
 * consumer that forces the four-package build whenever it runs alone (even
 * inside a comment, the quoted module specifier matches). The mocked seam is
 * fetched through a dynamic import for the same reason.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

vi.mock("./wireBuild.js", () => ({
  WIRE_BUILD_DONE_ENV: "ORCY_MCP_WIRE_BUILD_DONE",
  buildWireTargets: vi.fn(),
}));

// Static import of the module under test is safe: it is not a wire consumer
// import, and the mocked seam below keeps the setup from ever spawning tsc.
import wireGlobalSetup from "./wireGlobalSetup.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = resolve(THIS_DIR, "..", "..");
const REPO_ROOT = resolve(MCP_ROOT, "..", "..");
// A real wire consumer file — its source contains the wireBuild import the
// coordinator's isWireConsumer check looks for.
const CONSUMER_FILE = join(THIS_DIR, "notificationSelfServiceWire.test.ts");

type RerunSpy = ReturnType<typeof vi.fn>;

interface FakeProject {
  config: { root: string };
  vite: { watcher: EventEmitter & { add: (paths: string[]) => void } };
  vitest: {
    config: { watchTriggerPatterns?: unknown[] };
    watcher: { onFileChange: (file: string) => void };
  };
  onTestsRerun: RerunSpy;
  globTestFiles: (filters: string[]) => Promise<{ testFiles: string[] }>;
}

function makeFakeProject(testFiles: string[]): FakeProject {
  const watcher = new EventEmitter() as EventEmitter & { add: (paths: string[]) => void };
  watcher.add = vi.fn();
  const project: FakeProject = {
    config: { root: MCP_ROOT },
    vite: { watcher },
    vitest: { config: {}, watcher: { onFileChange: vi.fn() } },
    onTestsRerun: vi.fn(),
    globTestFiles: vi.fn().mockResolvedValue({ testFiles }),
  };
  return project;
}

async function armedSetup(testFiles = [CONSUMER_FILE]): Promise<{
  project: FakeProject;
  watcher: EventEmitter & { add: (paths: string[]) => void };
  rerun: () => void;
  teardown: () => void;
}> {
  const project = makeFakeProject(testFiles);
  const teardown = await wireGlobalSetup(project as unknown as TestProject);
  // Discard the coordinator's initial per-run build so each test counts only
  // the watch-triggered rebuilds it simulates itself.
  buildWireTargets.mockClear();
  const registered = project.onTestsRerun.mock.calls[0]?.[0] as (() => void) | undefined;
  if (!registered) throw new Error("coordinator did not register an onTestsRerun hook");
  return { project, watcher: project.vite.watcher, rerun: registered, teardown };
}

const wireBuildModule = await import("./wireBuild.js");
const buildWireTargets = vi.mocked(wireBuildModule.buildWireTargets);

beforeEach(() => {
  buildWireTargets.mockClear();
});

describe("wire coordinator watch gating", () => {
  it("builds nothing and watches nothing when no wire consumer is selected", async () => {
    const project = makeFakeProject([]);
    const teardown = await wireGlobalSetup(project as unknown as TestProject);

    expect(buildWireTargets).not.toHaveBeenCalled();
    expect(project.vite.watcher.add).not.toHaveBeenCalled();
    expect(project.onTestsRerun).not.toHaveBeenCalled();
    teardown();
  });

  it("puts the three sibling package ROOTS under watch so tsconfig edits are seen", async () => {
    const { watcher, project, teardown } = await armedSetup();

    expect(watcher.add).toHaveBeenCalledTimes(1);
    expect(watcher.add).toHaveBeenCalledWith([
      resolve(MCP_ROOT, "..", "api"),
      resolve(MCP_ROOT, "..", "daemon"),
      resolve(MCP_ROOT, "..", "shared"),
    ]);
    // The trigger pattern must count sibling root tsconfigs, while compiled
    // output stays inert (a dist write must schedule no rebuild loop).
    const [trigger] = project.vitest.config.watchTriggerPatterns as [{ pattern: RegExp }];
    expect(trigger.pattern.test(join(REPO_ROOT, "packages/api/tsconfig.build.json"))).toBe(true);
    expect(trigger.pattern.test(join(REPO_ROOT, "packages/shared/src/newModule.ts"))).toBe(true);
    expect(trigger.pattern.test(join(REPO_ROOT, "packages/api/dist/index.js"))).toBe(false);
    teardown();
  });

  it("rebuilds before the rerun for a sibling tsconfig edit", async () => {
    const { watcher, rerun, teardown } = await armedSetup();

    watcher.emit("change", join(REPO_ROOT, "packages/api/tsconfig.build.json"));
    rerun();

    expect(buildWireTargets).toHaveBeenCalledTimes(1);
    expect(buildWireTargets).toHaveBeenCalledWith(MCP_ROOT);
    teardown();
  });

  it("rebuilds before the rerun for a NEWLY CREATED production-input file", async () => {
    const { watcher, rerun, teardown } = await armedSetup();

    watcher.emit("add", join(REPO_ROOT, "packages/shared/src/newModule.ts"));
    rerun();

    expect(buildWireTargets).toHaveBeenCalledTimes(1);
    teardown();
  });

  it("arms a tsconfig edit from a Windows-separated change event", async () => {
    const { watcher, rerun, teardown } = await armedSetup();

    // Real workspace-root path with Windows separators, exactly as chokidar
    // delivers them on win32 — only the change path is exercised here.
    watcher.emit("change", join(REPO_ROOT, "packages/api/tsconfig.build.json").replace(/\//g, "\\"));
    rerun();

    expect(buildWireTargets).toHaveBeenCalledTimes(1);
    teardown();
  });

  it("arms a new input from a Windows-separated add event", async () => {
    const { watcher, rerun, teardown } = await armedSetup();

    // Independent setup so a broken normalization in the add handler fails
    // this test even when the change handler is fine (and vice versa).
    watcher.emit("add", join(REPO_ROOT, "packages/shared/src/newModule.ts").replace(/\//g, "\\"));
    rerun();

    expect(buildWireTargets).toHaveBeenCalledTimes(1);
    teardown();
  });

  it("arms the rebuild when a production input appears during the build window", async () => {
    const probe = join(REPO_ROOT, "packages/shared/src/__midSetupProbe.ts");
    // The mocked initial build "runs" while a new input lands mid-window:
    // the baseline is captured before the build, the post-watch snapshot
    // after, and the coordinator must arm the first rerun for the newcomer.
    buildWireTargets.mockImplementationOnce(() => {
      writeFileSync(probe, "export const midSetupProbe = true;\n");
    });
    try {
      const { rerun, teardown } = await armedSetup();
      rerun();
      expect(buildWireTargets).toHaveBeenCalledTimes(1);
      teardown();
    } finally {
      rmSync(probe);
    }
  });

  it("does not arm when the production tree is unchanged across setup", async () => {
    const { rerun, teardown } = await armedSetup();

    rerun();

    expect(buildWireTargets).not.toHaveBeenCalled();
    teardown();
  });

  it("ignores add events for inputs that predate the run (rescan noise)", async () => {
    const { watcher, rerun, teardown } = await armedSetup();

    // watcher.add() of the sibling roots rescans them; an "add" surfacing a
    // pre-existing input is scan noise and must not arm a needless rebuild.
    watcher.emit("add", join(REPO_ROOT, "packages/api/src/index.ts"));
    rerun();

    expect(buildWireTargets).not.toHaveBeenCalled();
    teardown();
  });

  it("arms again when a pre-existing input is deleted and recreated", async () => {
    const { watcher, rerun, teardown } = await armedSetup();
    const input = join(REPO_ROOT, "packages/daemon/src/index.ts");

    watcher.emit("unlink", input);
    rerun();
    expect(buildWireTargets).toHaveBeenCalledTimes(1);

    // The unlink dropped the path from the pre-run snapshot, so the recreate
    // is a genuine new input and must arm again.
    watcher.emit("add", input);
    rerun();
    expect(buildWireTargets).toHaveBeenCalledTimes(2);
    teardown();
  });

  it("does not rebuild when only a test file changed", async () => {
    const { watcher, rerun, teardown } = await armedSetup();

    watcher.emit("change", join(THIS_DIR, "code-evidence.test.ts"));
    rerun();

    expect(buildWireTargets).not.toHaveBeenCalled();
    teardown();
  });

  it("routes a deleted production input to a consumer rerun and rebuilds", async () => {
    const { watcher, rerun, project, teardown } = await armedSetup();

    watcher.emit("unlink", join(REPO_ROOT, "packages/daemon/src/index.ts"));
    expect(project.vitest.watcher.onFileChange).toHaveBeenCalledWith(
      join(REPO_ROOT, "packages/daemon/src/index.ts"),
    );
    rerun();

    expect(buildWireTargets).toHaveBeenCalledTimes(1);
    teardown();
  });

  it("stops arming the rebuild flag after teardown", async () => {
    const { watcher, rerun, teardown } = await armedSetup();
    teardown();

    watcher.emit("change", join(REPO_ROOT, "packages/api/src/index.ts"));
    watcher.emit("add", join(REPO_ROOT, "packages/api/src/newModule.ts"));
    rerun();

    expect(buildWireTargets).not.toHaveBeenCalled();
  });
});
