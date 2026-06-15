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

/**
 * Constructs an {@link ISessionManager} backed by the daemon's `SessionManager` class.
 * Callers depend on the interface, not the concrete class — this factory is the
 * only attachment point that wires the concrete implementation.
 */
export function createSessionManager(deps: {
  sessionUpdater: ISessionUpdater;
  apiUrl: string;
  dataDir: string;
  sessionTimeoutSeconds: number;
  onSessionComplete?: (session: ActiveSession) => void;
}): ISessionManager {
  return new SessionManager(deps);
}

/**
 * Constructs an {@link ICliDetector} that probes the host for installed CLI agents.
 */
export function createCliDetector(): ICliDetector {
  return { detectClis: () => detectClisImpl() };
}

/**
 * Constructs an {@link IClaimStrategy} that claims tasks via the daemon HTTP API.
 * Used by the standalone daemon's `PollLoop`.
 */
export function createHttpClaimStrategy(apiClient: DaemonApiClient): IClaimStrategy {
  return new HttpClaimStrategy(apiClient);
}

/**
 * Constructs an {@link IHeartbeatStrategy} that sends agent statuses and session
 * progress via the daemon HTTP API. Used by the standalone daemon's `PollLoop`.
 */
export function createHttpHeartbeatStrategy(apiClient: DaemonApiClient): IHeartbeatStrategy {
  return new HttpHeartbeatStrategy(apiClient);
}
