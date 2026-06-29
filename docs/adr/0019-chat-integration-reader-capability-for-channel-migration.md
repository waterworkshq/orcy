# ADR-0019: `chatIntegrationReader` Capability for Channel Migration

**Date:** 2026-06-30  
**Status:** Accepted  
**Supersedes:** None (extends ADR-0012 capability whitelist)

## Context

The v0.22.0 plugin platform shipped a notification channel registry surface (ADR-0017) but left the 4 in-tree channels (`in_app`, `webhook`, `slack`, `discord`) hardcoded in `dispatchChannel`'s switch statement. Migrating these channels to plugin modules requires access to per-habitat chat integration data (the webhook URLs configured by habitat admins via the chat integration system).

The current 5-capability whitelist (ADR-0012: `pulseReader`, `pulseWriter`, `commentReader`, `taskReader`, `habitatReader`) does not cover chat integration access. Slack and Discord channel handlers depend on `chatIntegrationRepo.getEnabledIntegrationsByHabitat(habitatId)` to find the habitat's configured webhook URL. Without a capability for this, the channel plugins cannot resolve their webhook targets.

Additionally, `NotificationChannelContribution.requires` is typed as the empty tuple `[]` — channel contributions are currently forbidden from declaring any capabilities. This type constraint must be widened to allow channel plugins to declare `chatIntegrationReader`.

## Decision

1. **Add `chatIntegrationReader` to `PluginCapabilityName`.** This is the 6th capability on the PluginContext whitelist.

2. **Define `ChatIntegrationReader` interface:**
   ```typescript
   interface ChatIntegrationReader {
     getEnabledByHabitat(habitatId: string): Promise<ChatIntegrationView[]>;
   }
   ```
   Returns a stripped projection `ChatIntegrationView = { provider, webhookUrl, channelId }` — **no `botToken`** (security: the bot token is not needed for webhook-based delivery and must not be exposed to plugins).

3. **Widen `NotificationChannelContribution.requires`** from `[]` to `PluginCapabilityName[]`. Channel contributions may now declare capabilities. The scope stays `"system"` (channels are process-wide, not per-habitat) — but the capability reader is scoped to the delivery's `habitatId` at dispatch time (same pattern as all readers post-v0.22.5 C2 fix).

4. **Scope:** The `chatIntegrationReader` is scoped to the contribution's bound `habitatId` (set by `dispatchToChannelPlugin` to `delivery.habitatId`). A channel plugin invoked for habitat A's delivery can only read habitat A's chat integrations.

5. **Delivery attempt tracking is NOT a capability.** Channel plugins import `attemptRepo` directly for delivery attempt tracking (in-process execution, operator trust per ADR-0012 consequence notes). The capability whitelist contains only capabilities that gate per-habitat data access that could leak cross-habitat. Delivery attempt tracking is write-only logging that doesn't cross habitat boundaries.

6. **Gradual migration:** The hardcoded switch in `dispatchChannel` is retained as a backward-compat fallback. When channel plugins are loaded (default: `PLUGINS_ENABLED` unset → all plugins in `PLUGINS_DIR` load), the registry path handles all 4 channels. The switch only fires in test environments that don't load plugins. The switch removal is deferred to a future patch.

## Consequences

- **6th capability on the whitelist.** ADR-0012's 5-capability surface grows by one. This is the first capability addition since v0.22.0. Future capability additions require a new ADR (same governance as before).
- **Channel plugins can now declare capabilities.** The `NotificationChannelContribution.requires` type change is backward-compatible — existing channel contributions with `requires: []` continue to work.
- **`ChatIntegrationView` strips `botToken`.** Plugin authors writing custom chat integrations must not assume access to bot tokens. The webhook URL is sufficient for webhook-based delivery.
- **Gradual migration means the switch stays temporarily.** This is intentional — removing the switch requires all tests to load channel plugins, which is a separate test-infrastructure change. The switch is dead code in production (plugins auto-load) but provides test-time backward compatibility.

## Alternatives Considered

1. **Payload enrichment** — `dispatchToChannelPlugin` pre-resolves chat integrations and passes them in `notificationPayload`. Rejected: couples the generic plugin dispatcher to notification-specific repos.

2. **`notificationDeliveryWriter` capability** — expose delivery attempt tracking as a capability. Rejected: too domain-specific for the general whitelist. Attempt tracking is write-only logging, not per-habitat data access.

3. **Env-var webhook URLs** — Slack/Discord plugins read `ORCY_SLACK_WEBHOOK_URL` (like teams-channel reads `ORCY_TEAMS_WEBHOOK_URL`). Rejected: breaks per-habitat configuration. The existing chat integration system stores per-habitat webhook URLs in the DB; env-var-only would be a regression.

4. **Plugin config JSON** — enrollment `config` field carries the webhook URL. Rejected: changes the UX from the existing chat integration management UI to plugin enrollment config. Breaks backward compatibility for operators.
