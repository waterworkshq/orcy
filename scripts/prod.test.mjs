// Stub-command regression check for scripts/prod.mjs: the build must finish
// (successfully) before either service starts, and a failed build must start
// neither service and exit nonzero. Run: node --test scripts/prod.test.mjs
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const prodScript = fileURLToPath(new URL("./prod.mjs", import.meta.url));
const execFileAsync = promisify(execFile);

function stub(logPath, line, exitCode = 0) {
  return `node -e "require('fs').appendFileSync('${logPath}','${line}\\n');process.exit(${exitCode})"`;
}

// A stub that waits for a sentinel line before logging its own: the runner
// kills the sibling's process group as soon as ONE service exits, so without
// the chain the first stub to exit can terminate the other before it logs.
function stubAfter(logPath, waitFor, line, exitAfter = null) {
  const tail =
    exitAfter === null
      ? ""
      : ` while (!fs.readFileSync(log, "utf8").includes(${JSON.stringify(exitAfter)})) { ` +
        `if (Date.now() > deadline) process.exit(1); ` +
        `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }`;
  return (
    `node -e 'const fs = require("fs"); const log = ${JSON.stringify(logPath)}; ` +
    `const deadline = Date.now() + 10_000; ` +
    `while (!fs.readFileSync(log, "utf8").includes(${JSON.stringify(waitFor)})) { ` +
    `if (Date.now() > deadline) process.exit(1); ` +
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); } ` +
    `fs.appendFileSync(log, ${JSON.stringify(line + "\n")});${tail}'`
  );
}

async function runProd(logPath, buildExitCode, overrides = {}) {
  const env = {
    ...process.env,
    ORCY_PROD_BUILD: stub(logPath, "build", buildExitCode),
    // The API stub stays up until the UI has logged, so the first service
    // exit (UI's) can never kill the API group before both lines exist.
    ORCY_PROD_API: overrides.api ?? stubAfter(logPath, "build", "api_started", "ui_started"),
    ORCY_PROD_UI: overrides.ui ?? stubAfter(logPath, "api_started", "ui_started"),
  };
  try {
    await execFileAsync("node", [prodScript], { env });
    return 0;
  } catch (error) {
    return error.code ?? 1;
  }
}

test("successful build starts both services only after it completes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "orcy-prod-log-"));
  const logPath = path.join(dir, "events");
  await writeFile(logPath, "");
  const exitCode = await runProd(logPath, 0);
  const events = (await readFile(logPath, "utf8")).trim().split("\n");
  assert.equal(exitCode, 0);
  assert.equal(events[0], "build");
  assert.deepEqual(events.slice(1).toSorted(), ["api_started", "ui_started"]);
  await rm(dir, { recursive: true, force: true });
});

test("failed build starts neither service and exits nonzero", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "orcy-prod-log-"));
  const logPath = path.join(dir, "events");
  await writeFile(logPath, "");
  const exitCode = await runProd(logPath, 1);
  const events = (await readFile(logPath, "utf8")).trim();
  assert.equal(exitCode, 1);
  assert.equal(events, "build");
  await rm(dir, { recursive: true, force: true });
});

test("a service exit terminates the sibling's whole process group, grandchildren included", async () => {
  // The API stub spawns a long-lived GRANDCHILD (as a real service spawns
  // pnpm -> node); the UI stub exits, which must take down the API stub's
  // entire process group — killing only the /bin/sh wrapper (the pre-fix
  // behavior) leaves the grandchild alive.
  const dir = await mkdtemp(path.join(tmpdir(), "orcy-prod-log-"));
  const logPath = path.join(dir, "events");
  await writeFile(logPath, "");
  const apiStub =
    `node -e 'const { spawn } = require("child_process"); ` +
    `const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" }); ` +
    `require("fs").appendFileSync(${JSON.stringify(logPath)}, "api_started grandchild " + grandchild.pid + "\\n"); ` +
    `setInterval(() => {}, 1 << 30);'`;
  const uiStub = stubAfter(logPath, "api_started", "ui_started");
  const env = {
    ...process.env,
    ORCY_PROD_BUILD: stub(logPath, "build"),
    ORCY_PROD_API: apiStub,
    ORCY_PROD_UI: uiStub,
  };
  let exitCode;
  try {
    await execFileAsync("node", [prodScript], { env });
    exitCode = 0;
  } catch (error) {
    exitCode = error.code ?? 1;
  }
  assert.equal(exitCode, 0);

  const events = (await readFile(logPath, "utf8")).trim().split("\n");
  assert.equal(events[0], "build");
  assert.ok(events.includes("ui_started"), `ui line missing: ${events.join(" | ")}`);
  const apiLine = events.find((entry) => entry.startsWith("api_started grandchild "));
  assert.ok(apiLine, `api grandchild line missing: ${events.join(" | ")}`);

  const grandchildPid = Number(apiLine.split(" ")[2]);
  assert.ok(Number.isInteger(grandchildPid), `grandchild pid not logged: ${events.join(" | ")}`);
  // The process-group SIGTERM ran before the runner exited; allow a short
  // reaping window, then the pid must be gone (kill(pid, 0) throws ESRCH).
  const deadline = Date.now() + 2_000;
  let alive = true;
  while (Date.now() < deadline) {
    try {
      process.kill(grandchildPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      alive = false;
      break;
    }
  }
  assert.equal(alive, false, "grandchild survived the sibling-exit shutdown — process group not signaled");
  await rm(dir, { recursive: true, force: true });
});

test("a terminal hangup (SIGHUP) reaches the service groups too", async () => {
  // The detached children deliberately left the terminal's foreground
  // process group, so a hangup that bypasses shutdown() would orphan them.
  // Without the SIGHUP handler the runner dies instantly and the API stub's
  // grandchild survives.
  const dir = await mkdtemp(path.join(tmpdir(), "orcy-prod-log-"));
  const logPath = path.join(dir, "events");
  await writeFile(logPath, "");
  const apiStub =
    `node -e 'const { spawn } = require("child_process"); ` +
    `const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" }); ` +
    `require("fs").appendFileSync(${JSON.stringify(logPath)}, "api_started grandchild " + grandchild.pid + "\\n"); ` +
    `setInterval(() => {}, 1 << 30);'`;
  const uiStub = `node -e 'setInterval(() => {}, 1 << 30);'`;
  const env = {
    ...process.env,
    ORCY_PROD_BUILD: stub(logPath, "build"),
    ORCY_PROD_API: apiStub,
    ORCY_PROD_UI: uiStub,
  };
  const child = spawn("node", [prodScript], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));

  let grandchildPid = null;
  try {
    const waitDeadline = Date.now() + 10_000;
    let apiLine = null;
    while (Date.now() < waitDeadline && !apiLine) {
      const text = await readFile(logPath, "utf8");
      apiLine = text.split("\n").find((entry) => entry.startsWith("api_started grandchild ")) ?? null;
      if (!apiLine) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(apiLine, "api stub never logged its grandchild");
    grandchildPid = Number(apiLine.split(" ")[2]);

    child.kill("SIGHUP");
    let hangupTimer;
    const hangupExit = await Promise.race([
      exited,
      new Promise((resolve) => {
        hangupTimer = setTimeout(() => resolve("timeout"), 10_000);
      }),
    ]);
    clearTimeout(hangupTimer);
    assert.notEqual(hangupExit, "timeout", "runner did not exit after SIGHUP");

    const deadline = Date.now() + 2_000;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(grandchildPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        alive = false;
        break;
      }
    }
    assert.equal(alive, false, "grandchild survived the SIGHUP shutdown — hangup bypassed the service groups");
  } finally {
    // A failed assertion must not leak the runner or the stub processes (the
    // orphaned, pipe-inheriting stubs would hang the harness).
    child.kill("SIGKILL");
    if (grandchildPid !== null) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("a service that ignores SIGTERM is force-killed after the grace window", async () => {
  // The API stub traps SIGTERM and keeps running; the sibling UI exit starts
  // shutdown, and after the runner's grace window the group must be SIGKILLed
  // — the runner never exits while a service still holds its group.
  const dir = await mkdtemp(path.join(tmpdir(), "orcy-prod-log-"));
  const logPath = path.join(dir, "events");
  await writeFile(logPath, "");
  const apiStub =
    `node -e 'process.on("SIGTERM", () => {}); ` +
    `const fs = require("fs"); ` +
    `fs.appendFileSync(${JSON.stringify(logPath)}, "api_started " + process.pid + "\\n"); ` +
    `setInterval(() => {}, 1 << 30);'`;
  const env = {
    ...process.env,
    ORCY_PROD_BUILD: stub(logPath, "build"),
    ORCY_PROD_API: apiStub,
    ORCY_PROD_UI: stubAfter(logPath, "api_started", "ui_started"),
  };
  const startedAt = Date.now();
  const child = spawn("node", [prodScript], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));

  let stubbornPid = null;
  try {
    const waitDeadline = Date.now() + 10_000;
    let apiLine = null;
    while (Date.now() < waitDeadline && !apiLine) {
      const text = await readFile(logPath, "utf8");
      apiLine = text.split("\n").find((entry) => entry.startsWith("api_started ")) ?? null;
      if (!apiLine) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(apiLine, "api stub never logged");
    stubbornPid = Number(apiLine.split(" ")[1]);

    let exitTimer;
    const exitCode = await Promise.race([
      exited,
      new Promise((resolve) => {
        exitTimer = setTimeout(() => resolve("timeout"), 15_000);
      }),
    ]);
    clearTimeout(exitTimer);
    assert.notEqual(exitCode, "timeout", "runner never exited");
    assert.equal(exitCode, 0);

    // The stubborn group must be dead by now (SIGKILL after the 5 s grace) and
    // the runner must not have exited before the grace window elapsed.
    let dead = false;
    try {
      process.kill(stubbornPid, 0);
    } catch {
      dead = true;
    }
    assert.equal(dead, true, "stubborn service still alive after grace — no SIGKILL escalation");
    assert.ok(Date.now() - startedAt >= 5_000, "runner exited before the grace window elapsed");
  } finally {
    // A failed assertion must not leak the runner or the SIGTERM-trapping
    // stub (which ignores shutdown signals by construction).
    child.kill("SIGKILL");
    if (stubbornPid !== null) {
      try {
        process.kill(stubbornPid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
});
