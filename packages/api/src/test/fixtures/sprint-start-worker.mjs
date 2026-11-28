import { sql } from 'drizzle-orm';
import { initDb, closeDb, getDb } from '../../db/index.ts';
import { startSprint } from '../../services/sprintService.ts';
import { sseBroadcaster } from '../../sse/broadcaster.ts';
import { getById } from '../../repositories/sprint.ts';

await initDb(process.argv[2]);
const db = getDb();
const habitatId = getById(process.argv[3]).habitatId;
let reads = 0;
const select = db.select.bind(db);
db.select = (...args) => { reads++; return select(...args); };
const transaction = db.transaction.bind(db);
db.transaction = (callback, config) => transaction(tx => {
  const txSelect = tx.select.bind(tx);
  tx.select = (...args) => { reads++; return txSelect(...args); };
  return callback(tx);
}, config);
let starts = 0;
const unsubscribe = sseBroadcaster.subscribe(habitatId, event => { if (event.type === 'sprint.started') starts++; });
process.send({ type: 'ready' });
process.on('message', command => {
  if (command === 'probe') {
    db.run(sql`PRAGMA busy_timeout = 0`);
    try {
      startSprint(process.argv[3]);
      process.send({ type: 'probe', outcome: 'started', reads, starts });
    } catch (error) {
      process.send({ type: 'probe', outcome: 'error', code: error.code, operation: error.operation,
        entityId: error.entityId, causeCode: error.cause?.code, reads, starts });
    }
    db.run(sql`PRAGMA busy_timeout = 5000`);
    return;
  }
  try {
    const sprint = startSprint(process.argv[3]);
    process.send({ type: 'result', outcome: 'started', id: sprint.id, starts });
  } catch (error) {
    process.send({ type: 'result', outcome: 'error', status: error.statusCode, message: error.message, starts });
  }
  unsubscribe();
  closeDb();
  process.disconnect();
});
