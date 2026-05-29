import * as pulseRepo from "../repositories/pulse.js";
import * as missionRepo from "../repositories/feature.js";
import { logger } from "../lib/logger.js";

type PulseCreatedHook = (pulse: pulseRepo.Pulse) => void;
const pulseCreatedHooks: PulseCreatedHook[] = [];

export function onPulseCreated(hook: PulseCreatedHook): () => void {
  pulseCreatedHooks.push(hook);
  return () => {
    const idx = pulseCreatedHooks.indexOf(hook);
    if (idx >= 0) pulseCreatedHooks.splice(idx, 1);
  };
}

export function createPulseAndNotify(input: pulseRepo.CreatePulseInput): pulseRepo.Pulse {
  const pulse = pulseRepo.createPulse(input);
  for (const hook of pulseCreatedHooks) {
    try {
      hook(pulse);
    } catch (err) {
      logger.error({ err }, "Pulse created hook failed");
    }
  }
  return pulse;
}

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
      fromType: "system",
      fromId: "system",
      signalType: opts.signalType as pulseRepo.SignalType,
      subject: opts.subject,
      body: opts.body ?? "",
      taskId: opts.taskId,
      isAuto: true,
    });
  } catch (err) {
    logger.error(
      { err, missionId: opts.missionId, signalType: opts.signalType },
      "Failed to emit auto-signal",
    );
  }
}
