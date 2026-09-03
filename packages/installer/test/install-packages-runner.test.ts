/**
 * Pin-aware pnpm runner contract for the TypeScript installer (REL-INFRA-2).
 *
 * MOCK BOUNDARY: same harness as the other installer suites (`helpers/setup.ts`):
 * real node:fs against a temp home, `node:child_process` faked. The harness
 * records every intercepted invocation (execSync AND execFileSync) so these
 * tests assert the EXACT runner selection and argument-array propagation:
 *
 *   1. The pnpm version is derived from the SOURCE TREE's `packageManager` pin
 *      (not the ambient environment, not a global install).
 *   2. `corepack pnpm@<version>` is preferred; `npx --yes pnpm@<version>` is
 *      the fallback; if neither can run the pinned version, install fails closed.
 *   3. The resolved runner is threaded through the archive source build, the
 *      local source build, and the runtime-dependency install (~/.orcy cwd) —
 *      all on the same explicit source-derived version.
 *   4. No unversioned/global pnpm is installed or invoked anywhere.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import "./helpers/setup.js";
import { orcyHome, setExecHook, execLog, repoPin } from "./helpers/setup.js";
import { getContext } from "../src/context.js";
import { installPackages } from "../src/install-packages.js";

/** The repo root's pin — assertions follow it so a bump needs no test edit. */
const REPO_PIN = repoPin();
const PIN_RE = new RegExp(REPO_PIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

const srcRoot = () => path.join(orcyHome(), "src", "orcy");
/** The repo root the local install path resolves to (real tree, real pin). */
const repoRoot = () => path.resolve(import.meta.dirname, "..", "..");

type ExecEntry = ReturnType<typeof execLog>[number];

function execFileSyncEntries(): ExecEntry[] {
  return execLog().filter((e) => e.kind === "execFileSync");
}

function optsCwd(e: ExecEntry): string | undefined {
  return (e.opts as { cwd?: string } | undefined)?.cwd;
}

/** Hook the tar extraction to leave a custom root packageManager pin. */
function overwriteSourcePin(packageJson: Record<string, unknown>): void {
  setExecHook((cmd: string) => {
    const tar = cmd.match(/tar\s+-xzf\s+"[^"]+"\s+-C\s+"([^"]+)"\s+--strip-components=1/);
    if (tar) {
      fs.writeFileSync(path.join(tar[1], "package.json"), JSON.stringify(packageJson));
      return ""; // short-circuit: no default seeding; resolution fails before install
    }
    return undefined; // curl etc. fall through to the default handlers
  });
}

afterEach(() => setExecHook(null));

describe("pin-aware pnpm runner — selection", () => {
  it("prefers corepack with the source-derived exact version", async () => {
    await installPackages(getContext(), ["api"], {});

    const entries = execFileSyncEntries();
    // Probe: corepack can run the pinned version.
    expect(
      entries.some(
        (e) => e.file === "corepack" && e.args?.[0] === REPO_PIN && e.args?.[1] === "--version",
      ),
    ).toBe(true);
    // Commands run through corepack on the same pin (never a bare pnpm).
    expect(
      entries.some(
        (e) => e.file === "corepack" && e.args?.[0] === REPO_PIN && e.args?.includes("install"),
      ),
    ).toBe(true);
    expect(
      entries.some(
        (e) => e.file === "corepack" && e.args?.[0] === REPO_PIN && e.args?.includes("-r"),
      ),
    ).toBe(true);
    // Preferred runner means no npx invocation at all.
    expect(entries.some((e) => e.file === "npx")).toBe(false);
  });

  it("falls back to npx --yes pnpm@<version> when corepack cannot run the pin", async () => {
    setExecHook((cmd: string) => {
      if (cmd.startsWith("corepack ")) throw new Error("no corepack available");
      return undefined;
    });

    await installPackages(getContext(), ["api"], {});

    const entries = execFileSyncEntries();
    // The corepack probe was attempted (and failed)...
    expect(entries.some((e) => e.file === "corepack" && e.args?.[1] === "--version")).toBe(true);
    // ...and the fallback ran the SAME pinned version via npx.
    expect(
      entries.some(
        (e) =>
          e.file === "npx" &&
          e.args?.[0] === "--yes" &&
          e.args?.[1] === REPO_PIN &&
          e.args?.[2] === "--version",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (e) =>
          e.file === "npx" &&
          e.args?.[0] === "--yes" &&
          e.args?.[1] === REPO_PIN &&
          e.args?.includes("install"),
      ),
    ).toBe(true);
    // No corepack command beyond the failed probe.
    expect(
      entries.some(
        (e) => e.file === "corepack" && (e.args?.includes("install") || e.args?.includes("-r")),
      ),
    ).toBe(false);
  });

  it("fails closed when neither corepack nor npx can run the pinned pnpm", async () => {
    setExecHook((cmd: string) => {
      if (cmd.startsWith("corepack ") || cmd.startsWith("npx ")) {
        throw new Error("runner unavailable");
      }
      return undefined;
    });

    await expect(installPackages(getContext(), ["api"], {})).rejects.toThrow(PIN_RE);
  });

  it.each(["npm@10.0.0", "pnpm@^9.0.0", "pnpm", "pnpm@9"])(
    "rejects a non-exact/non-pnpm packageManager spec: %s",
    async (spec: string) => {
      overwriteSourcePin({ name: "orcy", private: true, packageManager: spec });
      await expect(installPackages(getContext(), ["api"], {})).rejects.toThrow(/packageManager/i);
    },
  );

  it("rejects a source tree with no packageManager pin", async () => {
    overwriteSourcePin({ name: "orcy", private: true });
    await expect(installPackages(getContext(), ["api"], {})).rejects.toThrow(/packageManager/i);
  });
});

describe("pin-aware pnpm runner — command propagation", () => {
  it("archive path installs and builds the extracted source via the runner", async () => {
    await installPackages(getContext(), ["api"], {});

    const entries = execFileSyncEntries();
    const install = entries.find(
      (e) => e.file === "corepack" && e.args?.[0] === REPO_PIN && e.args?.includes("install"),
    );
    expect(install).toBeDefined();
    expect(optsCwd(install!)).toBe(srcRoot());

    const build = entries.find(
      (e) =>
        e.file === "corepack" &&
        e.args?.[0] === REPO_PIN &&
        e.args?.includes("-r") &&
        e.args?.includes("build"),
    );
    expect(build).toBeDefined();
    expect(optsCwd(build!)).toBe(srcRoot());
  });

  it("runtime-dependency install runs on the same source-derived pin at the orcy home", async () => {
    // The harness seeds components with no dependencies (installRuntimeDeps
    // early-returns on empty deps); inject one into the seeded api package at
    // probe time so the runtime-dependency branch actually executes.
    setExecHook((cmd: string) => {
      if (cmd === `corepack ${REPO_PIN} --version`) {
        const apiPkg = path.join(srcRoot(), "packages", "api", "package.json");
        fs.writeFileSync(
          apiPkg,
          JSON.stringify({
            name: "@orcy/api",
            version: "1.0.0",
            type: "module",
            dependencies: { "smol-toml": "^1.3.0" },
          }),
        );
        return "";
      }
      return undefined;
    });

    await installPackages(getContext(), ["api"], {});

    const runtimeInstall = execFileSyncEntries().find(
      (e) => e.args?.includes("install") && e.args?.includes("--prod"),
    );
    expect(runtimeInstall).toBeDefined();
    expect(runtimeInstall!.file).toBe("corepack");
    expect(runtimeInstall!.args?.[0]).toBe(REPO_PIN);
    expect(optsCwd(runtimeInstall!)).toBe(orcyHome());
  });

  it("local path derives the pin from the repository root", async () => {
    await installPackages(getContext(), ["api"], { local: true });

    const entries = execFileSyncEntries();
    // The pin came from the REAL repo root's packageManager field.
    expect(
      entries.some(
        (e) => e.file === "corepack" && e.args?.[0] === REPO_PIN && e.args?.[1] === "--version",
      ),
    ).toBe(true);
    // Runtime deps still thread the same runner into the orcy home cwd.
    const runtimeInstall = entries.find(
      (e) => e.args?.includes("install") && e.args?.includes("--prod"),
    );
    expect(runtimeInstall).toBeDefined();
    expect(runtimeInstall!.args?.[0]).toBe(REPO_PIN);
    expect(optsCwd(runtimeInstall!)).toBe(orcyHome());
  });
});

describe("pin-aware pnpm runner — global/unversioned pnpm ban", () => {
  it("never installs or invokes an unversioned global pnpm", async () => {
    await installPackages(getContext(), ["api"], {});

    for (const e of execLog()) {
      if (e.kind === "execSync") {
        expect(/^(pnpm|npm)\b/.test(e.cmd)).toBe(false);
        expect(e.cmd).not.toContain("install -g pnpm");
      } else {
        expect(e.file === "pnpm" || e.file === "npm").toBe(false);
        expect(e.args?.join(" ")).not.toContain("install -g pnpm");
      }
    }
  });
});
