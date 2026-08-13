/**
 * Sliding-window rate limiter for Plugin Signal Detectors (ADR-0015, PLG-5).
 *
 * Enforces manifest-declared `rateLimitDefaults`:
 *  - `maxDetectionsPerMinute`: sliding 60-second window on detector invocations.
 *  - `maxSignalsPerHour`: sliding 3600-second window on emitted pulse signals.
 */

interface SignalEmissionRecord {
  timestamp: number;
  count: number;
}

const detectionInvocations = new Map<string, number[]>();
const signalEmissions = new Map<string, SignalEmissionRecord[]>();

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function makeKey(habitatId: string, canonicalKey: string): string {
  return `${habitatId}::${canonicalKey}`;
}

/**
 * Checks if a detector invocation is admitted under its `maxDetectionsPerMinute`
 * limit and records the invocation timestamp if admitted.
 *
 * @returns `true` if admitted, `false` if rate-limited.
 */
export function checkAndRecordDetection(
  habitatId: string,
  canonicalKey: string,
  maxPerMinute: number,
  nowMs: number = Date.now(),
): boolean {
  if (maxPerMinute <= 0) return false;
  const key = makeKey(habitatId, canonicalKey);
  const cutoff = nowMs - MINUTE_MS;

  const timestamps = detectionInvocations.get(key) ?? [];
  const recent = timestamps.filter((t) => t > cutoff);

  if (recent.length >= maxPerMinute) {
    detectionInvocations.set(key, recent);
    return false;
  }

  recent.push(nowMs);
  detectionInvocations.set(key, recent);
  return true;
}

/**
 * Checks if a detector has headroom under its `maxSignalsPerHour` limit.
 *
 * @returns `true` if within quota, `false` if signal quota is exhausted.
 */
export function checkSignalHourQuota(
  habitatId: string,
  canonicalKey: string,
  maxPerHour: number,
  nowMs: number = Date.now(),
): boolean {
  if (maxPerHour <= 0) return false;
  const key = makeKey(habitatId, canonicalKey);
  const cutoff = nowMs - HOUR_MS;

  const records = signalEmissions.get(key) ?? [];
  const recent = records.filter((r) => r.timestamp > cutoff);
  signalEmissions.set(key, recent);

  const totalEmitted = recent.reduce((sum, r) => sum + r.count, 0);
  return totalEmitted < maxPerHour;
}

/**
 * Records newly emitted signals against the detector's hourly window.
 */
export function recordSignalsEmitted(
  habitatId: string,
  canonicalKey: string,
  count: number,
  nowMs: number = Date.now(),
): void {
  if (count <= 0) return;
  const key = makeKey(habitatId, canonicalKey);
  const cutoff = nowMs - HOUR_MS;

  const records = signalEmissions.get(key) ?? [];
  const recent = records.filter((r) => r.timestamp > cutoff);
  recent.push({ timestamp: nowMs, count });
  signalEmissions.set(key, recent);
}

/**
 * Resets all in-memory detector rate tracking state (called during `resetPlugins()`).
 */
export function resetDetectorRateLimits(): void {
  detectionInvocations.clear();
  signalEmissions.clear();
}
