/**
 * Shared build seam for the real-stdio MCP wire tests.
 *
 * The wire tests boot the COMPILED api/mcp servers, so the workspace targets
 * must be built before they spawn. The run-scoped coordinator
 * (`wireGlobalSetup.ts`) performs the build once per run before any worker
 * starts and signals completion through the environment; a wire file that
 * reaches this seam afterwards (or a run without the global setup) builds
 * inline instead.
 */
import { execSync } from "node:child_process";

/** Env handshake set when the workspace wire targets are already built. */
export const WIRE_BUILD_DONE_ENV = "ORCY_MCP_WIRE_BUILD_DONE";

export function buildWireTargets(packageDir: string): void {
  if (process.env[WIRE_BUILD_DONE_ENV] === "1") return;
  // --noEmitOnError keeps a failing rebuild from partially rewriting dist:
  // the coordinator's watch path promises consumers the last good output, and
  // plain tsc would emit despite type errors. (No `--` separator — pnpm
  // forwards it literally and tsc rejects it.)
  execSync(
    "corepack pnpm --filter @orcy/shared --filter @orcy/daemon --filter @orcy/api --filter @orcy/mcp build --noEmitOnError",
    {
      cwd: packageDir,
      stdio: "pipe",
    },
  );
  process.env[WIRE_BUILD_DONE_ENV] = "1";
}
