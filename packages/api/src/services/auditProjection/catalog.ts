import {
  AUDIT_QUERY_ENTITY_TYPES,
  type AuditQueryEntityType,
} from "@orcy/shared/types";
import { automationRunCollector } from "./automationRunCollector.js";
import { codeEvidenceCollector } from "./codeEvidenceCollector.js";
import { effortCollector } from "./effortCollector.js";
import { healthSnapshotCollector } from "./healthSnapshotCollector.js";
import { integrationSyncCollector } from "./integrationSyncCollector.js";
import { lifecycleCollector } from "./lifecycleCollector.js";
import { notificationCollector } from "./notificationCollector.js";
import { pluginRunCollector } from "./pluginRunCollector.js";
import { webhookDeliveryCollector } from "./webhookDeliveryCollector.js";
import type { AuditProjectionCollector } from "./types.js";

export const AUDIT_CATALOG: readonly AuditProjectionCollector[] = [
  lifecycleCollector,
  effortCollector,
  codeEvidenceCollector,
  integrationSyncCollector,
  webhookDeliveryCollector,
  healthSnapshotCollector,
  automationRunCollector,
  notificationCollector,
  pluginRunCollector,
];

export function selectCollectors(
  selectedEntityTypes: ReadonlySet<AuditQueryEntityType>,
): readonly AuditProjectionCollector[] {
  return AUDIT_CATALOG.filter((collector) =>
    collector.entityTypes.some((entityType) => selectedEntityTypes.has(entityType)),
  );
}

export function assertCatalogCoverage(): void {
  const claimed = new Set<AuditQueryEntityType>();
  for (const collector of AUDIT_CATALOG) {
    for (const entityType of collector.entityTypes) {
      if (claimed.has(entityType)) {
        throw new Error(
          `Audit catalog: entity type "${entityType}" is claimed by multiple collectors.`,
        );
      }
      claimed.add(entityType);
    }
  }
  for (const entityType of AUDIT_QUERY_ENTITY_TYPES) {
    if (!claimed.has(entityType)) {
      throw new Error(
        `Audit catalog: entity type "${entityType}" has no collector.`,
      );
    }
  }
}