import { initDb, closeDb } from "../../db/index.js";
import { initDaemonWiring } from "../../daemon-wiring.js";
import * as engine from "../../services/daemonEngine.js";
import * as repo from "../../repositories/daemon.js";
import { createDaemonStopIntent } from "../../services/daemonOwnerWitness.js";

const [path, initialDaemonId, mode] = process.argv.slice(2);
let daemonId = initialDaemonId;
const RealDate = Date;
const fixed = RealDate.parse("2026-11-28T00:00:00.000Z");
class FixedDate extends RealDate {
  constructor(value?: string | number | Date) { super(value === undefined ? fixed : value instanceof RealDate ? value.getTime() : value); }
  static now() { return fixed; }
}
globalThis.Date = FixedDate as unknown as DateConstructor;
try {
  await initDb(path);
  await initDaemonWiring();
  if (!mode || mode === "register") {
    const registered = engine.register("verified-owner", [], 1, mode === "register" ? ["claude-code"] : []);
    if (registered.agents.length !== (mode === "register" ? 1 : 0)) throw new Error("synthetic registration failed");
    daemonId = registered.daemonId;
  }
  if (mode === "reserve") {
    const old = repo.getDaemonById(daemonId)?.stopIntent;
    if (!old || !repo.reserveDaemonStart(daemonId, old, createDaemonStopIntent())) throw new Error("start reservation failed");
  } else {
    engine.start(daemonId);
    if (mode !== "start") {
      let failed = false;
      try { await engine.stop(daemonId); } catch { failed = true; }
      if (!failed) throw new Error("offline write should have failed");
    }
  }
  await new Promise<void>((resolve, reject) => process.send!({ type: "ready", ...(!mode || mode === "register" ? { daemonId } : {}) }, (error) => error ? reject(error) : resolve()));
  process.on("message", (message) => {
    if (message === "exit") {
      closeDb();
      process.disconnect?.();
      process.exit(0);
    }
  });
} catch (error) {
  if (process.send) await new Promise<void>((resolve) => process.send!({ type: "error", message: String(error) }, () => resolve()));
  process.exit(1);
}
