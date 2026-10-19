/** Optional native work regression: requires cc; excluded from the default suite. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type BetterSqlite3 from "better-sqlite3";
import { closeDb, getDb, initDb } from "../db/index.js";
import { getDeliveryAttemptsByHabitat } from "../repositories/notificationDeliveryAttempt.js";

type NativeDb = BetterSqlite3.Database;
type NativeStatement = BetterSqlite3.Statement;
interface Counters {
  matches: number;
  vmSteps: number;
  fullscanSteps: number;
  sorts: number;
  autoindexRows: number;
  runs: number;
}
interface Work {
  vmSteps: number;
  statements: Array<Counters & { sql: string }>;
}
const PAYLOAD = "x".repeat(1024);
const START = Date.UTC(2026, 0, 1);
const require = createRequire(import.meta.url);
let ownedDirectory = "";
let extensionPath = "";
const measurements: Array<Work & { history: number; limit: number; ids: string[]; rowSha256: string }> = [];
function fixtureId(namespace: number, ordinal: number): string {
  return `${namespace.toString(16).padStart(8, "0")}-0000-4000-8000-${ordinal.toString(16).padStart(12, "0")}`;
}
const habitatId = fixtureId(3, 0);
const eventId = fixtureId(5, 0);

beforeAll(() => {
  if (process.platform === "win32") {
    throw new Error("This optional native work test requires a Unix cc shared-library toolchain");
  }
  ownedDirectory = mkdtempSync(join(tmpdir(), "orcy-notification-query-work-"));
  const packageRoot = dirname(require.resolve("better-sqlite3/package.json"));
  extensionPath = join(ownedDirectory, process.platform === "darwin" ? "orcystmtstatus.dylib" : "orcystmtstatus.so");
  execFileSync("cc", [
    "-std=c99", "-Wall", "-Wextra", "-Werror", "-fPIC",
    process.platform === "darwin" ? "-dynamiclib" : "-shared",
    "-I", join(packageRoot, "deps", "sqlite3"),
    fileURLToPath(new URL("./fixtures/notification-query-stmt-status.c", import.meta.url)),
    "-o", extensionPath,
  ], { timeout: 30_000, stdio: "pipe" });
}, 30_000);

afterAll(() => {
  try {
    if (process.env.ORCY_NOTIFICATION_QUERY_EVIDENCE) {
      const ratios = [1, 100].map(limit => {
        const small = measurements.find(row => row.history === 1000 && row.limit === limit);
        const large = measurements.find(row => row.history === 10000 && row.limit === limit);
        return { limit, smallSteps: small?.vmSteps, largeSteps: large?.vmSteps,
          ratio: small && large ? large.vmSteps / small.vmSteps : null };
      });
      writeFileSync(process.env.ORCY_NOTIFICATION_QUERY_EVIDENCE, JSON.stringify({
        completeMeasurements: measurements.length === 4, measurements, ratios,
      }, null, 2));
    }
  } finally {
    closeDb();
    if (ownedDirectory) rmSync(ownedDirectory, { recursive: true, force: true });
  }
});

function seedHistory(sqlite: NativeDb, count: number): void {
  const created = new Date(START).toISOString();
  sqlite.prepare("INSERT INTO habitats(id,name,created_at,updated_at) VALUES(?,?,?,?)")
    .run(habitatId, "Native query work", created, created);
  sqlite.prepare(`INSERT INTO notification_events
    (id,habitat_id,event_type,source_type,severity,title,body,payload,created_by_type,created_at)
    VALUES(?,?,'task.assigned','task','info','Native query work','Fixture','{}','system',?)`)
    .run(eventId, habitatId, created);
  const insertDelivery = sqlite.prepare(`INSERT INTO notification_deliveries
    (id,event_id,habitat_id,recipient_type,recipient_id,channels,created_at,updated_at)
    VALUES(?,?,?,'human',?,'["webhook"]',?,?)`);
  const insertAttempt = sqlite.prepare(`INSERT INTO notification_delivery_attempts
    (id,delivery_id,channel,status,created_at,response_body)
    VALUES(?,?,'webhook','failed',?,?)`);
  sqlite.transaction(() => {
    for (let n = 0; n < count; n++) {
      const deliveryId = fixtureId(1, Math.floor(n / 10));
      if (n % 10 === 0) insertDelivery.run(deliveryId, eventId, habitatId, fixtureId(6, 0), created, created);
      insertAttempt.run(fixtureId(2, n), deliveryId, new Date(START + n * 1000).toISOString(), PAYLOAD);
    }
  })();
}

function measureActualReader(sqlite: NativeDb, history: number, limit: number): Work {
  const originalPrepare = sqlite.prepare;
  const retained: NativeStatement[] = [];
  // This observer is prepared outside the wrapper and never counted as repository work.
  const observer = originalPrepare.call(sqlite, "SELECT probe_stmt_status(?,?) AS counters") as NativeStatement;
  sqlite.prepare = ((source: string) => {
    const statement = originalPrepare.call(sqlite, source);
    retained.push(statement);
    return statement;
  }) as NativeDb["prepare"];
  function read(source: string, reset: 0 | 1): Counters {
    const value = observer.get(source, BigInt(reset)) as { counters: string };
    const counters = JSON.parse(value.counters) as Counters;
    expect(counters.matches, "Actual native statement must remain retained").toBeGreaterThan(0);
    for (const counter of Object.values(counters)) {
      expect(Number.isSafeInteger(counter) && counter >= 0, "Invalid native counter evidence").toBe(true);
    }
    return counters;
  }
  function capturedWork(): Work {
    const statements = [...new Set(retained.map(statement => statement.source))]
      .map(source => ({ sql: source, ...read(source, 0) }));
    const executed = statements.filter(statement => statement.runs > 0);
    if (executed.length === 0) throw new Error("No observed repository statement executed");
    for (const statement of executed) expect(statement.vmSteps).toBeGreaterThan(0);
    return { vmSteps: executed.reduce((sum, statement) => sum + statement.vmSteps, 0), statements };
  }
  try {
    // Discover actual repository statements; production SQL is never copied into this test.
    getDeliveryAttemptsByHabitat(habitatId, { limit });
    expect(retained.length, "Native prepare capture must observe the public reader").toBeGreaterThan(0);
    for (const source of new Set(retained.map(statement => statement.source))) read(source, 1);
    // A no-op operation must fail evidence admission even though warm statements exist.
    expect(() => capturedWork()).toThrow("No observed repository statement executed");
    const rows = getDeliveryAttemptsByHabitat(habitatId, { limit });
    const work = capturedWork();
    const expected = Array.from({ length: limit }, (_, offset) => {
      const n = history - 1 - offset;
      return {
        id: fixtureId(2, n), deliveryId: fixtureId(1, Math.floor(n / 10)),
        channel: "webhook", destinationId: null, status: "failed", attempt: 1,
        statusCode: null, error: null, responseBody: PAYLOAD, nextRetryAt: null,
        createdAt: new Date(START + n * 1000).toISOString(), finishedAt: null,
      };
    });
    expect(rows).toEqual(expected);
    const measurement = {
      history, limit, ...work, ids: rows.map(row => row.id),
      rowSha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    };
    measurements.push(measurement);
    console.info("notification-query-native-work", JSON.stringify(measurement));
    return work;
  } finally {
    sqlite.prepare = originalPrepare;
  }
}

async function measureHistory(history: number): Promise<Map<number, Work>> {
  try {
    await initDb(join(ownedDirectory, `history-${history}.sqlite`));
    const sqlite = (getDb() as unknown as { $client: NativeDb }).$client;
    expect(typeof sqlite.prepare).toBe("function");
    // The installed driver supports an explicit entrypoint; its older type
    // package declares only the path argument.
    const loadExtension = sqlite.loadExtension.bind(sqlite) as (path: string, entrypoint: string) => NativeDb;
    loadExtension(extensionPath, "sqlite3_orcystmtstatus_init");
    seedHistory(sqlite, history);
    return new Map([1, 100].map(limit => [limit, measureActualReader(sqlite, history, limit)]));
  } finally {
    closeDb();
  }
}

describe("optional native delivery monitor query work", () => {
  it("keeps public-reader VM work bounded while dense newest history grows tenfold", async () => {
    const small = await measureHistory(1000);
    const large = await measureHistory(10000);
    for (const limit of [1, 100]) {
      const smallSteps = small.get(limit)!.vmSteps;
      const largeSteps = large.get(limit)!.vmSteps;
      expect.soft(largeSteps, JSON.stringify({ limit, smallSteps, largeSteps, ratio: largeSteps / smallSteps }))
        .toBeLessThanOrEqual(smallSteps * 2);
    }
  }, 60_000);
});
