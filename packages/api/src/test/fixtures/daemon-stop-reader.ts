import jwt from "jsonwebtoken";
import { initDb, closeDb } from "../../db/index.js";
import { createHttpApplication } from "../../httpApp.js";
import { setJwtSecret } from "../../middleware/jwt-verification.js";
import { initDaemonWiring } from "../../daemon-wiring.js";

const [path, id, mode] = process.argv.slice(2);
if (mode === "start") {
  const RealDate = Date;
  const fixed = RealDate.parse("2026-11-28T00:00:00.000Z");
  class FixedDate extends RealDate {
    constructor(value?: string | number | Date) { super(value === undefined ? fixed : value instanceof RealDate ? value.getTime() : value); }
    static now() { return fixed; }
  }
  globalThis.Date = FixedDate as unknown as DateConstructor;
}
const secret = "durable-stop-synthetic-test-secret";
async function send(message: object): Promise<void> {
  if (!process.send) throw new Error("reader requires an IPC channel");
  await new Promise<void>((resolve, reject) => process.send!(message, (error) => error ? reject(error) : resolve()));
}
try {
  await initDb(path);
  setJwtSecret(secret);
  const app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]);
  await app.finalize();
  const headers = { authorization: `Bearer ${jwt.sign({ sub: "admin", username: "admin", role: "admin" }, secret, { issuer: "orcy" })}` };
  if (mode === "start") {
    await initDaemonWiring();
    const start = await app.inject({ method: "POST", url: `/api/daemons/${id}/start`, headers });
    const detail = await app.inject({ method: "GET", url: `/api/daemons/${id}`, headers });
    await send({ startStatus: start.statusCode, detail: detail.json().daemon.status });
    await app.close();
    closeDb();
    process.disconnect?.();
    process.exit(0);
  }
  const list = await app.inject({ method: "GET", url: "/api/daemons", headers });
  const detail = await app.inject({ method: "GET", url: `/api/daemons/${id}`, headers });
  const stop = await app.inject({ method: "POST", url: `/api/daemons/${id}/stop`, headers });
  await send({ list: list.json().daemons.find((daemon: { id: string }) => daemon.id === id).status, detail: detail.json().daemon.status, retryStatus: stop.statusCode });
  await app.close();
  closeDb();
  process.disconnect?.();
  process.exit(0);
} catch (error) {
  if (process.send) await send({ error: String(error) }).catch(() => {});
  process.exitCode = 1;
  process.disconnect?.();
  process.exit(1);
}
