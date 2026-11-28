import { describe, it, expect } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initDb, closeDb } from '../db/index.js';
import * as habitatRepo from '../repositories/habitat.js';
import * as sprintRepo from '../repositories/sprint.js';

type Message = { type: string; outcome?: string; status?: number; message?: string; starts?: number; code?: string; operation?: string; entityId?: string; causeCode?: string; reads?: number };
function next(child: ChildProcess, type: string): Promise<Message> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: Message) => {
      if (message.type === type) { child.off('message', onMessage); child.off('exit', onExit); resolve(message); }
    };
    const onExit = (code: number | null) => { child.off('message', onMessage); reject(new Error(`worker exited ${code} before ${type}`)); };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

describe('concurrent sprint starts', () => {
  it('serializes competing starts from independent processes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orcy-sprint-start-'));
    const path = join(dir, 'test.db');
    const children: ChildProcess[] = [];
    let lock: Database.Database | undefined;
    try {
      await initDb(path);
      const habitat = habitatRepo.createHabitat({ name: 'Concurrent' });
      const one = sprintRepo.create(habitat.id, { name: 'One', startDate: '2026-01-01', endDate: '2026-01-02', createdBy: 'test' });
      const two = sprintRepo.create(habitat.id, { name: 'Two', startDate: '2026-01-03', endDate: '2026-01-04', createdBy: 'test' });
      closeDb();
      for (const id of [one.id, two.id]) {
        children.push(fork(join(import.meta.dirname, 'fixtures/sprint-start-worker.mjs'), [path, id], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
      }
      await Promise.all(children.map(child => next(child, 'ready')));
      lock = new Database(path);
      lock.exec('BEGIN IMMEDIATE');
      // With an external writer lock held, both independent starts must reach
      // SQLite and fail to reserve the writer before reading either sprint.
      const probes = children.map(child => next(child, 'probe'));
      children.forEach(child => child.send('probe'));
      const blocked = await Promise.all(probes);
      for (const [index, result] of blocked.entries()) {
        expect(result).toMatchObject({ outcome: 'error', code: 'REPOSITORY_ERROR', operation: 'transaction',
          entityId: [one.id, two.id][index], causeCode: 'SQLITE_BUSY', reads: 0, starts: 0 });
      }
      lock.exec('COMMIT');
      const results = children.map(child => next(child, 'result'));
      children.forEach(child => child.send('start'));
      const outcomes = await Promise.all(results);
      expect(outcomes.filter(result => result.outcome === 'started' && result.starts === 1)).toHaveLength(1);
      expect(outcomes.filter(result => result.starts === 0 && result.status === 409 && result.message === 'Habitat already has an active sprint')).toHaveLength(1);
      expect(lock.prepare("SELECT count(*) AS count FROM sprints WHERE habitat_id = ? AND status = 'active'").get(habitat.id)).toEqual({ count: 1 });
    } finally {
      children.forEach(child => { if (child.exitCode === null) child.kill(); });
      if (lock?.inTransaction) lock.exec('ROLLBACK');
      lock?.close();
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
