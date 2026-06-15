import type {
  ISessionManager,
  ISessionUpdater,
  ICliDetector,
  IClaimStrategy,
  DetectedCli,
  ActiveSession,
} from "@orcy/shared/types";
import { InProcessSessionUpdater } from "./services/inProcessSessionUpdater.js";
import { InProcessClaimStrategy } from "./services/inProcessClaimStrategy.js";
import type { InProcessClaimDeps } from "./services/inProcessClaimStrategy.js";

interface DaemonFactoryModule {
  createSessionManager(deps: {
    sessionUpdater: ISessionUpdater;
    apiUrl: string;
    dataDir: string;
    sessionTimeoutSeconds: number;
    onSessionComplete?: (session: ActiveSession) => void;
  }): ISessionManager;
  createCliDetector(): ICliDetector;
}

let factories: DaemonFactoryModule | null = null;
let initPromise: Promise<void> | null = null;

const sessionManagers = new Map<string, ISessionManager>();
const claimStrategies = new Map<string, IClaimStrategy>();
let cliDetector: ICliDetector | null = null;

const DAEMON_MODULE = "@orcy/daemon";

export async function initDaemonWiring(): Promise<void> {
  if (factories) return;
  if (!initPromise) {
    initPromise = import(DAEMON_MODULE).then((mod: unknown) => {
      factories = mod as DaemonFactoryModule;
    });
  }
  await initPromise;
}

function requireFactories(): DaemonFactoryModule {
  if (!factories) {
    throw new Error(
      "daemon-wiring not initialized. Call initDaemonWiring() during API startup before using daemon features.",
    );
  }
  return factories;
}

export function getSessionManager(daemonId: string, dataDir: string): ISessionManager {
  const cached = sessionManagers.get(daemonId);
  if (cached) return cached;
  const sm: ISessionManager = requireFactories().createSessionManager({
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
  if (!cliDetector) {
    cliDetector = requireFactories().createCliDetector();
  }
  return cliDetector.detectClis();
}

export function shutdownAllWiring(): void {
  for (const sm of sessionManagers.values()) {
    sm.shutdownAll().catch(() => {});
  }
  sessionManagers.clear();
  claimStrategies.clear();
}
