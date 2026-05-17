import * as pulseRepo from '../repositories/pulse.js';
import * as missionRepo from '../repositories/mission.js';
import { logger } from '../lib/logger.js';

export function emitAutoSignal(opts: {
  missionId: string;
  signalType: string;
  subject: string;
  taskId?: string;
  body?: string;
}): void {
  try {
    const mission = missionRepo.getMissionById(opts.missionId);
    if (!mission) return;

    pulseRepo.createPulse({
      missionId: opts.missionId,
      habitatId: mission.habitatId,
      fromType: 'system',
      fromId: 'system',
      signalType: opts.signalType as pulseRepo.SignalType,
      subject: opts.subject,
      body: opts.body ?? '',
      taskId: opts.taskId,
      isAuto: true,
    });
  } catch (err) {
    logger.error({ err, missionId: opts.missionId, signalType: opts.signalType }, 'Failed to emit auto-signal');
  }
}
