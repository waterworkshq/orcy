import { SessionManager } from "./session/manager.js";
import { detectClis as detectClisImpl } from "./detector.js";
import { HttpClaimStrategy } from "./httpClaimStrategy.js";
import { HttpHeartbeatStrategy } from "./httpHeartbeatStrategy.js";
import type {
  ISessionManager,
  ISessionUpdater,
  ICliDetector,
  IClaimStrategy,
  IHeartbeatStrategy,
  ActiveSession,
} from "@orcy/shared/types";
import type { DaemonApiClient } from "./api-client.js";

export function createSessionManager(deps: {
  sessionUpdater: ISessionUpdater;
  apiUrl: string;
  dataDir: string;
  sessionTimeoutSeconds: number;
  onSessionComplete?: (session: ActiveSession) => void;
}): ISessionManager {
  return new SessionManager(deps);
}

export function createCliDetector(): ICliDetector {
  return { detectClis: () => detectClisImpl() };
}

export function createHttpClaimStrategy(apiClient: DaemonApiClient): IClaimStrategy {
  return new HttpClaimStrategy(apiClient);
}

export function createHttpHeartbeatStrategy(apiClient: DaemonApiClient): IHeartbeatStrategy {
  return new HttpHeartbeatStrategy(apiClient);
}
