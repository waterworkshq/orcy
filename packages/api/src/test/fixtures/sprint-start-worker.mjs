import { initDb, closeDb } from '../../db/index.ts';
import { startSprint } from '../../services/sprintService.ts';
import { sseBroadcaster } from '../../sse/broadcaster.ts';
import { getById } from '../../repositories/sprint.ts';

await initDb(process.argv[2]);
process.send({ type: 'ready' });
process.on('message', () => {
  process.send({ type: 'attempt' });
  let starts = 0;
  const unsubscribe = sseBroadcaster.subscribe(getById(process.argv[3]).habitatId, event => { if (event.type === 'sprint.started') starts++; });
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
