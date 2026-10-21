#!/usr/bin/env node
// Production convenience runner: build first, then the API and UI services
// together. A failed build starts neither service and exits nonzero; when a
// service exits, the sibling is terminated and its status becomes the exit
// code. Commands are env-overridable (ORCY_PROD_BUILD/ORCY_PROD_API/ORCY_PROD_UI)
// so the ordering/failure contract is regression-checked with stubs in
// scripts/prod.test.mjs — they are test seams, not operator configuration.
import { spawn } from "node:child_process";

function positiveIntegerEnv(name) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

const buildCommand = process.env.ORCY_PROD_BUILD ?? "corepack pnpm build";
const apiCommand = process.env.ORCY_PROD_API ?? "corepack pnpm start:api";
const uiCommand = process.env.ORCY_PROD_UI ?? "corepack pnpm start:ui";

// A service that ignores SIGTERM (or drains slowly) must not outlive the
// runner by holding its port forever: shutdown escalates to SIGKILL after
// this grace window. The default covers the API's own bounded shutdown
// drains (webhook retry 15 s, notification delivery 15 s, effect deliverer
// 35 s — worst case sequential plus close slack), so escalation only ever
// cuts short a genuinely stuck service. ORCY_PROD_SHUTDOWN_GRACE_MS is a
// test seam (positive integer) to shrink the window in stub checks.
const SHUTDOWN_GRACE_MS = positiveIntegerEnv("ORCY_PROD_SHUTDOWN_GRACE_MS") ?? 65_000;

// Group ids of every spawned command, tracked INDEPENDENTLY of the direct
// child's lifetime: the shell/pnpm wrapper can exit while a draining or
// stubborn descendant still holds the group and its port, so teardown and
// signaling key on the groups, not on child 'exit' events.
const groupPids = new Set();

function run(command, onSpawnError) {
  // Own process group: `shell: true` wraps the command in /bin/sh, and a
  // signal to the wrapper alone leaves the pnpm/node grandchildren running
  // with their ports held. `detached: true` makes each child a process-group
  // leader so shutdown can signal the whole group.
  const child = spawn(command, { shell: true, stdio: "inherit", detached: true });
  if (typeof child.pid === "number") groupPids.add(child.pid);
  // Without an `error` listener a failed spawn throws an uncaught exception
  // and the runner dies without shutting down everything already running.
  child.on("error", (err) => {
    if (typeof child.pid === "number") groupPids.delete(child.pid);
    onSpawnError?.(err);
  });
  return child;
}

function signalGroups(signal) {
  for (const pid of groupPids) {
    try {
      process.kill(-pid, signal);
    } catch {
      /* group already gone */
    }
  }
}

let shutdownStarted = false;
function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  // An interrupted run must not read as success: when no status is recorded
  // yet (signal during the build, or before any service exited), record a
  // failure. A first service exit has already recorded ITS code (0 included
  // — `exitCode = 0` is set, not undefined) before calling shutdown.
  if (process.exitCode === undefined) process.exitCode = 1;
  signalGroups("SIGTERM");
  // Poll the groups themselves: exit promptly once every group is gone, and
  // escalate to SIGKILL for any group still alive after the grace window.
  // The poll keeps the runner open until then.
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  const poll = setInterval(() => {
    let alive = 0;
    for (const pid of [...groupPids]) {
      try {
        process.kill(-pid, 0);
        alive++;
      } catch {
        groupPids.delete(pid);
      }
    }
    if (alive === 0) {
      clearInterval(poll);
      return;
    }
    if (Date.now() >= deadline) {
      signalGroups("SIGKILL");
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
  // Retire the build's group once it is confirmed empty: a group id that
  // outlives its build can be REUSED by an unrelated process group and would
  // then be signaled at shutdown. A group with draining descendants stays.
  if (typeof build.pid === "number") {
    try {
      process.kill(-build.pid, 0);
    } catch {
      groupPids.delete(build.pid);
    }
  }
  // A stop signal that arrived while the build was still running has already
  // run shutdown, and a build spawn failure has already set the exit code —
  // never start services after either.
  if (shutdownStarted || process.exitCode !== undefined) return;
  if (code !== 0) {
    process.exitCode = code ?? 1;
    return;
  }
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
