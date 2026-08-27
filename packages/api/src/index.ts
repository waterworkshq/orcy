#!/usr/bin/env node
import "dotenv/config";
import * as habitatRepo from "./repositories/habitat.js";
import * as habitatHealthService from "./services/boardHealthService.js";
import { registerCreationDispatchAdapters } from "./services/taskCreationDispatchAdapters.js";
import { startOccurrenceLeaseRecoveryWorker } from "./services/scheduledOccurrenceRecovery.js";
import { startCreationDispatchWorker } from "./services/creationDispatchWorker.js";
import { rebuildCache as rebuildHabitatSecretCache } from "./services/habitatSecretCache.js";
import { seedDefaultTemplates as seedQualityTemplates } from "./services/qualityGateService.js";
import { startAllSchedulers } from "./services/scheduler.js";
import { initSkillHooks } from "./services/habitatSkillService.js";
import { initWorkflowService } from "./services/workflowService.js";
import { runRecoveryReconciliationPass } from "./services/workflow/recoveryCoordinator.js";
import { runExtractionReconciliationPass } from "./services/extractionRecovery.js";
import { initWikiScheduler } from "./services/wikiSchedulerService.js";
import { initDb } from "./db/index.js";

import { createHttpApp, registerHttpSurface } from "./httpApp.js";
import { setJwtSecret } from "./middleware/jwt-verification.js";
import * as pluginManager from "./plugins/pluginManager.js";
import { runPluginBoot } from "./plugins/pluginBoot.js";
import { assertSecurityConfigOrExit } from "./config/security.js";

const securityConfig = assertSecurityConfigOrExit();
setJwtSecret(securityConfig.jwtSecret);

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "127.0.0.1";

let occurrenceRecoveryHandle: NodeJS.Timeout | undefined;
let creationDispatchHandle: { stop: () => void } | undefined;

// The entire HTTP surface (root plugins/hooks, both API prefix groups,
// realtime, remote participant API, root redirect, optional UI) is registered
// through the production seam in `httpApp.ts`. Boot keeps only operational
// startup — DB, caches, schedulers, workers, plugin boot, listen.
const fastify = createHttpApp();
await registerHttpSurface(fastify, {
  // T11 Phase 1A — boot-registration of the creation dispatch infrastructure,
  // at its historical waypoint (dd75a98): after both local API prefix groups,
  // before realtime / Remote Participant / root redirect / optional static
  // registration. Moved OUTSIDE registerApiRoutes to prevent double-startup
  // (registerApiRoutes is called for both /api/v1 and /api prefixes).
  // Always started (not gated by the flag) so that a rollback (flag OFF after
  // being ON) can still drain committed published_pending_observation /
  // published_pending_assignment / publishing attempts. The workers are no-ops
  // when there are no post-cutover attempts to process.
  onLocalPrefixesRegistered: () => {
    registerCreationDispatchAdapters();
    occurrenceRecoveryHandle = startOccurrenceLeaseRecoveryWorker(60_000);
    creationDispatchHandle = startCreationDispatchWorker(5_000);
  },
});

await initDb();
if (!process.env.DB_PATH && process.env.NODE_ENV !== "production") {
  const defaultPath = (await import("./db/index.js")).getDefaultDbPath();
  console.warn(`WARNING: No DB_PATH set. API is using production database at: ${defaultPath}`);
  console.warn("Set DB_PATH env var to a different path to keep dev/test data separate.");
}

try {
  rebuildHabitatSecretCache();
} catch (err) {
  fastify.log.error({ err }, "Failed to rebuild habitat secret cache");
}

try {
  seedQualityTemplates();
} catch (err) {
  fastify.log.error({ err }, "Failed to seed quality templates");
}

const schedulers = startAllSchedulers(fastify);

try {
  initSkillHooks();
} catch (err) {
  fastify.log.error({ err }, "Failed to initialize skill hooks");
}

try {
  initWorkflowService();
} catch (err) {
  fastify.log.error({ err }, "Failed to initialize workflow service");
}

try {
  initWikiScheduler();
} catch (err) {
  fastify.log.error({ err }, "Failed to initialize wiki scheduler");
}

const healthSnapshotInterval = setInterval(async () => {
  try {
    const habitats = habitatRepo.listHabitats();
    for (const habitat of habitats) {
      try {
        habitatHealthService.calculateHealth(habitat.id);
      } catch (err) {
        fastify.log.error({ err, habitatId: habitat.id }, "Health snapshot failed");
      }
    }
  } catch (err) {
    fastify.log.error({ err }, "Health snapshot scan failed");
  }
}, 60 * 60_000);

const shutdown = async () => {
  await fastify.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

fastify.addHook("onClose", async () => {
  schedulers.stop();
  clearInterval(healthSnapshotInterval);
  creationDispatchHandle?.stop();
  if (occurrenceRecoveryHandle) clearInterval(occurrenceRecoveryHandle);
  const { shutdownAll } = await import("./services/daemonEngine.js");
  shutdownAll();
  const { stopExtractionScan } = await import("./services/extractionScheduler.js");
  stopExtractionScan();
});

pluginManager.loadQuarantinesFromDb();

// Crash-loud activation contract (ADR-0041): `loadPlugins` failures are
// non-fatal while `initializePlugins` failures are fatal. The two regimes
// live in `runPluginBoot` so they are unit-testable without spawning the
// compiled server (see pluginBoot.test.ts). Boot order is unchanged:
// loadQuarantinesFromDb → runPluginBoot (loadPlugins → initializePlugins)
// → initDaemonWiring → listen.
await runPluginBoot(fastify);

const { initDaemonWiring } = await import("./daemon-wiring.js");
await initDaemonWiring();

const { initDetectorScan } = await import("./services/detectorScanService.js");
initDetectorScan();

try {
  // Boot-only recovery reconciliation closes the crash window between the
  // atomic gate handoff and the publication attempt. No periodic timer is
  // scheduled; operators/tests may call the exported pass on demand.
  runRecoveryReconciliationPass();
} catch (err) {
  fastify.log.error({ err }, "Failed to reconcile workflow recovery handoffs at boot");
}

try {
  // Boot-only extraction recovery: reconcile stale running attempts whose
  // lease has expired (mark failed + one fenced child attempt) and repair
  // work items whose finalization failed after candidate commit.
  runExtractionReconciliationPass();
} catch (err) {
  fastify.log.error({ err }, "Failed to reconcile extraction stale leases at boot");
}

const { initExtractionScan } = await import("./services/extractionScheduler.js");
initExtractionScan();

// Automation inbox consumer (restored lifecycle T7): one boot recovery pass
// for events admitted before a crash, plus a bounded interval pass. The
// fenced inbox owns rule processing; `release.shipped` projections complete
// on durable handoff, not on external action completion.
const { initAutomationInboxDrain } = await import("./services/releaseReconciliationService.js");
initAutomationInboxDrain();

const { registerExtractionAuditEmitter } = await import("./services/extractionAuditEmitter.js");
registerExtractionAuditEmitter();

try {
  await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info(`Orcy API running at http://${HOST}:${PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
