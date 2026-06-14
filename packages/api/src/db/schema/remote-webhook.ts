import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { habitats } from "./board.js";
import { remoteWebhookEndpoints } from "./remote-pod.js";

export const remoteWebhookDeliveries = sqliteTable(
  "remote_webhook_deliveries",
  {
    id: text("id").primaryKey(),
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => remoteWebhookEndpoints.id, { onDelete: "cascade" }),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payload: text("payload").notNull(),
    signature: text("signature").notNull(),
    status: text("status", { enum: ["pending", "success", "failed"] })
      .notNull()
      .default("pending"),
    statusCode: integer("status_code"),
    responseBody: text("response_body"),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: text("last_attempt_at"),
    nextRetryAt: text("next_retry_at"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    index("idx_remote_webhook_deliveries_endpoint").on(table.endpointId, table.createdAt),
    index("idx_remote_webhook_deliveries_status").on(table.status, table.nextRetryAt),
  ],
);
