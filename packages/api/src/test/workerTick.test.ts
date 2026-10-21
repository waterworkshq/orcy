/**
 * Discriminating checks for the test-only `ORCY_TEST_TICK_MS` worker-cadence
 * override (lib/workerTick.ts): without the variable the production cadences
 * are the frozen defaults (60 s — the value a production-shaped boot
 * inherits), and only an explicitly set positive integer shrinks the tick.
 * The companion end-to-end proof is the boot-smoke family, which boots the
 * REAL compiled production entry with the variable set and observes
 * delivery-within-N-ticks; boots without it (effectDelivererBootSmoke,
 * daemonRecoveryBootSmoke, compiledStartup) run unchanged on the defaults.
 */
import { describe, it, expect, afterEach } from "vitest";
import { vi } from "vitest";
import { workerTickMs } from "../lib/workerTick.js";
import { NOTIFICATION_WORKER_TICK_MS } from "../repositories/notificationChannelState.js";
import { WEBHOOK_RETRY_TICK_MS } from "../services/webhooks/webhook-delivery.js";

describe("ORCY_TEST_TICK_MS worker cadence override", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is inert without the variable: production cadences stay the frozen 60 s defaults", () => {
    vi.stubEnv("ORCY_TEST_TICK_MS", "");
    expect(workerTickMs(60_000)).toBe(60_000);
    expect(NOTIFICATION_WORKER_TICK_MS).toBe(60_000);
    expect(WEBHOOK_RETRY_TICK_MS).toBe(60_000);
  });

  it("shrinks the tick when the variable is an explicitly set positive integer", () => {
    vi.stubEnv("ORCY_TEST_TICK_MS", "1500");
    expect(workerTickMs(60_000)).toBe(1_500);
    // Integer-valued spellings parse to integers and stay acceptable.
    vi.stubEnv("ORCY_TEST_TICK_MS", "1e3");
    expect(workerTickMs(60_000)).toBe(1_000);
  });

  it("rejects zero, negative, non-integer, non-finite, and interval-overflow values (no silent cadence change)", () => {
    // 1e21 is integer-valued but beyond setInterval's 32-bit domain, where
    // Node silently clamps to a 1 ms interval.
    for (const value of ["0", "-1000", "not-a-number", "1500.5", "Infinity", "NaN", "1e21"]) {
      vi.stubEnv("ORCY_TEST_TICK_MS", value);
      expect(workerTickMs(60_000), value).toBe(60_000);
    }
  });
});
