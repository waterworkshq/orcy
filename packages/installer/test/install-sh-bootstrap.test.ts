/**
 * Hermetic bootstrap contract for install.sh (REL-INFRA-2.3).
 *
 * MOCK BOUNDARY: unlike the other installer suites this file does NOT import
 * `helpers/setup.js` (whose global child_process mock would break spawning).
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
 *   4. Download, extraction, copy, and the final `exec node …installer`
 *      order are unchanged.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const INSTALL_SH = path.join(REPO_ROOT, "install.sh");

/** The repo root's packageManager pin — the fake source mirrors it and the
 *  assertions follow it, so a deliberate pin bump needs no test edit. */
const REPO_PIN = (JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"),
) as { packageManager?: string }).packageManager;
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

function writeStub(dir: string, name: string, body: string): void {
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

interface Scenario {
  logPath: string;
  markerPath: string;
  home: string;
  stubDir: string;
}

/**
 * Build a hermetic environment: fake HOME, stub-only PATH, shared ordered log.
 * `pin` controls the packageManager spec seeded into the fake source; pass
 * `withCorepack`/`withNpx` false to omit those runners from PATH.
 */
function buildScenario(opts: {
  pin?: string | null;
  withCorepack?: boolean;
  withNpx?: boolean;
}): Scenario {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "orcy-installsh-"));
  const stubDir = path.join(home, "stubs");
  const logPath = path.join(home, "log");
  const markerPath = path.join(home, "installer-exec-marker");
  fs.mkdirSync(stubDir, { recursive: true });

  const pin = "pin" in opts ? opts.pin : REPO_PIN;
  const withCorepack = opts.withCorepack !== false;
  const withNpx = opts.withNpx !== false;

  const log = (s: string) => `printf '%s\\n' "${s}" >> "${logPath}"`;

  // Real node + coreutils so the genuine download/extract/copy flow executes.
  for (const b of ["node", "sed", "mkdir", "rm", "mv", "cp", "cat"]) {
    fs.symlinkSync(resolveBin(b), path.join(stubDir, b));
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
printf 'fake-archive' > "$out"
`,
  );

  // tar -xzf <archive> -C <srcDir> --strip-components=1 → seed the fake source.
  const pkgJson =
    pin === null
      ? JSON.stringify({ name: "orcy", private: true })
      : JSON.stringify({ name: "orcy", private: true, packageManager: pin });
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
mkdir -p "$dir/packages/installer/dist" "$dir/packages/installer/skills"
cat > "$dir/package.json" <<'PKGEOF'
${pkgJson}
PKGEOF
cat > "$dir/packages/installer/dist/index.js" <<'IDXEOF'
require("fs").writeFileSync(process.env.ORCY_INSTALLER_EXEC_MARKER, "ran:" + JSON.stringify(process.argv.slice(2)));
IDXEOF
printf 'skill\\n' > "$dir/packages/installer/skills/overview.md"
`,
  );

  // Forbidden commands: any invocation is recorded and fails.
  writeStub(stubDir, "pnpm", `${log("FORBIDDEN-bare-pnpm")}\nexit 1`);
  writeStub(stubDir, "npm", `${log("FORBIDDEN-npm")}\nexit 1`);

  // Pin-aware runners: record args plus the working directory (single quoted
  // word — an unquoted "$*" would word-split across log lines).
  if (withCorepack) {
    writeStub(
      stubDir,
      "corepack",
      `printf "corepack %s @PWD=%s\\n" "$*" "$PWD" >> "${logPath}"\nexit 0`,
    );
  }
  if (withNpx) {
    writeStub(stubDir, "npx", `printf "npx %s @PWD=%s\\n" "$*" "$PWD" >> "${logPath}"\nexit 0`);
  }

  return { logPath, markerPath, home, stubDir };
}

function runInstallSh(s: Scenario) {
  // Absolute path: the child's PATH is the stub dir only, which has no sh.
  return spawnSync(resolveBin("sh"), [INSTALL_SH], {
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
    const srcDir = `${s.home}/.orcy/src/orcy`;
    expect(lines[install!]).toContain(`@PWD=${srcDir}`);
    expect(lines[build!]).toContain(`@PWD=${srcDir}`);

    // Preferred runner: npx is never invoked.
    expect(lines.some((l) => l.startsWith("npx"))).toBe(false);
    // The final installer exec ran (order preserved through the end).
    expect(fs.existsSync(s.markerPath)).toBe(true);
    // No bare pnpm / npm invocation anywhere.
    expect(lines.some((l) => l.startsWith("FORBIDDEN"))).toBe(false);
  });

  it("npx branch: falls back to the same extracted pin when corepack is unavailable", () => {
    const s = buildScenario({ withCorepack: false });
    const r = runInstallSh(s);
    expect(r.status).toBe(0);

    const lines = readLog(s);
    const probe = firstIndex(lines, new RegExp(`^npx --yes ${PIN_RE} --version `));
    const install = firstIndex(lines, new RegExp(`^npx --yes ${PIN_RE} install --frozen-lockfile `));
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

describe("install.sh — structural global/bare pnpm ban", () => {
  it("contains no global pnpm bootstrap and no bare pnpm lookup", () => {
    const src = fs.readFileSync(INSTALL_SH, "utf8");
    expect(src).not.toContain("command -v pnpm");
    expect(src).not.toMatch(/install -g pnpm/);
  });
});
