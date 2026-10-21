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

const children = new Set();

function run(command) {
  const child = spawn(command, { shell: true, stdio: "inherit" });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

function shutdown() {
  for (const child of children) child.kill("SIGTERM");
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const build = run(buildCommand);
build.on("exit", (code) => {
  if (code !== 0) {
    process.exitCode = code ?? 1;
    return;
  }
  // Mirror the first service exit's status; the sibling we terminate in
  // response must not overwrite it.
  let settled = false;
  for (const service of [run(apiCommand), run(uiCommand)]) {
    service.on("exit", (serviceCode) => {
      if (!settled) {
        settled = true;
        process.exitCode = serviceCode ?? 1;
      }
      shutdown();
    });
  }
});
