import { SessionManager } from "./session/manager.js";
import { detectClis as detectClisImpl } from "./detector.js";
import type {
  ISessionManager,
  ISessionUpdater,
  ICliDetector,
  ActiveSession,
} from "@orcy/shared/types";

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
