import { createSessionManager, createCliDetector } from "@orcy/daemon";
import type {
  ISessionManager,
  ICliDetector,
  IClaimStrategy,
  DetectedCli,
} from "@orcy/shared/types";
import { InProcessSessionUpdater } from "./services/inProcessSessionUpdater.js";
import { InProcessClaimStrategy } from "./services/inProcessClaimStrategy.js";
import type { InProcessClaimDeps } from "./services/inProcessClaimStrategy.js";

const sessionManagers = new Map<string, ISessionManager>();
const claimStrategies = new Map<string, IClaimStrategy>();
let cliDetector: ICliDetector | null = null;

export function getSessionManager(daemonId: string, dataDir: string): ISessionManager {
  let sm = sessionManagers.get(daemonId);
  if (sm) return sm;
  sm = createSessionManager({
    sessionUpdater: new InProcessSessionUpdater(),
    apiUrl: "",
    dataDir,
    sessionTimeoutSeconds: 600,
  });
  sessionManagers.set(daemonId, sm);
  return sm;
}

export function getClaimStrategy(deps: InProcessClaimDeps): IClaimStrategy {
  const existing = claimStrategies.get(deps.daemonId);
  if (existing) return existing;
  const strategy = new InProcessClaimStrategy(deps);
  claimStrategies.set(deps.daemonId, strategy);
  return strategy;
}

export function releaseSessionManager(daemonId: string): void {
  sessionManagers.delete(daemonId);
  claimStrategies.delete(daemonId);
}

export function detectClisOnHost(): DetectedCli[] {
  if (!cliDetector) cliDetector = createCliDetector();
  return cliDetector.detectClis();
}

export function shutdownAllWiring(): void {
  for (const sm of sessionManagers.values()) {
    sm.shutdownAll().catch(() => {});
  }
  sessionManagers.clear();
  claimStrategies.clear();
}
