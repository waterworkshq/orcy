import * as pulseRepo from '../repositories/pulse.js';
import * as featureRepo from '../repositories/feature.js';
import { logger } from '../lib/logger.js';

export function emitAutoSignal(opts: {
  featureId: string;
  signalType: string;
  subject: string;
  taskId?: string;
  body?: string;
}): void {
  try {
    const feature = featureRepo.getFeatureById(opts.featureId);
    if (!feature) return;

    pulseRepo.createPulse({
      missionId: opts.featureId,
      boardId: feature.boardId,
      fromType: 'system',
      fromId: 'system',
      signalType: opts.signalType as pulseRepo.SignalType,
      subject: opts.subject,
      body: opts.body ?? '',
      taskId: opts.taskId,
      isAuto: true,
    });
  } catch (err) {
    logger.error({ err, featureId: opts.featureId, signalType: opts.signalType }, 'Failed to emit auto-signal');
  }
}
