/**
 * Test-only worker-cadence override: when `ORCY_TEST_TICK_MS` is set to a
 * positive integer (within Node's setInterval domain), background delivery
 * workers start with that tick instead of their production default. Inert
 * in every boot that does not set the variable — production cadences stay
 * the frozen constants in the owning modules (`NOTIFICATION_WORKER_TICK_MS`,
 * `WEBHOOK_RETRY_TICK_MS`). Non-integers (e.g. `1500.5`), non-finite values
 * (`Infinity`, `NaN`), non-positive values, and anything beyond the 32-bit
 * interval ceiling (where Node silently clamps to 1 ms) are ignored.
 */
export function workerTickMs(defaultMs: number): number {
  const override = Number(process.env.ORCY_TEST_TICK_MS);
  return Number.isInteger(override) && override > 0 && override <= 2_147_483_647
    ? override
    : defaultMs;
}
