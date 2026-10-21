/**
 * Test-only worker-cadence override: when `ORCY_TEST_TICK_MS` is set to a
 * positive integer, background delivery workers start with that tick instead
 * of their production default. Inert in every boot that does not set the
 * variable — production cadences stay the frozen constants in the owning
 * modules (`NOTIFICATION_WORKER_TICK_MS`, `WEBHOOK_RETRY_TICK_MS`).
 */
export function workerTickMs(defaultMs: number): number {
  const override = Number(process.env.ORCY_TEST_TICK_MS);
  return override > 0 ? override : defaultMs;
}
