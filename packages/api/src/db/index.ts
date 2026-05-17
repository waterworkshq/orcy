import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema/index.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { ORCY_PATHS } from '@orcy/shared';
import { createHash } from 'crypto';
import { setDriver } from './dialect-helpers.js';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { seedGlobalTemplates } from '../repositories/template.js';
import { sql } from 'drizzle-orm';
import { logger } from '../lib/logger.js';

type DrizzleDb = BetterSQLite3Database<typeof schema>;

const __dirname = dirname(fileURLToPath(import.meta.url));

function findWorkspaceRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export function getWorkspaceRoot(): string {
  return findWorkspaceRoot(__dirname);
}

export function getDefaultDbPath(): string {
  if (!existsSync(ORCY_PATHS.home)) {
    mkdirSync(ORCY_PATHS.home, { recursive: true });
  }
  return ORCY_PATHS.databaseFile;
}

let _drizzleDb: DrizzleDb | null = null;
let _sqlite: import('better-sqlite3').Database | null = null;

export function getDb(): DrizzleDb {
  if (_drizzleDb) return _drizzleDb;
  throw new Error('Database not initialized. Call initDb() first.');
}

export async function initDb(dbPath?: string) {
  const Database = (await import('better-sqlite3')).default;
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');

  const path = dbPath || process.env.DB_PATH || getDefaultDbPath();

  _sqlite = new Database(path);
  _sqlite.pragma('journal_mode = WAL');
  _sqlite.pragma('foreign_keys = ON');

  _drizzleDb = drizzle(_sqlite, { schema });
  setDriver('sqlite');

  const migrationFolder = join(getWorkspaceRoot(), 'packages', 'api', 'drizzle');
  const productionMigrationFolder = join(__dirname, '..', '..', 'drizzle');

  if (existsSync(migrationFolder)) {
    const hasOldMigrations = _drizzleDb.get(sql`SELECT name FROM sqlite_master WHERE type='table' AND name='__migrations'`);
    if (hasOldMigrations) {
      const journalPath = join(migrationFolder, 'meta', '_journal.json');
      if (existsSync(journalPath)) {
        const journal = JSON.parse(readFileSync(journalPath, 'utf-8'));
        const firstEntry = journal.entries[0];
        if (firstEntry) {
          const migrationFile = join(migrationFolder, `${firstEntry.tag}.sql`);
          if (existsSync(migrationFile)) {
            const migrationContent = readFileSync(migrationFile, 'utf-8');
            const hash = createHash('sha256').update(migrationContent).digest('hex');
            _drizzleDb.run(sql`INSERT OR IGNORE INTO __drizzle_migrations (hash, created_at) VALUES (${hash}, ${firstEntry.when})`);
          }
        }
      }
    }
    migrate(_drizzleDb, { migrationsFolder: migrationFolder });
  } else if (existsSync(productionMigrationFolder)) {
    migrate(_drizzleDb, { migrationsFolder: productionMigrationFolder });
  }

  if (process.env.NODE_ENV !== 'production') {
    await seedDefaultUser();
  }
  seedGlobalTemplates();

  return _drizzleDb;
}

export async function initTestDb() {
  const initSqlJs = (await import('sql.js')).default;
  const { drizzle } = await import('drizzle-orm/sql-js');

  const SQL = await initSqlJs();
  const testSqlite = new SQL.Database();
  _sqlite = testSqlite as any;

  _drizzleDb = drizzle(testSqlite, { schema }) as any;
  setDriver('sqlite');

  const migrationFolder = join(getWorkspaceRoot(), 'packages', 'api', 'drizzle');
  const migrations = ['0000_schema', '0001_pulse', '0002_task_labels', '0003_pulse_v2_scope', '0004_project_insights', '0005_pulse_reactions', '0006_supreme_stranger', '0007_column_renames'];
  for (const migrationName of migrations) {
    const migrationFile = join(migrationFolder, `${migrationName}.sql`);
    if (!existsSync(migrationFile)) continue;
    const migrationSql = readFileSync(migrationFile, 'utf-8');
    const statements = migrationSql
      .split('--> statement-breakpoint')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    for (const stmt of statements) {
      try {
        testSqlite.run(stmt);
      } catch (err: any) {
        const msg = String(err?.message ?? err ?? '');
        if (!msg.includes('already exists') && !msg.includes('no such table') && !msg.includes('no such column') && !msg.includes('no such index')) throw err;
      }
    }
  }

  await seedDefaultUser();
  seedGlobalTemplates();

  return _drizzleDb;
}

async function seedDefaultUser(): Promise<void> {
  const db = getDb();
  const result = db.select({ count: sql<number>`COUNT(*)` }).from(schema.users).get();
  if ((result?.count ?? 0) > 0) return;

  const passwordHash = await bcrypt.hash('admin123', 10);
  const id = uuidv4();
  const now = new Date().toISOString();

  db.insert(schema.users).values({
    id,
    username: 'admin',
    passwordHash,
    displayName: 'Administrator',
    role: 'admin',
    createdAt: now,
    updatedAt: now,
  }).run();
}

export function closeDb() {
  if (_sqlite) {
    try { _sqlite.close(); } catch (err) { logger.error({ err }, 'Failed to close database connection'); }
  }
  _drizzleDb = null;
  _sqlite = null;
}
