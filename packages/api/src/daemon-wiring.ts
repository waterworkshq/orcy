import { createSessionManager, createCliDetector } from "@orcy/daemon";
import type { ISessionManager, ICliDetector, DetectedCli } from "@orcy/shared/types";
import { InProcessSessionUpdater } from "./services/inProcessSessionUpdater.js";

const sessionManagers = new Map<string, ISessionManager>();
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

export function releaseSessionManager(daemonId: string): void {
  sessionManagers.delete(daemonId);
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
}
