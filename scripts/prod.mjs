#!/usr/bin/env node
// Production convenience runner: build first, then the API and UI services
// together. A failed build starts neither service and exits nonzero; when a
// service exits, the sibling is terminated and its status becomes the exit
// code. Commands are env-overridable (ORCY_PROD_BUILD/ORCY_PROD_API/ORCY_PROD_UI)
// so the ordering/failure contract is regression-checked with stubs in
// scripts/prod.test.mjs — they are test seams, not operator configuration.
import { spawn } from "node:child_process";

const buildCommand = process.env.ORCY_PROD_BUILD ?? "corepack pnpm build";
const apiCommand = process.env.ORCY_PROD_API ?? "corepack pnpm start:api";
const uiCommand = process.env.ORCY_PROD_UI ?? "corepack pnpm start:ui";

// A service that ignores SIGTERM (or drains slowly) must not outlive the
// runner by holding its port forever: shutdown escalates to SIGKILL after
// this grace window.
const SHUTDOWN_GRACE_MS = 5_000;

const children = new Set();

function run(command, onSpawnError) {
  // Own process group: `shell: true` wraps the command in /bin/sh, and a
  // signal to the wrapper alone leaves the pnpm/node grandchildren running
  // with their ports held. `detached: true` makes each child a process-group
  // leader so shutdown can signal the whole group.
  const child = spawn(command, { shell: true, stdio: "inherit", detached: true });
  children.add(child);
  child.on("exit", () => children.delete(child));
  // Without an `error` listener a failed spawn throws an uncaught exception
  // and the runner dies without shutting down everything already running.
  child.on("error", (err) => {
    children.delete(child);
    onSpawnError?.(err);
  });
  return child;
}

function signalGroups(signal) {
  for (const child of children) {
    // Negative pid signals the child's whole process group; fall back to a
    // direct signal when the group is already gone.
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }
}

let shutdownStarted = false;
function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  signalGroups("SIGTERM");
  // The direct child (shell/pnpm) can exit on SIGTERM while a draining or
  // stubborn DESCENDANT still holds the group and its port — the children set
  // is keyed to direct-child exits and must not decide teardown. Track the
  // groups themselves: exit promptly once every group is gone, and escalate
  // to SIGKILL for any group still alive after the grace window. The poll
  // keeps the runner open until then.
  const groups = [...children]
    .map((child) => child.pid)
    .filter((pid) => typeof pid === "number");
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  const poll = setInterval(() => {
    const alive = groups.filter((pid) => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (alive.length === 0) {
      clearInterval(poll);
      return;
    }
    if (Date.now() >= deadline) {
      for (const pid of alive) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* group reaped between check and signal */
        }
      }
      clearInterval(poll);
    }
  }, 100);
}

// SIGINT/SIGTERM propagate to the child groups; SIGHUP (terminal hangup)
// must too — the detached children deliberately left the terminal's
// foreground process group and would otherwise survive the runner's death.
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);

const build = run(buildCommand, () => {
  process.exitCode = 1;
});
build.on("exit", (code) => {
  if (process.exitCode === undefined && code !== 0) {
    process.exitCode = code ?? 1;
    return;
  }
  if (process.exitCode !== undefined) return;
  // Mirror the first service exit's status; the sibling we terminate in
  // response must not overwrite it.
  let settled = false;
  const handleServiceFailure = (serviceCode) => {
    if (!settled) {
      settled = true;
      process.exitCode = serviceCode ?? 1;
    }
    shutdown();
  };
  for (const service of [
    run(apiCommand, () => handleServiceFailure(1)),
    run(uiCommand, () => handleServiceFailure(1)),
  ]) {
    service.on("exit", (serviceCode) => handleServiceFailure(serviceCode));
  }
});
