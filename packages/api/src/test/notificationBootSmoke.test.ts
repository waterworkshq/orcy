/**
 * Notification V2 push restoration — PRODUCTION boot smoke.
 *
 * Proves the delivery worker is started by the ACTUAL production owner path:
 * the `onLocalPrefixesRegistered` operational callback in `src/index.ts`
 * (compiled `dist/index.js`), launched by `node` exactly like the installer
 * shim — not by direct worker construction.
 *
 * A due notification unit seeded into an isolated database (post-epoch
 * delivery + authorized registry destination) must be claimed and delivered
 * to a LOCAL CONTROLLED RECEIVER (127.0.0.1 HTTP server owned by this test,
 * allowlisted through the documented ORCY_SSRF_ALLOWLIST seam — production
 * SSRF validation itself is untouched) within one worker tick (60 s). The
 * received request must carry the signed-standard-envelope contract: stable
 * delivery id, `X-Kanban-Signature` verifiable with the subscription secret,
 * `notification:<type>` event name — and the delivery must aggregate to
 * `delivered` in the settled database.
 *
 * The remove-wiring discriminator: deleting the
 * `startNotificationDeliveryWorker()` line from index.ts makes this test
 * fail (no delivery ever fires) — that mutation proof is recorded in the
 * implementation report.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execSync, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
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

const STRONG_JWT = "notification-smoke-jwt-secret-0123456789abcdef0123456789abcdef";
const SUB_SECRET = "notification-smoke-subscription-secret";
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
  url: string | undefined;
  deliveryId: string | undefined;
  signature: string | undefined;
  event: string | undefined;
  body: string;
}

describe("notification V2 push restoration — production boot smoke", () => {
  beforeAll(() => {
    execSync("corepack pnpm --filter @orcy/api build", {
      cwd: WORKSPACE_ROOT,
      stdio: "pipe",
      timeout: 120_000,
    });
  }, 120_000);

  it("the production entrypoint boots the delivery worker: a due unit is claimed and sent to the authorized destination within one tick", async () => {
    const tempDir = join(tmpdir(), `orcy-notify-smoke-${process.pid}-${Date.now()}`);
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
        const header = (name: string) => {
          const value = req.headers[name];
          return Array.isArray(value) ? value[0] : value;
        };
        received.push({
          url: req.url,
          deliveryId: header("x-kanban-delivery"),
          signature: header("x-kanban-signature"),
          event: header("x-kanban-event"),
          body,
        });
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      });
    });
    await new Promise<void>((resolveListen) => receiver.listen(port, "127.0.0.1", resolveListen));

    const DELIVERY_ID = "notify-smoke-delivery-0001";

    try {
      prepareCurrentSchemaDatabase(dbPath);
      const db = new Database(dbPath);
      db.pragma("foreign_keys = ON");

      db.exec(`INSERT INTO habitats (id, name, created_at, updated_at)
        VALUES ('smoke-habitat', 'Smoke Habitat', '${T0}', '${T0}')`);
      db.exec(`INSERT INTO notification_events (id, habitat_id, event_type, source_type, severity, title, body, payload, created_by_type, created_at)
        VALUES ('smoke-event', 'smoke-habitat', 'task.blocked', 'task', 'warning', 'Smoke task blocked', 'Smoke body', '{}', 'system', '${T0}')`);
      // The authorized destination: habitat-scoped subscription opting into
      // the namespaced entry for this notification type.
      db.exec(`INSERT INTO webhook_subscriptions (id, habitat_id, name, url, secret, events, headers, format, enabled, created_at, updated_at)
        VALUES ('smoke-sub', 'smoke-habitat', 'Smoke destination', 'http://127.0.0.1:${port}/hook', '${SUB_SECRET}',
          '["notification:task.blocked"]', '{}', 'standard', 1, '${T0}', '${T0}')`);
      // Post-epoch delivery: push_epoch comes from the storage DEFAULT
      // ('restored') — the insert does not name it, proving the marker on the
      // raw production path.
      db.exec(`INSERT INTO notification_deliveries (id, event_id, habitat_id, recipient_type, recipient_id, status, channels, created_at, updated_at)
        VALUES ('${DELIVERY_ID}', 'smoke-event', 'smoke-habitat', 'human', 'human-1', 'pending', '["webhook"]', '${T0}', '${T0}')`);
      // The frozen unit for the destination, available and due.
      db.exec(`INSERT INTO notification_delivery_channel_states (id, delivery_id, channel_key, base_channel, destination_id, state, created_at, updated_at)
        VALUES ('smoke-unit', '${DELIVERY_ID}', 'webhook:smoke-sub', 'webhook', 'smoke-sub', 'available', '${T0}', '${T0}')`);
      db.close();

      expect(DIST_ENTRY).toBeTruthy();

      const apiPort = await getFreePort();
      const child = spawn(process.execPath, [DIST_ENTRY], {
        env: {
          ...process.env,
          NODE_ENV: "production",
          DB_PATH: dbPath,
          PORT: String(apiPort),
          HOST: "127.0.0.1",
          JWT_SECRET: STRONG_JWT,
          ORCY_REGISTRATION_TOKEN: "notification-smoke-token",
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
          if (received.length > 0) break;
          if (exited) break;
          await new Promise((r) => setTimeout(r, 500));
        }

        expect(
          received,
          `Due notification unit was never fired by the production worker.\n` +
            `stdout:\n${stdout}\nstderr:\n${stderr}`,
        ).toHaveLength(1);
        const hit = received[0];
        expect(hit.url).toBe("/hook");
        // Stable per-delivery retry identity.
        expect(hit.deliveryId).toBe(DELIVERY_ID);
        expect(hit.event).toBe("notification:task.blocked");
        // Signed standard envelope: the signature verifies with the
        // SUBSCRIPTION secret (the trusted DB-derived context).
        const expectedSignature =
          "sha256=" + createHmac("sha256", SUB_SECRET).update(hit.body).digest("hex");
        expect(hit.signature).toBe(expectedSignature);
        const envelope = JSON.parse(hit.body) as {
          id: string;
          event: string;
          data: { deliveryId: string; eventType: string };
        };
        expect(envelope.id).toBe(DELIVERY_ID);
        expect(envelope.event).toBe("notification:task.blocked");
        expect(envelope.data.deliveryId).toBe(DELIVERY_ID);
        expect(envelope.data.eventType).toBe("task.blocked");

        // Settled database state: fenced success, reservation spent, lease
        // released, aggregate delivery completion recorded.
        await new Promise((r) => setTimeout(r, 1_000));
        const verify = new Database(dbPath);
        const unit = verify
          .prepare(
            "SELECT state, reservations_used, lease_fence, push_epoch FROM notification_delivery_channel_states s JOIN notification_deliveries d ON d.id = s.delivery_id WHERE s.id = 'smoke-unit'",
          )
          .get() as { state: string; reservations_used: number; lease_fence: string | null; push_epoch: string };
        const delivery = verify
          .prepare("SELECT status, delivered_at FROM notification_deliveries WHERE id = ?")
          .get(DELIVERY_ID) as { status: string; delivered_at: string | null };
        const attempt = verify
          .prepare("SELECT channel, destination_id, status, attempt FROM notification_delivery_attempts WHERE delivery_id = ?")
          .get(DELIVERY_ID) as { channel: string; destination_id: string; status: string; attempt: number };
        verify.close();
        expect(unit.push_epoch).toBe("restored");
        expect(unit.state).toBe("sent");
        expect(unit.reservations_used).toBe(1);
        expect(unit.lease_fence).toBeNull();
        expect(delivery.status).toBe("delivered");
        expect(delivery.delivered_at).not.toBeNull();
        expect(attempt).toEqual({
          channel: "webhook",
          destination_id: "smoke-sub",
          status: "sent",
          attempt: 1,
        });

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
        expect(cleanExit, `stderr on shutdown:\n${stderr}`).toBe(0);
      } finally {
        if (!exited) child.kill("SIGKILL");
      }
    } finally {
      receiver.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 180_000);
});
