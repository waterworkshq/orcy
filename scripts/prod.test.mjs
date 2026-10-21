// Stub-command regression check for scripts/prod.mjs: the build must finish
// (successfully) before either service starts, and a failed build must start
// neither service and exit nonzero. Run: node --test scripts/prod.test.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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

async function runProd(logPath, buildExitCode) {
  const env = {
    ...process.env,
    ORCY_PROD_BUILD: stub(logPath, "build", buildExitCode),
    ORCY_PROD_API: stub(logPath, "api_started"),
    ORCY_PROD_UI: stub(logPath, "ui_started"),
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
