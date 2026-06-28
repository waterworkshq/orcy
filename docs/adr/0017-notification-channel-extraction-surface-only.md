# Notification Channel Extraction Surface — Ship the Surface, Don't Migrate In-Tree Channels

Status: proposed · 2026-06-28

Depends on: ADR-0011 (Plugin Manifest V1 — `notificationChannel` contribution kind), ADR-0012 (Plugin Capability Whitelist — `notificationPayload` context field), ADR-0013 (Detected Signal Category — `pulseWriter.createDetectedSignal` capability)

## Context

Constraint #5 locks Notification Channel as the second reference extension point for v0.22 (alongside the required Custom Signal Detector feature). Constraint #7 caps v0.22.0 to a single feature release: plugin platform + detector + reference extension point registration surface, with in-tree switch migrations deferred. Grilling Q8 surfaced the ambiguity: "ship the surface" can mean (a) deliver the manifest slot + contribution registration but migrate zero in-tree channels, (b) ship the surface AND migrate one existing channel as the proof, or (c) ship the surface AND migrate all four channels.

The existing in-tree channel switch is `notificationDeliveryService.ts:52`: `switch (channel) { case "in_app": ...; case "slack": ...; case "discord": ...; case "webhook": ... }` — four hardcoded cases, two of which (Slack, Discord) are the integration paths operators actually use today. Migrating them in v0.22.0 risks a delivery regression on the most-used notification surfaces.

## Decision

**v0.22.0 ships the `notificationChannel` contribution surface without migrating any existing in-tree channel.**

Concretely:
1. `notificationDeliveryService.ts:52` is rewritten to FIRST consult a `channelRegistry` (built by `pluginManager` at boot from loaded plugins' `notificationChannel` contributions). If a registered channel plugin handles the `channelId` of the notification being delivered, the plugin handler is invoked with `ctx.notificationPayload` (per ADR-0012's notification-kind-specific context field). The plugin returns `{ delivered: true, attempts: DeliveryAttempt[] }` or `{ delivered: false, error: string }`.
2. If no registered channel plugin handles the `channelId`, the existing `switch` falls through to the hardcoded `in_app` / `webhook` / `slack` / `discord` cases. Behavior for these four channels is IDENTICAL to v0.21 — no migration, no regression.
3. The reference `plugins/teams-channel/` is shipped as a new in-tree plugin (NOT migration — a net-new channel). It declares:
   ```
   {
     kind: "notificationChannel",
     scope: "system",
     channelId: "teams",
     label: "Microsoft Teams",
     configSchema: { webhookUrl: z.string().url() },
     requires: [], // notificationPayload is a kind-specific field, not a capability
   }
   ```
   Handler sends an Adaptive Card to the configured Teams webhook URL.
4. The migration of Slack/Discord/in-app/webhook out of the switch + into reference plugins is recorded as v0.22.1 Architecture Deepening (per ROADMAP update).
5. Integration adapter extraction (GitHub/Jira/Linear) is recorded as v0.23+ Architecture Deepening, paced to a later release because of the OAuth / webhook-signing complexity.

Concretely: v0.22.0 delivers *one* new real channel (Microsoft Teams) and the *registration surface*; existing channels untouched.

## Rationale

- **Constraint #7 explicitly says "NO in-tree switch migrations beyond the surface."** Re-reading the recommended option text: "other extension points stay hardcoded in-tree; their migration deferred to deepening patches post-v0.22 stabilization." Notification Channel shift surface extraction fits this — migration is the post-stabilization step.
- **A new reference channel proves the surface is functional without touching production paths.** Operators currently using Slack/Discord get ZERO behavioral change — `notificationDeliveryService.ts` codepath for `channel:"slack"` falls through the registry miss and hits the same existing case body. Regression risk on Slack/Discord is structurally impossible from this work.
- **Microsoft Teams is a real product-need channel, not a toy.** Operators running Orcy on Microsoft 365 currently have no chat delivery path. v0.22.0 gives them one via the plugin surface. Other-vendor plugin authors (Mattermost, Rocket.Chat, Telegram) follow the Teams reference plugin contract.
- **Three reference plugins together exercise the manifest's full surface:**
  - `plugins/auto-label/` (rewritten) — `lifecycleInterceptor`, `scope: "habitat"`, `phase: "post"`, `event: "taskCreated"` — exercises the post-emit seam + the `pulseWriter.createDetectedSignal` capability + the detected-signal wiki surface (ADR-0013 / ADR-0015).
  - `plugins/teams-channel/` (new) — `notificationChannel`, `scope: "system"` — exercises the channel registry sub-sumption + the env-gated boot enablement (`PLUGINS_ENABLED`).
  - `plugins/detector-regex-frustion/` (new) — `signalDetector`, `scope: "habitat"` — exercises the trigger-fire-and-forget-after-commit seam (ADR-0015) + the per-habitat enrollment (`plugin_enrollments`, per ADR-0016) + the detector allowlist (`ORCY_DETECTOR_ALLOWLIST`, per ADR-0016).
  - `plugins/detector-short-submission/` + `plugins/detector-rejection-loop/` (per the seed's three reference detectors) are deferred to v0.22.1+ OR landed within v0.22.0 if execution budget permits — the single-reference-detector rule (one detector exercises the surface) is the minimum viable v0.22.0. The other two are deepening addons, not prerequisite.
- **"Surface-only ship" preserves the single-feature cap.** Touching just the `channelRegistry` addition in `notificationDeliveryService.ts:52` (not the four existing cases) keeps the diff bounded. The channel migration patch (v0.22.1) then has a focused scope: rewrite 4 case bodies out of the switch + into plugin modules; the registry code already exists from v0.22.0.

## Future extraction cadence (ROADMAP entries recorded separately)

- **v0.22.1 — Architecture Deepening #1 "Channel Migration".** Migrate Slack/Discord/in-app/webhook channels from `notificationDeliveryService.ts:52` switch into reference plugins under `plugins/channel-*/`. Webhook formatters (`services/webhook-formatters/{discord,slack}.ts`) fold into their channel plugin's module in the same patch. Switch statement in `notificationDeliveryService.ts` collapses to a pure registry lookup; hardcoded cases removed.
- **v0.23 or v0.24 — Architecture Deepening #2 "Integration Adapter Extraction".** Extract GitHub/Jira/Linear adapters as `plugins/integration-*/`. Bigger lift: OAuth device/PKCE/callback surfaces per adapter + adapter-specific inbound webhook signing (`hmac-verified` per `services/integrations/webhookService.ts` precedent + the integration's specific signing rules). Paced to a later release because (a) v0.23 is the Triage release (depends on stable detector pipeline, per ROADMAP) and (b) integration adapter extraction has the highest OAuth-complexity risk of any planned extraction.
- **NOT planned for extraction:** prioritization conditions/actions, review strategies, signal types. These stay core until external demand pressure-tests the interface design. Adding plugin surfaces speculatively ossifies contracts before there's pressure to design them right. README's "agnostic on four axes" pitch is operationalized only on the axes where agnosticism is real product value (chat delivery + work source); the other axes are core-domain decisions the Orcy team owns.

## Alternatives considered

- **Fork 2 — Ship + migrate one channel (Slack) as the proof (reject).** Violates Constraint #7's explicit "no in-tree switch migrations" cap. Slack is the highest-use channel; regression risk on the most-used notification path is the wrong v0.22.0 risk profile. The new Teams channel already proves the surface end-to-end.
- **Fork 3 — Ship + migrate all four channels (reject).** Largest blast radius. Every notification deliver route is touched. Constraint #7 caps v0.22.0 — extracting all four channels is exactly what the cap excludes. The deepening patch (v0.22.1) is the right place for it: focused, single-concern, with the v0.22.0 surface already proven.
- **Fork 4 — Defer Notification Channel entirely; ship only detectors (reject).** Directly violates Constraint #5's locked choice. Whitelisting "Notification Channel" as the second reference extension point was an explicit decision; deferring it makes the platform surface abstract (detectors only, no second contribution kind), under-proving the discriminated-union design from ADR-0011. The v0.22.0 platform needs two real contribution kinds (detector + channel) to exercise the manifest discriminated-union thoroughly.

## Consequences

- `packages/api/src/plugins/pluginManager.ts` gains `channelRegistry: Map<channelId, ChannelHandler>` built from `notificationChannel` contributions on loaded-and-`PLUGINS_ENABLED`-enabled plugins. Registry is built at boot; invalidated on plugin-load errors by setting `quarantined=true` on the affected plugin's contribution entries.
- `packages/api/src/services/notificationDeliveryService.ts:52` — switch is prefaced by a `channelRegistry.get(channelId)` lookup. Hit path invokes the plugin handler with the parsed `NotificationPayload` context field. Miss path falls through to the existing 4 hardcoded cases unchanged. Single-line early-exit guard at the top handles "no channel plugins loaded" (the common v0.22.0 case for operators not installing teams-channel).
- `packages/shared/src/types/plugin.ts` — owns `ChannelHandler` signature: `(ctx: PluginContext, payload: NotificationPayload) => Promise<ChannelDeliveryResult>`. Includes the `NotificationPayload` shape (the parsed notification + recipient context the existing in-tree channel handlers consume).
- `plugins/teams-channel/index.ts` (new in-tree reference plugin) — follows the same file structure as `plugins/auto-label/index.ts`; exports a `PluginModule` with one `notificationChannel` contribution channel handler. Manifest declares `channelId: "teams"`, the config schema, no `requires` (channels get `notificationPayload` automatically per ADR-0012). Handler sends an Adaptive Card to the configured Teams webhook URL, returns `{ delivered: true, attempts: [{ ok: true, response: "<teams-response>" }] }` or `{ delivered: false, error: "<failed-detail>" }` per the `ChannelDeliveryResult` shape.
- `plugins/detector-regex-frustration/` (new in-tree reference plugin) — declares `signalDetector` contribution, scope habitat, `detects: "pulseCreated"`. Handler reads the source pulse via `pulseReader.getPulse`, regex-matches frustration language ("hell", "why does this break", "this always", etc), returns `DetectedSignalInput[]` with one signal when matched. Server-injected `metadata.detected:true / metadata.detector:"detector-regex-frustration" / metadata.detectorRunId:<runId>` per ADR-0012/0013.
- `plugins/auto-label/index.ts` — rewritten. The v0.21 plugin (which logs suggested labels via `hooks.onTaskCreated`) is replaced by a `lifecycleInterceptor`, `phase: "post"`, `event: "taskCreated"` contribution. Returns `{ signals: [{ signalType: "detected", subject: "auto-label: suggested labels", body: "Suggested: bug, refactor, ...", metadata: { labels: [...] } }] }` — turning the logger-only behavior into a real detected signal that surfaces in the wiki "Detected Signals" tab.
- README's "chat-native agents" / "Slack/Discord are pluggable notification surfaces, not the substrate" pitches remain aspirational in v0.22.0 but become functionally true after the v0.22.1 deepening. README/CAPABILITIES should not over-promise in v0.22.0 — accurate copy is "v0.22 ships the plugin surface; channel extraction is a v0.22.1 deepening patch."
- ROADMAP gains two Architecture Deepening rows in the existing "Architecture Deepening" table: v0.22.1 "Channel Migration" (Slack/Discord/in-app/webhook extracted to plugins, webhook formatters folded in) and post-v0.22 "Integration Adapter Extraction" (GitHub/Jira/Linear extracted as `plugins/integration-*/`). These sit alongside the existing v0.17.1 / v0.18.1 / v0.19.1 / v0.20.2 rows in the same table.
- Tests must cover: the channelRegistry miss falls through to switch correctly; the channelRegistry hit invokes the plugin instead of the switch; the in-house 4 channels work identically post-v0.22.0 (regression); teams-channel can be loaded via PLUGINS_ENABLED and delivers a notification when enrolled via PLUGINS_ENABLED (no enrollment REST needed — system-scoped plugin); teams-channel missing env-enable results in channelRegistry miss → switch fallback → "no delivery" for a Teams-addressed notification (since no hardcoded teams case exists); the plugin's handler crash is caught + audit event `plugin.error` written + auto-quarantine counter incremented.

## Risk

- **README may over-promise the extracted-state on the day v0.22.0 ships.** Mitigation: PRD/Ph7-doc-audit phase (per release-orchestrator skill Phase 7) catches this; README/CAPABILITIES for v0.22.0 explicitly say "plugin surface shipped; in-tree channel migration follows in v0.22.1."
- **Slack/Discord delivery contract assumes the v0.21 switch behavior.** The `notificationDeliveryService.ts:52` fallback path is bit-identical to v0.21 — the only new code is the `channelRegistry.get()` early-exit. Risk: the early-exit accidentally short-circuits a notification correctly handled by the existing switch (by matching a non-existent plugin channelId). Mitigation: the registry returns `null`/`undefined` (no plugin) for channel ids not declared in any loaded plugin's manifest; the fallback executes. Test confirms the existing 4 channels are unaffected when no channel plugins are loaded.
- **`Microsoft Teams` reference plugin is the only system-scoped real consumer.** Surface means a channel registry with one consumer — fewer than the 4 detector reference plugins' archetype coverage. Constraint #5 accepted this trade-off ("Notification Channel smallest surface, smallest blast radius"). v0.22.1's channel-migration patch turns 4 in-tree consumers into 4 plugin consumers, completing the proof matrix.