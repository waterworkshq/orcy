# Integration Provider Contribution Kind — Adapter Surface Extraction

Status: accepted · 2026-07-02

Depends on: ADR-0011 (Plugin Manifest V1 — discriminated contributions), ADR-0012 (Plugin Capability Whitelist), ADR-0017 (Notification Channel Extraction Surface — established the extraction cadence and gradual-migration pattern)

## Context

The integration layer (`packages/api/src/services/integrations/`) contains three in-tree issue-provider adapters (GitHub, Jira, Linear) implementing the `IssueProviderAdapter` interface (`listIssues` / `getIssue`). Adapter resolution happens via a string-keyed dynamic `require()` switch in `getAdapter()` (`routes/integrations.ts:79`). This is the same closed-switch pattern that the notification channel extraction (ADR-0017), webhook formatter extraction (ADR-0021), automation condition extraction (ADR-0022), and automation action extraction (ADR-0023) already converted to plugin registries.

ADR-0017 explicitly recorded the integration adapter extraction as a future deepening patch: "v0.23 or v0.24 — Architecture Deepening #2 'Integration Adapter Extraction'. Bigger lift: OAuth device/PKCE/callback surfaces per adapter + adapter-specific inbound webhook signing." This ADR scopes the extraction to the **adapter interface only**, deferring the OAuth and webhook complexity to a future patch.

The adapter interface is a clean 2-method data-fetching contract: `listIssues(connection)` returns normalized `ExternalIssue[]`, `getIssue(connection, externalId)` returns a single `ExternalIssue | null`. The `syncService` already receives the adapter as a parameter — it is fully decoupled from adapter resolution. The only coupling point is the `getAdapter()` function.

## Decision

**Add a new `integrationProvider` contribution kind (system-scoped, `requires: []`) that extracts the issue-provider adapter interface into the plugin registry. The existing `getAdapter()` dynamic `require()` is retained as a backward-compat fallback.**

Concretely:
1. `IntegrationProviderContribution` is added to the `Contribution` discriminated union in `@orcy/shared`. Fields: `kind: "integrationProvider"`, `scope: "system"`, `provider: IntegrationProvider`, `label: string`, `authMethods: readonly IntegrationAuthMethod[]`, `requires: []`.
2. `PluginModule` gains an optional `providers?: Record<string, ProviderHandler>` map. `ProviderHandler` mirrors `IssueProviderAdapter` (`listIssues` + `getIssue`).
3. `pluginManager` gains a `providerRegistry: Map<provider, { pluginId, handler }>`, populated at boot from loaded plugins, with collision detection (two plugins claiming the same `provider` are refused).
4. `getProviderAdapter(provider)` exported from `pluginManager` returns the plugin handler or `null`.
5. `getAdapter()` in `routes/integrations.ts` consults `getProviderAdapter()` first; on a miss, falls through to the existing dynamic `require()` switch.
6. Three reference plugins ship: `plugins/integration-{github,jira,linear}/`, each wrapping the existing in-tree adapter object (channel-plugin pattern — the plugin imports the adapter from `services/integrations/`).

## Rationale

- **The adapter interface is the natural plugin seam.** It is a pure data-fetching contract with no side effects beyond outbound HTTP to the provider API. `syncService` consumes it as a parameter — zero coupling to resolution. This is structurally identical to the notification channel extraction: a closed switch replaced by a registry lookup with in-tree fallback.
- **`customHttpRoute` is the wrong fit.** The adapter is not an HTTP route — it is an interface invoked by `syncService` during a pull sync. OAuth callbacks and webhook ingestion ARE HTTP routes, but those are explicitly deferred (see below). Forcing the adapter under `customHttpRoute` would conflate two distinct concerns.
- **No new capabilities needed.** The adapter receives a pre-built `IntegrationConnection` (with credentials) and returns normalized issues. It does not read from or write to the Orcy database. The `requires: []` field means no capability-whitelist expansion — unlike the automation action extraction (ADR-0023) which required `taskWriter`/`notificationSender`/`webhookCaller`. This keeps the security surface unchanged.
- **Gradual migration preserves production behavior.** The dynamic `require()` fallback means environments without the integration plugins loaded (notably test environments) behave identically to pre-extraction. The plugin registry is consulted first only when `PLUGINS_ENABLED` includes the integration plugins. This is the ADR-0017 pattern proven by the notification channel migration.
- **Wrapping in-tree (not relocating) is reversible.** The reference plugins import `githubAdapter` / `jiraAdapter` / `linearAdapter` from their existing locations. The adapter code is not moved or duplicated. If the extraction needs to be reverted, deleting the three plugin directories restores the pre-extraction state with zero code changes.

## What is explicitly deferred

- **OAuth flows (`*OAuth.ts`, `oauthCallback.ts`, `oauthState.ts`) stay in-tree.** OAuth involves credential management (client IDs/secrets, token refresh, DB writes to connection records). The plugin capability whitelist (ADR-0012) has no credential-management capability, and adding one is a significant security-surface decision that deserves its own ADR. The OAuth routes in `routes/integrations.ts` (device flow, PKCE, API key) call the OAuth modules directly — they do not go through the adapter interface.
- **Webhook ingestion (`webhookService.ts`, `routes/githubIssueWebhooks.ts`) stays in-tree.** GitHub webhook ingestion is HMAC-verified and unauthenticated (webhooks originate from GitHub, not Orcy-authenticated clients). The `customHttpRoute` contribution kind mounts routes via `fastify.register()` with no per-route auth middleware control — unsuitable for unauthenticated signature-verified routes.
- **Webhook creation (`createGitHubWebhook`) stays in-tree.** It is a one-off helper called during connection setup, not part of the adapter interface.
- **The `syncService` policy branch** (`provider !== "github"` → intake candidate path, `syncService.ts:134`) stays. This is a product decision (GitHub auto-imports, others go to intake review), not adapter logic.

These deferrals are recorded as future deepening candidates. Extracting OAuth/webhooks would require new security-gated capabilities (`credentialManager`, `connectionWriter`) and a solution to the `customHttpRoute` auth-middleware gap — each warranting its own ADR.

## Alternatives considered

- **Full extraction (adapters + OAuth + webhooks) in one patch (reject).** ADR-0017 explicitly flagged OAuth complexity as the reason for deferral. Bundling credential management, unauthenticated webhook routes, and signature verification into an extraction patch inflates the security surface and blast radius. The adapter interface is independently extractable; the OAuth/webhook layer is not coupled to it.

- **Reuse `customHttpRoute` for the adapter (reject).** The adapter is invoked synchronously by `syncService` during a pull sync, not by an HTTP request. `customHttpRoute` mounts Fastify routes — wrong abstraction. A data-fetching interface needs its own contribution kind, the same way `notificationChannel` (invoked by the delivery service, not HTTP) has its own kind.

- **Relocate adapter code into plugin directories (reject).** Moving the code physically makes the extraction harder to reverse and increases the diff. The channel-plugin pattern (plugin wraps in-tree code via import) is proven, reversible, and keeps the in-tree code as the source of truth. Physical relocation can happen in a later cleanup patch if desired.

- **Delete the dynamic `require()` fallback in the same patch (reject).** Test environments that don't load plugins would break. The gradual-migration pattern (ADR-0017) keeps the fallback until plugins auto-load in all environments. Defer deletion to a later patch.

## Consequences

- `packages/shared/src/types/plugin.ts` — gains `IntegrationProviderContribution`, adds `"integrationProvider"` to the `Contribution` union. Imports `IntegrationProvider` + `IntegrationAuthMethod` from `./integration.js` (no circular dependency — `integration.ts` has no imports).
- `packages/api/src/plugins/types.ts` — gains `ProviderHandler` interface, adds `providers?` field to `PluginModule`.
- `packages/api/src/plugins/pluginManager.ts` — gains `providerRegistry`, `"integrationProvider"` in `VALID_KINDS` / `CAPABILITY_MATRIX` / `DEFAULT_TIMEOUT_MS`, collision detection in `detectIdCollisions`, registration in `registerContributions`, validation in `orphanHandler` + `contributionLabel`, `getProviderAdapter()` export, `providerRegistry.clear()` in `resetPlugins`.
- `packages/api/src/routes/integrations.ts` — `getAdapter()` consults `getProviderAdapter()` before the dynamic `require()` fallback.
- `plugins/integration-github/`, `plugins/integration-jira/`, `plugins/integration-linear/` — three new reference plugins wrapping the in-tree adapters.
- `syncService.ts`, all `*OAuth.ts`, `webhookService.ts`, `oauthCallback.ts`, `oauthState.ts`, `routes/githubIssueWebhooks.ts` — **unchanged**.
- Adding a new provider (e.g. GitLab, Bitbucket) becomes: write a plugin under `plugins/integration-gitlab/` declaring `provider: "gitlab"`, implement `listIssues`/`getIssue`. No changes to `getAdapter()`, `syncService`, or any in-tree code — the registry handles resolution automatically.

## Risk

- **Sync regression on existing connections (LOW).** The gradual-migration fallback is bit-identical to pre-extraction when no integration plugins are loaded. The plugin registry only takes precedence when `PLUGINS_ENABLED` includes the integration plugins. All 73 existing integration tests pass unchanged against the fallback path.

- **Provider collision (LOW).** Two plugins claiming the same `provider` are refused at load time, logged via `pluginErrors`. Same pattern as `channelId` / `detectorId` / `formatId` collisions — battle-tested since v0.22.0.

- **OAuth/token-refresh drift (NONE).** OAuth modules are untouched. The Jira and Linear adapters call `ensureFreshToken()` internally during `listIssues`/`getIssue` — this continues to work identically whether the adapter is served from the registry or the fallback, because the adapter object is the same instance (the plugin wraps the in-tree export, not a copy).

- **Webhook ingestion regression (NONE).** `webhookService.ts` and `routes/githubIssueWebhooks.ts` are untouched. Webhook ingestion does not use the adapter interface — it has its own inline GitHub payload normalization.
