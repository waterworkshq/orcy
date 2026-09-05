/**
 * Webhook retry restoration — PRODUCTION boot smoke.
 *
 * Proves the retry worker is started by the ACTUAL production owner path: the
 * `onLocalPrefixesRegistered` operational callback in `src/index.ts` (compiled
 * `dist/index.js`), launched by `node` exactly like the installer shim and the
 * systemd unit — not by direct worker/unit construction.
 *
 * A due pending delivery seeded directly into an isolated database must be
 * claimed and delivered to a LOCAL CONTROLLED RECEIVER (127.0.0.1 HTTP server
 * owned by this test, allowlisted through the documented ORCY_SSRF_ALLOWLIST
 * seam — production SSRF validation itself is untouched) within one worker
 * tick (60 s). A disabled-subscription row seeded beside it must receive the
 * fenced terminal disposition in the same pass.
 *
 * The remove-wiring discriminator: deleting the `startWebhookRetryProcessor()`
 * line from index.ts makes this test fail (no delivery ever fires) — that
 * mutation proof is recorded in the implementation report.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import net from "node:net";
import http from "node:http";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { ENFORCEMENT_MIGRATION_TAG } from "../db/stagedMigrations.js";
import {
  ADDITIVE_SCHEMA_VERSION,
  PREFLIGHT_VERSION,
  computeAnomalyQueryDigest,
} from "../services/findingTriagePreflight.js";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..", "..");
const WORKSPACE_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const DIST_ENTRY = join(PACKAGE_ROOT, "dist", "index.js");
const DRIZZLE_DIR = join(PACKAGE_ROOT, "drizzle");

const STRONG_JWT = "webhook-smoke-jwt-secret-0123456789abcdef0123456789abcdef";

const T0 = "2026-01-01T00:00:00.000Z";

function getFreePort(): Promise<number> {
  return new Promise((resolveFn, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolveFn(port));
      } else {
        srv.close();
        reject(new Error("Could not determine free port"));
      }
    });
    srv.on("error", reject);
  });
}

function applyMigrationSql(db: Database.Database, sqlText: string): void {
  const statements = sqlText
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err ?? "");
      if (
        !msg.includes("already exists") &&
        !msg.includes("no such table") &&
        !msg.includes("no such column") &&
        !msg.includes("no such index") &&
        !msg.includes("duplicate column name")
      ) {
        throw err;
      }
    }
  }
}

/** Current-schema database with a complete Drizzle ledger (compiledStartup pattern). */
function prepareCurrentSchemaDatabase(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");

  const schemaFile = join(DRIZZLE_DIR, "0000_schema.sql");
  if (existsSync(schemaFile)) {
    applyMigrationSql(db, readFileSync(schemaFile, "utf-8"));
  }
  const incremental = readdirSync(DRIZZLE_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && f !== "0000_schema.sql")
    .toSorted();
  for (const file of incremental) {
    if (file === `${ENFORCEMENT_MIGRATION_TAG}.sql`) {
      db.prepare(
        `INSERT OR REPLACE INTO migration_preflight_attestations
           (enforcement_migration_id, schema_version, preflight_version,
            anomaly_query_digest, clean, attested_at)
         VALUES (?, ?, ?, ?, 1, datetime('now'))`,
      ).run(
        ENFORCEMENT_MIGRATION_TAG,
        ADDITIVE_SCHEMA_VERSION,
        PREFLIGHT_VERSION,
        computeAnomalyQueryDigest(),
      );
    }
    applyMigrationSql(db, readFileSync(join(DRIZZLE_DIR, file), "utf-8"));
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at NUMERIC
    )
  `);
  const journal = JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf-8"));
  const insertHash = db.prepare(
    "INSERT OR IGNORE INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
  );
  for (const entry of journal.entries) {
    const sqlPath = join(DRIZZLE_DIR, `${entry.tag}.sql`);
    if (existsSync(sqlPath)) {
      const content = readFileSync(sqlPath, "utf-8");
      insertHash.run(createHash("sha256").update(content).digest("hex"), entry.when);
    }
  }

  db.close();
}

interface ReceivedRequest {
  deliveryId: string | undefined;
  body: string;
}

describe("webhook retry restoration — production boot smoke", () => {
  beforeAll(() => {
    execSync("corepack pnpm --filter @orcy/api build", {
      cwd: WORKSPACE_ROOT,
      stdio: "pipe",
      timeout: 120_000,
    });
  }, 120_000);

  it("the production entrypoint boots the retry worker: a due pending delivery is claimed and delivered within one tick", async () => {
    const tempDir = join(tmpdir(), `orcy-webhook-smoke-${process.pid}-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const dbPath = join(tempDir, "smoke.db");
    const port = await getFreePort();

    // Local controlled receiver — no external endpoints are contacted.
    const received: ReceivedRequest[] = [];
    const receiver = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const header = req.headers["x-kanban-delivery"];
        received.push({
          deliveryId: Array.isArray(header) ? header[0] : header,
          body,
        });
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      });
    });
    await new Promise<void>((resolveListen) => receiver.listen(port, "127.0.0.1", resolveListen));

    const DELIVERY_ID = "smoke-delivery-due-0001";
    const DISABLED_DELIVERY_ID = "smoke-delivery-disabled-0002";
    const PAYLOAD = JSON.stringify({
      id: DELIVERY_ID,
      event: "webhook.delivery",
      data: { smoke: true },
    });

    try {
      prepareCurrentSchemaDatabase(dbPath);
      const db = new Database(dbPath);
      db.pragma("foreign_keys = ON");
      const seedSubscription = db.prepare(
        `INSERT INTO webhook_subscriptions
           (id, habitat_id, name, url, secret, events, headers, format, enabled, created_at, updated_at)
         VALUES (?, NULL, ?, ?, NULL, '[]', '{}', 'standard', ?, ?, ?)`,
      );
      seedSubscription.run("smoke-sub-enabled", "Smoke receiver", `http://127.0.0.1:${port}/hook`, 1, T0, T0);
      seedSubscription.run("smoke-sub-disabled", "Smoke disabled", "http://127.0.0.1:9/never", 0, T0, T0);
      const seedDelivery = db.prepare(
        `INSERT INTO webhook_deliveries
           (id, subscription_id, event_type, payload, status, attempts, created_at, next_retry_at)
         VALUES (?, ?, 'webhook.delivery', ?, 'pending', 1, ?, NULL)`,
      );
      // attempts=1 + NULL next_retry_at: the legacy partial state the restored
      // worker must treat as due immediately.
      seedDelivery.run(DELIVERY_ID, "smoke-sub-enabled", PAYLOAD, T0);
      seedDelivery.run(DISABLED_DELIVERY_ID, "smoke-sub-disabled", "{}", T0);
      db.close();

      const apiPort = await getFreePort();
      const child = spawn(process.execPath, [DIST_ENTRY], {
        env: {
          ...process.env,
          NODE_ENV: "production",
          DB_PATH: dbPath,
          PORT: String(apiPort),
          HOST: "127.0.0.1",
          JWT_SECRET: STRONG_JWT,
          ORCY_REGISTRATION_TOKEN: "webhook-smoke-token",
          ORCY_SSRF_ALLOWLIST: "127.0.0.1",
          HOME: tempDir,
          LOG_LEVEL: "error",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      let exited = false;
      let exitCode: number | null = null;
      child.on("exit", (code) => {
        exited = true;
        exitCode = code;
      });

      try {
        // Wait for readiness (the operational callback fires during boot).
        const HEALTH_TIMEOUT = 30_000;
        const healthDeadline = Date.now() + HEALTH_TIMEOUT;
        let ready = false;
        while (Date.now() < healthDeadline) {
          if (exited) {
            throw new Error(
              `Compiled API exited prematurely (code=${exitCode}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            );
          }
          try {
            const res = await fetch(`http://127.0.0.1:${apiPort}/health`);
            if (res.ok) {
              const body = (await res.json()) as { status?: string };
              if (body.status === "ok") {
                ready = true;
                break;
              }
            }
          } catch {
            // not ready yet
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        expect(ready, `API never reached /health.\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(true);

        // The worker's first tick fires one 60 s interval after boot.
        const DELIVERY_TIMEOUT = 100_000;
        const deliveryDeadline = Date.now() + DELIVERY_TIMEOUT;
        while (Date.now() < deliveryDeadline) {
          if (received.some((r) => r.deliveryId === DELIVERY_ID)) break;
          if (exited) break;
          await new Promise((r) => setTimeout(r, 500));
        }

        const delivered = received.find((r) => r.deliveryId === DELIVERY_ID);
        expect(
          delivered,
          `Due pending delivery was never fired by the production worker.\n` +
            `stdout:\n${stdout}\nstderr:\n${stderr}`,
        ).toBeDefined();
        expect(delivered!.body).toBe(PAYLOAD);
        // Only the enabled subscription's row is sent — the disabled row gets
        // a disposition, never an HTTP call.
        expect(received).toHaveLength(1);

        // Settled database state: fenced success, second reservation spent,
        // lease released.
        await new Promise((r) => setTimeout(r, 1_000));
        const verify = new Database(dbPath);
        const row = verify
          .prepare("SELECT status, attempts, lease_fence FROM webhook_deliveries WHERE id = ?")
          .get(DELIVERY_ID) as { status: string; attempts: number; lease_fence: string | null };
        const disabledRow = verify
          .prepare("SELECT status, attempts, response_body FROM webhook_deliveries WHERE id = ?")
          .get(DISABLED_DELIVERY_ID) as {
          status: string;
          attempts: number;
          response_body: string;
        };
        verify.close();
        expect(row).toEqual({ status: "success", attempts: 2, lease_fence: null });
        expect(disabledRow.status).toBe("failed");
        expect(disabledRow.attempts).toBe(1);
        expect(disabledRow.response_body).toBe(
          "Webhook delivery abandoned: subscription is disabled.",
        );

        const cleanExit = await new Promise<number | null>((resolveExit) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolveExit(null);
          }, 10_000);
          child.on("exit", (code) => {
            clearTimeout(timer);
            resolveExit(code);
          });
          child.kill("SIGTERM");
        });
        expect(cleanExit).toBe(0);
      } finally {
        if (!exited) child.kill("SIGKILL");
      }
    } finally {
      receiver.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 180_000);
});
