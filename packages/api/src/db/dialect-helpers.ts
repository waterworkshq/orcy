import { sql } from 'drizzle-orm';

let _driver: 'sqlite' | 'postgres' = 'sqlite';

export function setDriver(driver: 'sqlite' | 'postgres') { _driver = driver; }
export function getDriver() { return _driver; }

export function cycleTimeMinutes(completedAt: any, startedAt: any) {
  if (_driver === 'postgres') {
    return sql`EXTRACT(EPOCH FROM (${completedAt}::timestamp - ${startedAt}::timestamp)) / 60`;
  }
  return sql`ROUND((julianday(${completedAt}) - julianday(${startedAt})) * 1440.0)`;
}

export function nowExpr() {
  if (_driver === 'postgres') return sql`NOW()`;
  return sql`datetime('now')`;
}

export function dateDayExpr(column: any) {
  if (_driver === 'postgres') return sql`date_trunc('day', ${column})`;
  return sql`DATE(${column})`;
}
