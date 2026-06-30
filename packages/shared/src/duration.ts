/**
 * Parses a human-readable duration string (e.g. `'7 days'`, `'30 days'`, `'90 days'`,
 * `'6h'`, `'45m'`, `'2w'`) into an ISO timestamp representing `now - duration`.
 *
 * Returns `null` for unparseable input so the caller can choose to skip the filter rather
 * than silently widen the window. Units are matched case-insensitively and tolerate the
 * singular/plural/abbreviated forms of each unit. Sub-millisecond (`ms`) is intentionally
 * NOT supported — the smallest unit is seconds.
 *
 * Extracted from the duplicated copies that previously lived in the `habitatSkill` and
 * `pulse` repositories (both consumers parse a `timeWindow` query param the same way).
 *
 * @param timeWindow The duration string to parse (e.g. `'7 days'`). Falsy → `null`.
 * @param now Override for the current time (defaults to `new Date()`); used by tests.
 */
export function parseDurationWindow(
  timeWindow: string | undefined,
  now: Date = new Date(),
): string | null {
  if (!timeWindow) return null;
  const match = timeWindow
    .trim()
    .match(/^(\d+)\s*(s|sec|seconds?|m|min|mins?|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)$/i);
  if (!match) return null;
  const n = parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  let ms: number;
  if (unit.startsWith("s")) ms = n * 1000;
  else if (unit.startsWith("m")) ms = n * 60 * 1000;
  else if (unit.startsWith("h")) ms = n * 60 * 60 * 1000;
  else if (unit.startsWith("d")) ms = n * 24 * 60 * 60 * 1000;
  else if (unit.startsWith("w")) ms = n * 7 * 24 * 60 * 60 * 1000;
  else return null;
  return new Date(now.getTime() - ms).toISOString();
}
