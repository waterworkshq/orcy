/**
 * Hermetic bootstrap contract for install.sh (REL-INFRA-2.3).
 *
 * MOCK BOUNDARY: unlike the other installer suites this file does NOT import
 * `helpers/setup.ts` (whose global child_process mock would break spawning).
 * Instead it runs the REAL `install.sh` via `sh` in a fully controlled
 * environment: a temp HOME and a PATH containing only stubs plus symlinks to
 * the real node/coreutils. Every subprocess invocation is recorded to one
 * ordered log so selection, propagation, and the download → extract →
 * install → build → installer-exec order are all observable.
 *
 * Contract under test:
 *   1. The pnpm version comes from the EXTRACTED source's `packageManager`
 *      pin — validated strictly, failing closed on anything else.
 *   2. `corepack pnpm@<version>` is preferred; `npx --yes pnpm@<version>`
 *      is the fallback; neither being able to run the pin fails closed with
 *      an actionable message.
 *   3. No bare `pnpm` is ever invoked and no global pnpm is installed
 *      (forbidden-command stubs fail the test if touched).
 *   4. Download, extraction, build, and the final `exec node …installer`
 *      order are unchanged.
 *   5. The installer is handed off as a STANDALONE copy: the built installer
 *      package is deployed, production-only, into ~/.orcy/installer through
 *      the same pinned runner once the build is done — carrying the dependency
 *      graph the workspace lockfile resolved, workspace packages included,
 *      instead of leaning on the workspace's node_modules or resolving version
 *      ranges afresh. (The package manager itself is a stub here;
 *      `clean-install.test.ts` runs the real one.)
 *   6. A failed deploy, one that produced no entry point, or one that cannot be
 *      moved into place exits non-zero with the cause and leaves a previous
 *      installer working — including one that an interrupted run left moved
 *      aside, which the next run restores before anything else — and nothing
 *      claims completion before the installer has run.
 *   8. One bootstrap at a time per ORCY_HOME: a lock held by a live run stops
 *      a second run before it touches anything, one left by a run that is
 *      gone is taken over, and it is released at the handoff and on failure.
 *      An installer left moved aside by an interrupted promotion is restored
 *      before anything fallible runs.
 *   7. The documented `curl … | bash` leaves the installer a drained pipe as
 *      stdin; when a terminal exists, the handoff gives the installer that
 *      terminal instead, so the interactive wizard can read its answers.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const INSTALL_SH = path.join(REPO_ROOT, "install.sh");

/** Every scenario's disposable HOME; removed once this file has finished. */
const scenarioHomes: string[] = [];
afterAll(() => {
  for (const home of scenarioHomes) fs.rmSync(home, { recursive: true, force: true });
});

/** The repo root's packageManager pin — the fake source mirrors it and the
 *  assertions follow it, so a deliberate pin bump needs no test edit. */
const REPO_PIN = (
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8")) as {
    packageManager?: string;
  }
).packageManager;
if (!REPO_PIN) throw new Error("repo packageManager pin missing");
const PIN_RE = REPO_PIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Resolve a real binary through the test process's own PATH. */
function resolveBin(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // keep scanning
    }
  }
  throw new Error(`cannot resolve real ${name} on PATH`);
}

/** util-linux `script` runs a command inside a pseudo-terminal; null when unavailable. */
const SCRIPT = ((): string | null => {
  if (process.platform !== "linux") return null;
  try {
    return resolveBin("script");
  } catch {
    return null;
  }
})();

function writeStub(dir: string, name: string, body: string): void {
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

interface Scenario {
  logPath: string;
  markerPath: string;
  home: string;
  stubDir: string;
  /** `<home>/.orcy/installer` — where install.sh stages the handed-off copy. */
  installerDir: string;
  /** `<home>/.orcy/bootstrap.lock` — held by a run between its start and its handoff. */
  lockFile: string;
  /** `<home>/.orcy/src/orcy` — the extracted (built) source tree. */
  srcDir: string;
}

/**
 * Build a hermetic environment: fake HOME, stub-only PATH, shared ordered log.
 * `pin` controls the packageManager spec seeded into the fake source; pass
 * `withCorepack`/`withNpx` false to omit those runners from PATH.
 * `failDeploy` makes the runner fail the installer deploy; `built` false seeds
 * a source tree whose installer was never built (no `packages/installer/dist`);
 * `failPromotion` makes the staged installer impossible to move into place;
 * `failDownload` makes the source download fail; `lock` seeds a bootstrap lock.
 */

/** The PID of a process that has already exited. */
function exitedPid(): number {
  return spawnSync(resolveBin("node"), ["-e", "process.exit(0)"]).pid!;
}

function buildScenario(opts: {
  pin?: string | null;
  withCorepack?: boolean;
  withNpx?: boolean;
  nodeVersion?: string | null;
  failDeploy?: boolean;
  built?: boolean;
  failPromotion?: boolean;
  failDownload?: boolean;
  /** `live`: a lock held by this (running) test process. `stale`: one held by a process that exited. */
  lock?: "live" | "stale";
}): Scenario {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "orcy-installsh-"));
  scenarioHomes.push(home);
  const stubDir = path.join(home, "stubs");
  const logPath = path.join(home, "log");
  const markerPath = path.join(home, "installer-exec-marker");
  fs.mkdirSync(stubDir, { recursive: true });

  const pin = "pin" in opts ? opts.pin : REPO_PIN;
  const withCorepack = opts.withCorepack !== false;
  const withNpx = opts.withNpx !== false;

  const log = (s: string) => `printf '%s\\n' "${s}" >> "${logPath}"`;

  // Real node + coreutils so the genuine download/extract/copy flow executes.
  // When `nodeVersion` is specified, stub `node --version` while forwarding all
  // other invocations to the real binary (or omit `node` when null).
  const realNode = resolveBin("node");
  if (!("nodeVersion" in opts)) {
    fs.symlinkSync(realNode, path.join(stubDir, "node"));
  } else if (opts.nodeVersion !== null) {
    writeStub(
      stubDir,
      "node",
      `if [ "$1" = "--version" ]; then echo "${opts.nodeVersion}"; exit 0; fi\nexec "${realNode}" "$@"`,
    );
  }
  for (const b of ["sed", "mkdir", "rm", "mv", "cp", "cat"]) {
    fs.symlinkSync(resolveBin(b), path.join(stubDir, b));
  }
  // With failPromotion, `mv` refuses to move the staged installer into place
  // and passes every other move — the previous installer back included — to
  // the real binary.
  if (opts.failPromotion) {
    fs.rmSync(path.join(stubDir, "mv"));
    writeStub(
      stubDir,
      "mv",
      `first="$1"
for a in "$@"; do last="$a"; done
if [ "$first" = "${path.join(home, ".orcy", "installer.new")}" ]; then
  echo "mv: promotion refused" >&2
  exit 1
fi
exec "${resolveBin("mv")}" "$@"
`,
    );
  }

  // curl -fSL <url> -o <path.tmp> → materialize the archive target.
  writeStub(
    stubDir,
    "curl",
    `
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
${log("curl")}
${opts.failDownload ? 'echo "curl: (22) The requested URL returned error: 404" >&2\nexit 22' : `printf 'fake-archive' > "$out"`}
`,
  );

  // tar -xzf <archive> -C <srcDir> --strip-components=1 → seed the fake source:
  // a built installer package that loads a workspace package (`@orcy/shared`).
  const pkgJson =
    pin === null
      ? JSON.stringify({ name: "orcy", private: true })
      : JSON.stringify({ name: "orcy", private: true, packageManager: pin });
  const installerDist = opts.built === false ? "" : "packages/installer/dist";
  writeStub(
    stubDir,
    "tar",
    `
dir=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-C" ]; then dir="$a"; fi
  prev="$a"
done
${log("tar")}
mkdir -p "$dir/${installerDist}" "$dir/packages/installer/skills" "$dir/packages/shared/dist"
cat > "$dir/package.json" <<'PKGEOF'
${pkgJson}
PKGEOF
cat > "$dir/packages/shared/package.json" <<'PKGEOF'
{ "name": "@orcy/shared", "type": "module", "main": "dist/index.js" }
PKGEOF
printf 'export const id = "shared";\\n' > "$dir/packages/shared/dist/index.js"
cat > "$dir/packages/installer/dist/index.js" <<'IDXEOF'
import { writeFileSync } from "node:fs";
import { id } from "@orcy/shared";
writeFileSync(process.env.ORCY_INSTALLER_EXEC_MARKER, JSON.stringify({ args: process.argv.slice(2), shared: id, stdinIsTTY: process.stdin.isTTY ?? null }));
IDXEOF
printf 'skill\\n' > "$dir/packages/installer/skills/overview.md"
`,
  );

  // Forbidden commands: any invocation is recorded and fails.
  writeStub(stubDir, "pnpm", `${log("FORBIDDEN-bare-pnpm")}\nexit 1`);
  writeStub(stubDir, "npm", `${log("FORBIDDEN-npm")}\nexit 1`);

  // Pin-aware runners: record args plus the working directory (single quoted
  // word — an unquoted "$*" would word-split across log lines). A deploy stands
  // in for the real one: it stages the built package files and injects the
  // workspace package as a real copy, under the last argument as the target.
  // With failDeploy it reports the failure the real one would.
  const deploy = `
case "$*" in
  *" deploy "*)
    for a in "$@"; do target="$a"; done
    mkdir -p "$target/dist" "$target/skills" "$target/node_modules/@orcy"
    cp "$PWD/packages/installer/dist/index.js" "$target/dist/" 2>/dev/null
    cp "$PWD/packages/installer/skills/overview.md" "$target/skills/" 2>/dev/null
    cp -r "$PWD/packages/shared" "$target/node_modules/@orcy/shared" 2>/dev/null
    ${opts.failDeploy ? 'echo "ERR_PNPM_DEPLOY_STUBBED" >&2; exit 1 ;;' : ";;"}
esac
exit 0
`;
  if (withCorepack) {
    writeStub(
      stubDir,
      "corepack",
      `printf "corepack %s @PWD=%s\\n" "$*" "$PWD" >> "${logPath}"\n${deploy}`,
    );
  }
  if (withNpx) {
    writeStub(
      stubDir,
      "npx",
      `printf "npx %s @PWD=%s\\n" "$*" "$PWD" >> "${logPath}"\n${deploy}`,
    );
  }

  // A bootstrap lock from an earlier run, if the scenario starts with one.
  if (opts.lock) {
    const lockDir = path.join(home, ".orcy");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "bootstrap.lock"), `${opts.lock === "live" ? process.pid : exitedPid()}\n`);
  }

  return {
    logPath,
    markerPath,
    home,
    stubDir,
    installerDir: path.join(home, ".orcy", "installer"),
    lockFile: path.join(home, ".orcy", "bootstrap.lock"),
    srcDir: path.join(home, ".orcy", "src", "orcy"),
  };
}

function runInstallSh(s: Scenario, args: string[] = []) {
  // Absolute path: the child's PATH is the stub dir only, which has no sh.
  return spawnSync(resolveBin("sh"), [INSTALL_SH, ...args], {
    env: {
      PATH: s.stubDir,
      HOME: s.home,
      ORCY_INSTALLER_EXEC_MARKER: s.markerPath,
    },
    cwd: s.home,
    encoding: "utf8",
    timeout: 60_000,
  });
}

const logLines = (s: Scenario): string[] => (fs.existsSync(s.logPath) ? readLog(s) : []);

function readLog(s: Scenario): string[] {
  if (!fs.existsSync(s.logPath)) return [];
  return fs
    .readFileSync(s.logPath, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

const firstIndex = (lines: string[], re: RegExp): number => lines.findIndex((l) => re.test(l));

describe("install.sh — pin-aware pnpm bootstrap (hermetic)", () => {
  it("corepack branch: resolves the extracted pin and runs install/build through it", () => {
    const s = buildScenario({});
    const r = runInstallSh(s);
    expect(r.status).toBe(0);

    const lines = readLog(s);
    const curl = firstIndex(lines, /^curl/);
    const tar = firstIndex(lines, /^tar/);
    const probe = firstIndex(lines, new RegExp(`^corepack ${PIN_RE} --version `));
    const install = firstIndex(lines, new RegExp(`^corepack ${PIN_RE} install --frozen-lockfile `));
    const build = firstIndex(lines, new RegExp(`^corepack ${PIN_RE} -r build `));
    expect(curl).toBeGreaterThanOrEqual(0);
    expect(tar).toBeGreaterThan(curl);
    expect(probe).toBeGreaterThan(tar);
    expect(install).toBeGreaterThan(probe);
    expect(build).toBeGreaterThan(install);

    // Install/build run in the extracted source directory.
    expect(lines[install!]).toContain(`@PWD=${s.srcDir}`);
    expect(lines[build!]).toContain(`@PWD=${s.srcDir}`);

    // Preferred runner: npx is never invoked.
    expect(lines.some((l) => l.startsWith("npx"))).toBe(false);
    // The final installer exec ran (order preserved through the end).
    expect(fs.existsSync(s.markerPath)).toBe(true);
    // No bare pnpm / npm invocation anywhere.
    expect(lines.some((l) => l.startsWith("FORBIDDEN"))).toBe(false);
  });

  it("hands off a standalone installer: a production-only deploy of the built package, after the build", () => {
    const s = buildScenario({});
    const r = runInstallSh(s, ["--yes", "--components=api"]);
    expect(r.status).toBe(0);

    const lines = readLog(s);
    const build = firstIndex(lines, new RegExp(`^corepack ${PIN_RE} -r build `));
    // The deploy runs AFTER the build, through the same source-derived pin,
    // from the built source tree, into a staging directory beside any previous
    // installer, and is swapped in only once its entry point exists.
    const deploy = lines.indexOf(
      `corepack ${REPO_PIN} --filter ./packages/installer deploy --prod --config.inject-workspace-packages=true ${s.installerDir}.new @PWD=${s.srcDir}`,
    );
    expect(deploy).toBeGreaterThan(build);
    // Production-only, and no version range is resolved afresh for code that
    // runs immediately: the deploy carries the locked dependency graph.
    expect(lines.some((l) => l.includes("install --prod"))).toBe(false);

    // The handed-off copy ran OUTSIDE the workspace, resolved its workspace
    // dependency from its own real copy, and received the caller's arguments.
    expect(JSON.parse(fs.readFileSync(s.markerPath, "utf8"))).toMatchObject({
      args: ["--yes", "--components=api"],
      shared: "shared",
    });

    // Built files the running installer needs (entry point + skill bundle), in
    // their final place; the staging directory is gone.
    expect(fs.existsSync(path.join(s.installerDir, "dist", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(s.installerDir, "skills", "overview.md"))).toBe(true);
    expect(fs.existsSync(`${s.installerDir}.new`)).toBe(false);
    expect(fs.existsSync(`${s.installerDir}.old`)).toBe(false);

    // Nothing outside the staged directory was relied on for resolution.
    expect(fs.existsSync(path.join(s.home, ".orcy", "node_modules"))).toBe(false);
  });

  it("npx branch: falls back to the same extracted pin when corepack is unavailable", () => {
    const s = buildScenario({ withCorepack: false });
    const r = runInstallSh(s);
    expect(r.status).toBe(0);

    const lines = readLog(s);
    const probe = firstIndex(lines, new RegExp(`^npx --yes ${PIN_RE} --version `));
    const install = firstIndex(
      lines,
      new RegExp(`^npx --yes ${PIN_RE} install --frozen-lockfile `),
    );
    const build = firstIndex(lines, new RegExp(`^npx --yes ${PIN_RE} -r build `));
    expect(probe).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(probe);
    expect(build).toBeGreaterThan(install);
    expect(lines.some((l) => l.startsWith("corepack"))).toBe(false);
    expect(fs.existsSync(s.markerPath)).toBe(true);
    expect(lines.some((l) => l.startsWith("FORBIDDEN"))).toBe(false);
  });

  it("fails closed with the pin in the message when neither corepack nor npx can run it", () => {
    const s = buildScenario({ withCorepack: false, withNpx: false });
    const r = runInstallSh(s);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(new RegExp(PIN_RE));
    // Extraction happened, but nothing ran after resolution failed.
    const lines = readLog(s);
    expect(lines.some((l) => l.startsWith("tar"))).toBe(true);
    expect(lines.some((l) => /install|build/.test(l))).toBe(false);
    expect(fs.existsSync(s.markerPath)).toBe(false);
  });

  it.each(["npm@10.0.0", "pnpm@^9.0.0", "pnpm", null])(
    "fails closed on a non-exact/non-pnpm source pin: %s",
    (pin) => {
      const s = buildScenario({ pin: pin as string | null });
      const r = runInstallSh(s);
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}\n${r.stderr}`).toMatch(/packageManager/i);
      const lines = readLog(s);
      expect(lines.some((l) => /install --frozen-lockfile|-r build/.test(l))).toBe(false);
      expect(fs.existsSync(s.markerPath)).toBe(false);
    },
  );
});

const output = (r: { stdout: string; stderr: string }): string => `${r.stdout}\n${r.stderr}`;

/** A working installer from an earlier run, recognisable by its content. Returns its entry point. */
const seedPreviousInstaller = (s: Scenario): string => {
  const previous = path.join(s.installerDir, "dist", "index.js");
  fs.mkdirSync(path.dirname(previous), { recursive: true });
  fs.writeFileSync(previous, "previous installer");
  return previous;
};

/** The state a run leaves when interrupted while promoting: the previous
 *  installer moved aside, nothing active. Returns the moved-aside entry point. */
const seedInterruptedPromotion = (s: Scenario): string => {
  const aside = path.join(`${s.installerDir}.old`, "dist", "index.js");
  fs.mkdirSync(path.dirname(aside), { recursive: true });
  fs.writeFileSync(aside, "previous installer");
  return aside;
};

describe("install.sh — a failed handoff fails closed", () => {
  it("never prints the bootstrap's completion banner", () => {
    // Regression check for the removed "Setup complete" line: it fails against
    // the previous install.sh, which printed it before the installer ran. The
    // install's own completion is the wizard's to report (clean-install.test.ts).
    const s = buildScenario({});
    const r = runInstallSh(s);
    expect(r.status).toBe(0);
    expect(output(r)).not.toMatch(/setup complete/i);
  });

  it("exits non-zero, names the cause, and keeps the previous installer when the deploy fails", () => {
    const s = buildScenario({ failDeploy: true });
    const previous = seedPreviousInstaller(s);
    const r = runInstallSh(s);
    expect(r.status).not.toBe(0);
    expect(output(r)).toMatch(/failed to prepare the installer/i);
    expect(output(r)).not.toMatch(/setup complete/i);
    // The installer never started, and the one already in place is untouched.
    expect(fs.existsSync(s.markerPath)).toBe(false);
    expect(fs.readFileSync(previous, "utf8")).toBe("previous installer");
    expect(fs.existsSync(`${s.installerDir}.new`)).toBe(false);
  });

  it("exits non-zero, names the cause, and keeps the previous installer when the installer was never built", () => {
    const s = buildScenario({ built: false });
    const previous = seedPreviousInstaller(s);
    const r = runInstallSh(s);
    expect(r.status).not.toBe(0);
    expect(output(r)).toMatch(/failed to stage the installer/i);
    expect(fs.existsSync(s.markerPath)).toBe(false);
    expect(fs.readFileSync(previous, "utf8")).toBe("previous installer");
    expect(fs.existsSync(`${s.installerDir}.new`)).toBe(false);
  });

  it("exits non-zero and puts the previous installer back when the new one cannot be moved into place", () => {
    const s = buildScenario({ failPromotion: true });
    const previous = seedPreviousInstaller(s);
    const r = runInstallSh(s);
    expect(r.status).not.toBe(0);
    expect(output(r)).toMatch(/failed to put the new installer in place/i);
    expect(fs.existsSync(s.markerPath)).toBe(false);
    expect(fs.readFileSync(previous, "utf8")).toBe("previous installer");
    expect(fs.existsSync(`${s.installerDir}.old`)).toBe(false);
  });

  it("restores the installer a previous run left moved aside, even when this run then fails", () => {
    const s = buildScenario({ failDeploy: true });
    const aside = seedInterruptedPromotion(s);
    const r = runInstallSh(s);
    expect(r.status).not.toBe(0);
    // Restored before anything else could fail, so it is the active installer again.
    expect(fs.existsSync(aside)).toBe(false);
    expect(fs.readFileSync(path.join(s.installerDir, "dist", "index.js"), "utf8")).toBe(
      "previous installer",
    );
    expect(fs.existsSync(s.markerPath)).toBe(false);
  });

  it("replaces the installer a previous run left moved aside with a freshly staged one", () => {
    const s = buildScenario({});
    seedInterruptedPromotion(s);
    const r = runInstallSh(s, ["--yes", "--components=api"]);
    expect(r.status).toBe(0);
    // The newly staged installer is the active one, and it ran.
    expect(JSON.parse(fs.readFileSync(s.markerPath, "utf8"))).toMatchObject({
      args: ["--yes", "--components=api"],
    });
    expect(fs.existsSync(`${s.installerDir}.old`)).toBe(false);
    expect(fs.existsSync(`${s.installerDir}.new`)).toBe(false);
  });

  it("clears a backup left beside an active installer", () => {
    // A run interrupted right after promotion: the new installer is active and
    // the previous one was not deleted yet.
    const s = buildScenario({});
    seedPreviousInstaller(s);
    seedInterruptedPromotion(s);
    const r = runInstallSh(s);
    expect(r.status).toBe(0);
    expect(fs.existsSync(`${s.installerDir}.old`)).toBe(false);
    expect(fs.existsSync(`${s.installerDir}.new`)).toBe(false);
  });
});

describe("install.sh — one bootstrap at a time", () => {
  it("refuses to start while another bootstrap run holds the lock", () => {
    const s = buildScenario({ lock: "live" }); // held by this running test process
    const r = runInstallSh(s);
    expect(r.status).not.toBe(0);
    expect(output(r)).toMatch(/another orcy installer run is in progress/i);
    // Nothing was touched: no download, no staging, no handoff, lock left alone.
    expect(readLog(s)).toEqual([]);
    expect(fs.readFileSync(s.lockFile, "utf8").trim()).toBe(String(process.pid));
    expect(fs.existsSync(s.markerPath)).toBe(false);
  });

  it("takes over a lock left by a run that is gone, and releases it at the handoff", () => {
    const s = buildScenario({ lock: "stale" });
    const r = runInstallSh(s);
    expect(r.status).toBe(0);
    expect(fs.existsSync(s.markerPath)).toBe(true);
    expect(fs.existsSync(s.lockFile)).toBe(false);
  });

  it("releases the lock when the run fails", () => {
    const s = buildScenario({ failDeploy: true });
    const r = runInstallSh(s);
    expect(r.status).not.toBe(0);
    expect(fs.existsSync(s.lockFile)).toBe(false);
  });

  it("restores an installer left moved aside even when this run fails before staging", () => {
    // The recovery must not wait for the download, install and build: a
    // failure in any of them would otherwise leave the machine without one.
    const s = buildScenario({ failDownload: true });
    const aside = seedInterruptedPromotion(s);
    const r = runInstallSh(s);
    expect(r.status).not.toBe(0);
    expect(output(r)).toMatch(/failed to download source/i);
    expect(fs.existsSync(aside)).toBe(false);
    expect(fs.readFileSync(path.join(s.installerDir, "dist", "index.js"), "utf8")).toBe(
      "previous installer",
    );
    expect(fs.existsSync(s.lockFile)).toBe(false);
  });
});

describe.skipIf(!SCRIPT)("install.sh — interactive handoff through a terminal", () => {
  it("gives the installer the terminal when its stdin is the drained pipe of `curl … | bash`", () => {
    const s = buildScenario({});
    // A controlling terminal exists (the pseudo-terminal), while the script's
    // stdin sits at end-of-input — exactly what a piped `curl … | bash` leaves.
    const r = spawnSync(
      SCRIPT!,
      [
        "--quiet",
        "--return",
        "--command",
        `"${resolveBin("sh")}" "${INSTALL_SH}" --yes --components=api < /dev/null`,
        "/dev/null",
      ],
      {
        env: { PATH: s.stubDir, HOME: s.home, ORCY_INSTALLER_EXEC_MARKER: s.markerPath },
        cwd: s.home,
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(JSON.parse(fs.readFileSync(s.markerPath, "utf8"))).toMatchObject({
      args: ["--yes", "--components=api"],
      stdinIsTTY: true,
    });
  });
});

describe("install.sh — supported Node.js preflight", () => {
  it.each(["v24.0.0", "v24.11.1", "v26.0.0", "v26.3.2"])(
    "proceeds past preflight for supported Node version %s",
    (nodeVersion) => {
      const s = buildScenario({ nodeVersion });
      const r = runInstallSh(s);
      expect(r.status).toBe(0);
      expect(readLog(s).some((l) => l === "curl")).toBe(true);
      expect(fs.existsSync(s.markerPath)).toBe(true);
    },
  );

  it("stops before download when node is missing", () => {
    const s = buildScenario({ nodeVersion: null });
    const r = runInstallSh(s);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/Node\.js not found.*24.*26/);
    expect(logLines(s)).toEqual([]);
    expect(fs.existsSync(s.markerPath)).toBe(false);
  });

  it.each(["v20.19.0", "v22.14.0", "v25.0.0", "v27.0.0", "v24.", "v26.not-a-version", "invalid"])(
    "stops before download for unsupported Node version %s",
    (nodeVersion) => {
      const s = buildScenario({ nodeVersion });
      const r = runInstallSh(s);
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}\n${r.stderr}`).toMatch(/Unsupported Node\.js version.*24.*26/);
      expect(logLines(s)).toEqual([]);
      expect(fs.existsSync(s.markerPath)).toBe(false);
    },
  );
});

describe("install.sh — structural global/bare pnpm ban", () => {
  it("contains no global pnpm bootstrap and no bare pnpm lookup", () => {
    const src = fs.readFileSync(INSTALL_SH, "utf8");
    expect(src).not.toContain("command -v pnpm");
    expect(src).not.toMatch(/install -g pnpm/);
  });
});
