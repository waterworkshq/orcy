export type { CreateDaemonInput, DaemonInstancePublic } from "./daemonInstance.js";
export {
  createDaemon,
  getDaemonById,
  getDaemonByTokenHash,
  updateDaemonHeartbeat,
  setDaemonStatus,
  listDaemons,
  deleteDaemon,
} from "./daemonInstance.js";

export type { CreateDaemonAgentInput, DaemonAgentRow } from "./daemonAgent.js";
export {
  createDaemonAgent,
  getDaemonAgentById,
  getDaemonAgentsByDaemonId,
  getDaemonAgentByAgentId,
  updateDaemonAgentStatus,
  isAgentOwnedByDaemon,
} from "./daemonAgent.js";

export type { CreateDaemonSessionInput, DaemonSessionRow } from "./daemonSession.js";
export {
  createDaemonSession,
  getSessionById,
  getSessionsByDaemonId,
  getActiveSessionsByDaemonId,
  getActiveSessionByTaskId,
  updateSessionStatus,
  updateSessionProgress,
} from "./daemonSession.js";
