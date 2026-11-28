/**
 * Runtime dependency closure of an installed destination.
 *
 * MOCK BOUNDARY: same harness as the other installer suites (`helpers/setup.ts`)
 * — real `node:fs` against a temp home, `node:child_process` faked. The
 * package-manager install is therefore NOT exercised here (`clean-install.test.ts`
 * runs the real one); what IS exercised is everything the installer decides on
 * its own: the destination manifest it hands to the pinned pnpm, and the files
 * it copies into `~/.orcy/node_modules`.
 *
 * Contract under test — the destination is NOT a pnpm workspace, so:
 *   1. its manifest never carries a `workspace:` spec (the pinned pnpm rejects
 *      it with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND);
 *   2. the workspace packages the selected components load — listed under
 *      `dependencies` OR `devDependencies`, followed transitively — are copied
 *      as real packages beside the components;
 *   3. registry dependencies of those workspace packages are installed too,
 *      while dev-only registry dependencies stay out;
 *   4. a closure that cannot be satisfied fails the install, and a failing
 *      pnpm reports its own diagnostic.
 * And the way back: a destination manifest that the pre-fix installer left
 * with a workspace spec is repaired, not merged over, so those machines can
 * install again.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import "./helpers/setup.js";
import { orcyHome, setExecHook, execLog, repoPin } from "./helpers/setup.js";
import { getContext } from "../src/context.js";
import { installPackages } from "../src/install-packages.js";

const REPO_PIN = repoPin();

const srcPackage = (name: string, ...seg: string[]): string =>
  path.join(orcyHome(), "src", "orcy", "packages", name, ...seg);
const installed = (...seg: string[]): string => path.join(orcyHome(), "node_modules", ...seg);

/** The real workspace's dependency shapes, in miniature. */
const MANIFESTS: Record<string, object> = {
  api: {
    name: "@orcy/api",
    dependencies: { fastify: "^5.12.8", zod: "^4.6.7", "@orcy/shared": "workspace:*" },
    devDependencies: { "@orcy/daemon": "workspace:*", "sql.js": "^1.17.0" },
  },
  cli: {
    name: "@orcy/cli",
    dependencies: { "@orcy/daemon": "workspace:*", "@orcy/shared": "workspace:*", commander: "^13.1.0" },
  },
  mcp: {
    name: "@orcy/mcp",
    dependencies: { "@modelcontextprotocol/sdk": "^1.32.2", "@orcy/shared": "workspace:*" },
  },
  shared: { name: "@orcy/shared", dependencies: { zod: "^4.6.7" } },
  daemon: { name: "@orcy/daemon", dependencies: { "@orcy/shared": "workspace:*" } },
};

/**
 * Exec hook that gives the extracted fake source real-shaped manifests once it
 * exists: the tar stub seeds the tree just before the pnpm probe runs.
 * `distOf` limits which workspace packages were built.
 */
function sourceHook(
  manifests: Record<string, object> = MANIFESTS,
  distOf: string[] = ["shared", "daemon"],
): (cmd: string) => unknown {
  return (cmd: string) => {
    if (cmd !== `corepack ${REPO_PIN} --version`) return undefined;
    for (const [dir, manifest] of Object.entries(manifests)) {
      fs.mkdirSync(srcPackage(dir), { recursive: true });
      fs.writeFileSync(srcPackage(dir, "package.json"), JSON.stringify(manifest));
    }
    for (const dir of distOf) {
      fs.mkdirSync(srcPackage(dir, "dist"), { recursive: true });
      fs.writeFileSync(srcPackage(dir, "dist", "index.js"), `export const id = "${dir}";\n`);
    }
    return "";
  };
}

function destinationDeps(): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(orcyHome(), "package.json"), "utf-8")).dependencies;
}

function installManifestFiles(): string[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(orcyHome(), "install-manifest.json"), "utf-8"));
  return manifest.files.map((f: { path: string }) => f.path);
}

function isRealDirectory(p: string): boolean {
  const stat = fs.lstatSync(p);
  return stat.isDirectory() && !stat.isSymbolicLink();
}

afterEach(() => setExecHook(null));

describe("installed runtime closure — destination manifest", () => {
  it("hands pnpm registry dependencies only: no `workspace:` spec, ever", async () => {
    setExecHook(sourceHook());
    await installPackages(getContext(), ["cli", "api", "mcp"], {});

    expect(Object.values(destinationDeps()).some((spec) => spec.startsWith("workspace:"))).toBe(false);
    // Components' registry dependencies plus those of the workspace packages
    // they load (shared → zod); the dev-only registry dependency stays out.
    expect(destinationDeps()).toEqual({
      fastify: "^5.12.8",
      zod: "^4.6.7",
      "@modelcontextprotocol/sdk": "^1.32.2",
      commander: "^13.1.0",
    });
  });

  it("installs them with the pinned pnpm, production-only, at the orcy home", async () => {
    setExecHook(sourceHook());
    await installPackages(getContext(), ["api"], {});

    const install = execLog().find((e) => e.kind === "execFileSync" && e.args?.includes("--prod"));
    expect(install?.file).toBe("corepack");
    expect(install?.args?.slice(0, 2)).toEqual([REPO_PIN, "install"]);
    expect((install?.opts as { cwd?: string } | undefined)?.cwd).toBe(orcyHome());
  });

  it("recovers a destination manifest that an earlier installer left with a workspace spec", async () => {
    // The pre-fix installer merged the components' workspace specs into
    // ~/.orcy/package.json before pnpm failed, so exactly the machines that hit
    // the reported failure carry one. A user's own dependency must survive.
    fs.writeFileSync(
      path.join(orcyHome(), "package.json"),
      JSON.stringify({
        private: true,
        dependencies: { "@orcy/shared": "workspace:*", "left-pad": "^1.3.0" },
      }),
    );
    setExecHook(sourceHook());
    await installPackages(getContext(), ["api"], {});

    expect(destinationDeps()).toMatchObject({ fastify: "^5.12.8", "left-pad": "^1.3.0" });
    expect(Object.values(destinationDeps()).some((spec) => spec.startsWith("workspace:"))).toBe(false);
  });

  it("repairs that manifest even when the selection brings no registry dependency of its own", async () => {
    fs.writeFileSync(
      path.join(orcyHome(), "package.json"),
      JSON.stringify({
        private: true,
        dependencies: { "@orcy/shared": "workspace:*", "left-pad": "^1.3.0" },
      }),
    );
    // The harness seeds its components without registry dependencies.
    await installPackages(getContext(), ["api"], {});

    expect(destinationDeps()).toEqual({ "left-pad": "^1.3.0" });
    expect(execLog().some((e) => e.args?.includes("--prod"))).toBe(true);
  });
});

describe("installed runtime closure — workspace packages", () => {
  it("copies the workspace packages the components load as real packages beside them, transitively", async () => {
    setExecHook(sourceHook());
    await installPackages(getContext(), ["cli", "api", "mcp"], {});

    // cli → daemon → shared, api → shared, mcp → shared.
    for (const name of ["cli", "api", "mcp", "shared", "daemon"]) {
      expect(isRealDirectory(installed("@orcy", name)), `${name} is a real directory`).toBe(true);
      expect(fs.existsSync(path.join(installed("@orcy", name), "dist", "index.js")), `${name}/dist`).toBe(true);
      expect(fs.existsSync(path.join(installed("@orcy", name), "package.json")), `${name}/package.json`).toBe(true);
    }
  });

  it("loads a workspace package the source lists under devDependencies", async () => {
    // api → @orcy/daemon is a workspace *devDependency* in the source manifest,
    // but the built API imports it at startup.
    setExecHook(sourceHook());
    await installPackages(getContext(), ["api"], {});

    expect(isRealDirectory(installed("@orcy", "daemon"))).toBe(true);
  });

  it("keeps manifest ownership unchanged: workspace packages are not journalled", async () => {
    setExecHook(sourceHook());
    await installPackages(getContext(), ["api"], {});

    const files = installManifestFiles();
    expect(files).toContain(installed("@orcy", "api"));
    expect(files.some((p) => /node_modules\/@orcy\/(shared|daemon)/.test(p))).toBe(false);
  });
});

describe("installed runtime closure — failure is loud", () => {
  it("fails the install when a workspace dependency has no package in the source", async () => {
    const api = MANIFESTS.api as { dependencies: Record<string, string> };
    setExecHook(sourceHook({ ...MANIFESTS, api: { ...api, dependencies: { "@orcy/absent": "workspace:*" } } }));
    await expect(installPackages(getContext(), ["api"], {})).rejects.toThrow(/@orcy\/absent/);
  });

  it("fails the install, before anything is installed or copied, when a workspace dependency was never built", async () => {
    setExecHook(sourceHook(MANIFESTS, ["shared"])); // daemon: manifest but no dist
    await expect(installPackages(getContext(), ["api"], {})).rejects.toThrow(/@orcy\/daemon/);
    expect(execLog().some((e) => e.args?.includes("--prod"))).toBe(false);
    expect(fs.existsSync(path.join(orcyHome(), "node_modules", "@orcy"))).toBe(false);
  });

  it("refuses a workspace dependency whose name is not a package name, before that name becomes a path", async () => {
    const escape = path.join(orcyHome(), "escape");
    fs.mkdirSync(escape);
    fs.writeFileSync(path.join(escape, "sentinel"), "keep");
    // A source tree whose manifests agree on a name that climbs out of
    // node_modules, with a dist so the copy would proceed to its removal.
    const api = MANIFESTS.api as { dependencies: Record<string, string> };
    setExecHook(
      sourceHook(
        {
          ...MANIFESTS,
          evil: { name: "@orcy/../../escape", dependencies: {} },
          api: { ...api, dependencies: { "@orcy/../../escape": "workspace:*" } },
        },
        ["shared", "daemon", "evil"],
      ),
    );
    await expect(installPackages(getContext(), ["api"], {})).rejects.toThrow(
      /Workspace dependency "@orcy\/\.\.\/\.\.\/escape".*is not a package/,
    );
    expect(fs.readFileSync(path.join(escape, "sentinel"), "utf-8")).toBe("keep");
  });

  it("reports the package manager's own diagnostic when the runtime install fails", async () => {
    const seed = sourceHook();
    setExecHook((cmd: string) => {
      if (cmd.includes("install --prod")) {
        // Shape of the error `execFileSync` throws with `stdio: "pipe"`.
        throw Object.assign(new Error("Command failed: corepack pnpm@10.34.8 install --prod"), {
          status: 1,
          stdout: Buffer.from("Progress: resolved 1, done"),
          stderr: Buffer.from(" ERR_PNPM_WORKSPACE_PKG_NOT_FOUND  In : \"@orcy/shared\"\n"),
        });
      }
      return seed(cmd);
    });
    const failure = installPackages(getContext(), ["api"], {});
    await expect(failure).rejects.toThrow(/Pinned pnpm failed \(exit 1, ERR_PNPM_WORKSPACE_PKG_NOT_FOUND\)/);
    await expect(failure).rejects.toThrow(/install --prod/);
    expect(fs.existsSync(path.join(orcyHome(), "install-manifest.json"))).toBe(false);
  });

  it("reports only that code and the exit status — not pnpm's output, not the raw child error", async () => {
    const seed = sourceHook();
    setExecHook((cmd: string) => {
      if (cmd.includes("install --prod")) {
        // Output can carry a credential-bearing URL and whatever a lifecycle
        // script printed; it must not reach terminals, logs or transcripts.
        throw Object.assign(new Error("Command failed: corepack pnpm@10.34.8 install --prod"), {
          status: 1,
          stdout: Buffer.from("TOKEN_FROM_A_LIFECYCLE_SCRIPT=hunter2"),
          stderr: Buffer.from(
            " ERR_PNPM_FETCH_401  GET https://deploy:hunter2@registry.example.com/pkg\n",
          ),
        });
      }
      return seed(cmd);
    });
    const failure = installPackages(getContext(), ["api"], {});
    await expect(failure).rejects.toThrow(/Pinned pnpm failed \(exit 1, ERR_PNPM_FETCH_401\)/);
    await expect(failure).rejects.not.toThrow(/hunter2|registry\.example\.com|TOKEN_FROM/);
    const error: unknown = await failure.catch((e: unknown) => e);
    expect((error as Error).cause).toBeUndefined();
  });

  it("reports the spawn code when the pinned pnpm could not run at all", async () => {
    const seed = sourceHook();
    setExecHook((cmd: string) => {
      if (cmd.includes("install --prod")) {
        throw Object.assign(new Error("spawn corepack ENOENT"), { status: null, code: "ENOENT" });
      }
      return seed(cmd);
    });
    await expect(installPackages(getContext(), ["api"], {})).rejects.toThrow(
      /Pinned pnpm failed \(ENOENT\)/,
    );
  });
});
