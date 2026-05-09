import { initDb, getDb } from '../src/db/index.js';

async function migrate() {
  const dbPath = process.env.DB_PATH;
  if (!dbPath) {
    console.error('ERROR: DB_PATH must be set to prevent accidental production DB modification.');
    process.exit(1);
  }
  await initDb(dbPath);
  const db = getDb();
  try {
    db.run(`ALTER TABLE "features" ADD COLUMN "is_archived" integer DEFAULT 0 NOT NULL;`);
    console.log("Migration applied.");
  } catch(e) {
    console.error("Migration failed or already applied.", e);
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
