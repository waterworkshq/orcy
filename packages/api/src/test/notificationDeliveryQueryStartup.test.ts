import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInstalledApiLayout } from "./compiledApiLayout.js";

let ownedDirectory = "";
beforeEach(() => { ownedDirectory = mkdtempSync(join(tmpdir(), "orcy-notification-startup-")); });
afterEach(() => { if (ownedDirectory) rmSync(ownedDirectory, { recursive: true, force: true }); });

interface StartupReport {
  currentError: string | null;
  originalError: string | null;
  fixtureError?: { message: string };
  currentRows?: { id: string; destinationId: string | null; responseBody: string }[];
  originalRows?: { id: string; destinationId: string | null; responseBody: string }[];
  indexes: string[];
  attemptColumns: string[];
  journalMode: string;
  attestation?: { clean: number; anomaly_report: string };
  upgrade?: {
    beforeRows: unknown[]; afterRows: unknown[];
    beforeLedger: unknown[]; afterLedger: unknown[]; reopenedLedger: unknown[];
    expectedLedger: { hash: string; created_at: number };
    indexes: Record<string, string[]>;
    upgradedRows: unknown[]; reopenedRows: unknown[];
  };
}
function runInstalled(mode: "post-push-before-indexes" | "dirty-additive-startup" | "upgrade-indexes"): StartupReport {
  // Real copies are required: a symlink resolves back into the workspace and
  // would select its current journal instead of this installed-layout fixture.
  const installed = createInstalledApiLayout({ root: ownedDirectory }).packageDir;
  const reportPath = join(ownedDirectory, "report.json");
  try {
    execFileSync(process.execPath, [join(import.meta.dirname, "fixtures", "notification-query-startup.mjs"),
      installed, join(ownedDirectory, "startup.sqlite"), reportPath, mode], {
      cwd: ownedDirectory, env: { ...process.env, NODE_ENV: "production" }, timeout: 60_000, stdio: "pipe",
    });
  } catch (error) {
    if (existsSync(reportPath)) throw new Error(`Native startup fixture failed: ${readFileSync(reportPath, "utf8")}`, { cause: error });
    throw error;
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as StartupReport;
  expect(report.fixtureError, JSON.stringify(report)).toBeUndefined();
  expect(report.journalMode).toBe("wal");
  return report;
}

describe("notification query on real older production startup states", () => {
  it("preserves the working post-push reader when the index migration is not in the installed journal", () => {
    const report = runInstalled("post-push-before-indexes");
    expect(report.indexes).toEqual([]);
    expect(report.attemptColumns).toContain("destination_id");
    expect(report.originalError, JSON.stringify(report)).toBeNull();
    expect(report.originalRows?.map(row => row.id)).toEqual(["startup-z", "startup-a"]);
    expect(report.currentError, JSON.stringify(report)).toBeNull();
    expect(report.currentRows).toEqual(report.originalRows);
  }, 60_000);

  it("records the inherited destination-column limit of an actually deferred dirty additive startup", () => {
    const report = runInstalled("dirty-additive-startup");
    expect(report.indexes).toEqual([]);
    expect(report.attemptColumns).not.toContain("destination_id");
    expect(report.attestation?.clean).toBe(0);
    const anomalies = JSON.parse(report.attestation!.anomaly_report);
    expect(anomalies.code).toBe("TRIAGE_ENFORCEMENT_PREFLIGHT_DIRTY");
    expect(anomalies.blockingAnomalies.some((row: { code: string }) => row.code === "active_identity_duplicate")).toBe(true);
    expect(report.originalError, JSON.stringify(report)).toMatch(/destination_id/);
    // This control does not claim that every endpoint works on the old schema.
    expect(report.currentError).not.toBeNull();
  }, 60_000);

  it("installs the additive indexes on retained native history and reopens without ledger or row churn", () => {
    const report = runInstalled("upgrade-indexes");
    expect(report.indexes).toEqual([]);
    expect(report.originalError).toBeNull();
    expect(report.currentError).toBeNull();
    expect(report.currentRows).toEqual(report.originalRows);
    const upgrade = report.upgrade!;
    expect(upgrade.afterRows).toEqual(upgrade.beforeRows);
    expect(upgrade.afterLedger).toEqual([...upgrade.beforeLedger, upgrade.expectedLedger]);
    expect(upgrade.reopenedLedger).toEqual(upgrade.afterLedger);
    expect(upgrade.indexes).toEqual({
      idx_notification_attempts_created_order: ["created_at", "id", "delivery_id"],
      idx_notification_attempts_channel_created_order: ["channel", "created_at", "id", "delivery_id"],
      idx_notification_deliveries_scope_lookup: ["id", "habitat_id"],
    });
    expect(upgrade.upgradedRows).toEqual(report.originalRows);
    expect(upgrade.reopenedRows).toEqual(report.originalRows);
  }, 60_000);
});
