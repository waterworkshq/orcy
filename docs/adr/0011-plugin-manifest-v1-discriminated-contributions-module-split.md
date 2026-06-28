# Plugin Manifest V1 — Discriminated Contributions, Module Split, Per-Contribution Scope

Status: proposed · 2026-06-28

## Context

v0.22 extracts Orcy's matured in-tree extension patterns into a safe plugin platform (Constraint #5: Notification Channel as the second_reference extension point; Custom Signal Detectors as the required feature). The current `KanbanPlugin` interface (`packages/api/src/plugins/types.ts:20`) is flat — `{ name, version, hooks?, customRoutes?, customMcpTools? }` where `customMcpTools` is defined but never wired into the MCP server, and hooks are observation-only fire-and-forget. The single in-tree consumer, `plugins/auto-label`, only logs suggestions.

Orcy's house pattern for extensible typed unions is `AutomationAction` in `@orcy/shared/types/automation.ts:156`, a discriminated union keyed by `type`. A single contribution can be enabled by either a server admin at boot (Notification Channels, where habitat gating is meaningless — Slack cannot be Slack in one habitat and disabled in the next if the server is one process) or a habitat admin at runtime (Detectors, where opt-in per habitat is the whole point of the feature — Constraint #6).

## Decision

**The v0.22 plugin SDK replaces `KanbanPlugin` with a discriminated `PluginManifest` + a paired `PluginModule` runtime object.**

1. **`PluginManifest`** (exported from `@orcy/shared`) is a declarative record: `{ id, version, description, configSchema?, contributions: Contribution[] }`. Contributions are a discriminated union keyed by `kind`:
   - `{ kind: "notificationChannel", scope: "system", channelId, label, defaultTemplate, channelConfigSchema? }`
   - `{ kind: "signalDetector",      scope: "habitat", detectorId, label, detects,  rateLimitDefaults, detectorConfigSchema? }`
   - `{ kind: "lifecycleInterceptor", scope: "habitat", phase, event, priority? }`
   - `{ kind: "customMcpTool",       scope: "system", toolName, description, inputSchema }`
   - `{ kind: "customHttpRoute",     scope: "system", method, path }`
   Each contribution carries its own `scope`. The manifest has NO top-level `scope` field — this is the "Mixed Plugin" doorway in CONTEXT.md.

2. **`PluginModule`** (`@orcy/api/src/plugins/types.ts`) is the dispatched-runtime object the entry file exports alongside the manifest: `{ manifest: PluginManifest, channels?: Record<channelId, ChannelHandler>, detectors?: Record<detectorId, DetectorHandler>, interceptors?: Record<interceptorId, InterceptorHandler>, mcpHandlers?: Record<toolName, (args) => Promise<unknown>>, routeHandlers?: FastifyPluginCallback }`. The split keeps manifest tekstak-free so audit rows can serialize the manifest shape without chasing function references, and lets the loader refuse to boot a manifest whose declared contributions have no matching handler in the module (fail-loud on the declaration/runtime gap).

3. **Per-contribution `scope`** — manifest top level is scope-less. A Mixed Plugin ships system-scoped channel + habitat-scoped detector in one bundle; the system contribution enables via `PLUGINS_ENABLED` at boot, and the habitat contribution enrolls per-habitat via the v0.22 enrollment REST surface. The two enablement paths are independent.

4. **`KanbanPlugin` is deleted and replaced.** No backward-compat layer. `auto-label` is rewritten in the same release (`plugins/auto-label/index.ts`) to match the new shape; its existing `hooks.onTaskCreated` becomes a `lifecycleInterceptor` contribution scoped `habitat` — demonstrating the non-detector habitat contribution kind without a second in-tree consumer.

## Rationale

- **Matches the v0.18 automation contract.** Using a `kind`-discriminated union mirror for contributions means the v0.22 loader, the v0.22 DB `plugin_contributions` row, and the audit projection all narrow with TS switch narrowing. No string-discriminator ad-hocery.
- **Per-contribution scope rejects both wrong shapes from Q1.** A plugin that wants both a Notification Channel and a Signal Detector exists naturally (a hypothetical "Microsoft Teams" plugin ships the Teams channel for server-side delivery AND a Teams-message frustration detector for per-habitat enrollment). Splitting it into two bundles (one system-scoped, one habitat-scoped) is authoring friction with zero enforcement upside — and forcing "one scope per manifest" makes the Mixed Plugin definition a lie.
- **Manifest/module split unblocks serializable audit.** `AuditEvent.auditSource = "plugin"` already needs to answer "which contribution, which kind, which scope?" cheaply and without serializing function closures. Putting only declarative fields on the manifest means the audit projection can persist `{ pluginId, version, kind, contributionId, scope }` as IQueryable fields on the audit row without touching the handlers. Storing handler references is exactly what `customMcpTools` got wrong.
- **Fail-loud on declared-but-unimplemented contributions.** A drift between the manifest claims ("I contribute channel `teams`") and the module (no `channels.teams` handler) is a recurring plugin-author bug class. The loader checks every declared contribution has a matching handler and refuses to load if any is missing, with an error naming the orphan declaration.
- **No backward-compat layer is the right call for v0.22.** The only existing in-tree consumer is `auto-label`, and it's in-tree (we own it). Maintaining a parallel `KanbanPlugin` shape alongside `PluginManifest` would mean two plugin typings, two loaders, two test paths for zero external plugin authors. Prerelease phase — no consumers to break.

## Alternatives considered

- **Flat `contributions: Record<string, unknown>[]` without a discriminator.** Rejected — TS can't narrow per-kind safely; runtime dispatch needs `kind in c && c.kind === "notificationChannel" && ...` chains instead of switch narrowing; reload-by-kind SQL queries degrade to LIKE patterns. Inconsistent with the v0.18 `AutomationAction` contract the codebase already proved works.

- **One file per contribution kind as separate plugin exports (`channels: NotificationChannel[]`, `detectors: SignalDetector[]`).** Rejected — vertically clean but ergonomically ugly when most plugins declare one contribution. Hides the "one module, multiple kinds" affordance that the Microsoft-Teams-plugin scenario above requires.

- **Keep `KanbanPlugin` shape alongside the new manifest for v0.22, deprecate in v0.23.** Rejected — backward-compat tax for zero external consumers plus double the test matrix. Prerelease phase means breaking changes ship between versions; this is the moment to land it.

- **Manifest-level `scope: "system" | "habitat"`; reject mixed bundles at load.** Rejected — the "(a)" per-contribution scope branch of Q2's three resolutions. Forces authors of legitimate multi-feature bundles (Microsoft Teams channel + Teams-aware detector) to publish two separate plugin directories that share most code through a hidden shared dependency. Pairs tighter with the v0.18 Notification Channels being server-global, but the tax on Detector authors is bigger than the load-rule simplicity.

## Consequences

- `packages/shared/src/types/plugin.ts` (new) owns `PluginManifest`, `Contribution`, per-kind contribution payloads, `PluginScope`. `@orcy/api` imports the manifest from the built shared package, same as `SIGNAL_TYPES`, `AGENT_TYPES`, `SKILL_CATEGORIES`.
- `packages/api/src/plugins/types.ts` loses `KanbanPlugin`, gains `PluginModule`, `ChannelHandler`, `DetectorHandler`, `InterceptorHandler`. The five per-kind handler interfaces declared here are the only surface plugins legally import from `@orcy/api` going forward (the v0.22 PluginContext, Q3 onwards).
- `pluginManager.loadPluginFromPath` validates the manifest/module pair: every declared contribution has a matching handler (fail-loud), `channelId`/`detectorId`/`toolName` collisions with already-loaded plugins are refused at load (logged via `pluginErrors`).
- `auto-label` rewrites as a `lifecycleInterceptor` contribution (scope: habitat, phase: post, event: taskCreated) — a real-world in-tree example of the non-detector habitat contribution kind, which means the auto-label plugin stops being enabled at boot env only, and becomes habitat-enrolled. Audit surfaces this change so existing docs / operators re-enroll it manually if they want suggestions.
- The `notificationDeliveryService.ts:52` switch is NOT migrated to the contribution registry in v0.22.0 (per Constraint #7: scope cap); the extraction surface is delivered (the registration interface exists, channel plugins can register, the existing in-tree channels stay hardcoded) and migration is a deepening patch (v0.22.1+) inside the Architecture Deepening planning block. This keeps v0.22 the single-feature release Constraint #7 asked for while still proving the platform surface.
- Mixed Plugin enablement is split across two storage spots: system contributions on `PLUGINS_ENABLED` boot env, habitat contributions on the new `habitat_plugin_enrollments` table (Q6 onwards). A mixed plugin can have its system contribution env-disabled while a habitat enrolls its detector contribution — the membership check handler must respect each path independently.
- Future ADRs will depend on this one: Q3 (PluginContext durable surface — see ADR-0012 for the capability whitelist itself), Q6 (detector enrollment + allowlist storage), Q8 (plugin audit + plugin_runs). Those will reference "per ADR-0011" when describing the manifest/module seam.

## Capability whitelist (refinement added during grilling Q3)

Each contribution's `requires: [...]` field is **NOT** an open menu of repo methods — it draws from a **vetted capability whitelist** declared in `@orcy/shared`. Adding a new capability to the menu is a deliberate code change to the shared package, not an automatic grant of every repo method as a capability. This is the v0.22 safety boundary for external/unvetted plugins: plugin authors pick from a fixed safe list and cannot invent, fork, or request capabilities Orcy core hasn't vetted.

The v0.22 whitelist (5 capabilities):
- `pulseReader` — `listByHabitatSince`, `listByHabitatBetween`, `getPulse`. Habitat-pinned, mutation-free.
- `pulseWriter` — `createDetectedSignal(input)`. Server injects `metadata.detected:true`, `metadata.detector:<pluginId>`. Rejects `signalType:"experience"` (agent-only). No update/delete.
- `commentReader` — `listByHabitatSince`. No mutation.
- `taskReader` — `getTask`, `listTasksByHabitat`. Auth fields stripped. No mutation.
- `habitatReader` — `getHabitat`. No mutation.

Universal context fields (always present, not capability-gated): `logger` (tagged with pluginId + runId) and `audit` (write-only — emits `AuditEvent(auditSource:"plugin", runId)` rows, cannot READ audit history).

Contribution-kind-specific fields (not capabilities, present because the kind implies them):
- `notificationPayload` for `notificationChannel` contributions — the parsed notification + recipient, NO DB access at all.
- `transition` for `lifecycleInterceptor` contributions — inspect-only `TransitionRef`.

The loader refuses to load a manifest whose contribution's `requires` field references a capability not on the whitelist or not allowed for that contribution kind (e.g. a detector requiring `notificationDelivery` — wrong kind). The TS type of a capability method is `undefined` unless declared — so a plugin trying to call an undeclared capability doesn't typecheck.

**Trust model:** the whitelist caps what a plugin can ask Orcy to do. It does NOT cap what the plugin author's own code does (Node built-ins, `process.env`, network, FS — all still available because Constraint #3 locks in-process execution). Operators who install plugins eat the same risk they eat for any `pnpm add` dependency. README + SECURITY docs state: "treat plugins like code dependencies; audit before installing." The whitelist is the contractual boundary; anything outside it is operator trust.

See ADR-0012 for the whitelist itself as a separate decision record.

## Risk

- **Auto-label re-enable friction:** existing habitats with the `auto-label` plugin active will see it disabled after v0.22 because the existing `hooks.onTaskCreated` shape no longer exists and the new scan path is habitat-enrolled. Mitigation: README/HUMAN-GUIDE note in v0.22 release materials; audit-emitted `plugin_failed_to_load` event for operators upgrading with the old plugin file still on disk.

- **Notification Channel extraction vs detection UX split:** the channel extraction surface ships but the in-tree `in_app`/`webhook`/`slack`/`discord` channels stay hardcoded, which means there will be two channel registration paths after v0.22.0 — one via the new contribution registry, one via the static switch. The deepening patch migrating the four existing channels to the registry will be a near-term v0.22.1 task.

- **Mixed Plugin authoring UX:** the mixed-scope split is clean in the manifest but the enrollment REST surface must not accidentally expose system-scoped contributions to habitat-enrollment routes (or vice versa). The v0.22 enrollment handlers refuse enrollment of a system-scoped contribution, and refuse boot env-enable of a habitat-scoped contribution. Test coverage must hit both directions.