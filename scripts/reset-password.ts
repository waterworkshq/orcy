import { initDb, getDb } from '../packages/api/src/db/index.js';
import { resetPassword } from '../packages/api/src/lib/reset-password.js';

const username = process.argv[2];
const newPassword = process.argv[3];

(async () => {
  await initDb();
  const db = getDb();
  const message = await resetPassword(username, newPassword, db);
  console.log(message);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
