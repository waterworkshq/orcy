# customMcpTool Contribution — Validated-Only in v0.22.0, Cross-Process Wiring Deferred

Status: accepted · 2026-06-29

Depends on: ADR-0011 (Plugin Manifest V1 — `customMcpTool` in contribution kind union), ADR-0017 (Notification Channel extraction — same "ship surface, wire later" pattern)

## Context

ADR-0011 enumerates 5 contribution kinds on the `PluginManifest` discriminated union: `notificationChannel`, `signalDetector`, `lifecycleInterceptor`, `customMcpTool`, `customHttpRoute`. Four of them wire cleanly in v0.22.0:

- `notificationChannel` — `channelRegistry` sub-sumption in `notificationDeliveryService.ts:52` per ADR-0017. API-process-local dispatch.
- `signalDetector` — trigger-fire-and-forget dispatcher in API process per ADR-0015. API-process-local.
- `lifecycleInterceptor` — pre-veto + post-emit wired into `transition-emitter.ts` per ADR-0014. API-process-local.
- `customHttpRoute` — same pattern as the v0.21 `KanbanPlugin.customRoutes` FastifyPluginCallback registration at `pluginManager.initializePlugins` (`plugins/pluginManager.ts:121-133`). API-process-local via `fastify.register(plugin.customRoutes)`.

The fifth kind, `customMcpTool`, has a non-trivial wiring question. The MCP server (`packages/mcp/src/index.ts:TOOL_HANDLERS`) runs as a **separate process** from the API server. Plugins load in the API process memory; the MCP process cannot directly reference loaded plugin handlers. Custom MCP tool calls from agent clients arrive at the MCP process, which today dispatches via a static `TOOL_HANDLERS` map of in-tree handlers. There is no path for the MCP process to invoke a handler declared by an API-process-loaded plugin without inter-process communication.

Grilling post-PRD surfaced this as the one design fork where the PRD's "ship surface, wire later" framing needs explicit architectural decision. Three options:

1. **v0.22.0 ships kind-validate-only.** Manifest can declare `customMcpTool`; loader validates the contribution's `{ toolName, description, inputSchema, handler }` shape; contribution registered in `pluginManager`'s in-memory map; no MCP server integration. v0.22.1+ adds the API-boot-query + REST-route-back wiring pattern (new REST endpoint `GET /api/plugins/mcp-tools` returns registered tool definitions; MCP server queries at boot + periodically; tool calls from agent clients route to a new dispatcher endpoint `POST /api/plugins/mcp-tools/:toolName/invoke` which looks up the registered handler and dispatches).
2. **v0.22.0 ships full wiring.** MCP server queries API at boot for plugin MCP tool definitions, registers them dynamically, routes calls via REST round-trip per invocation. Adds infra in v0.22.0 — REST endpoints, MCP-server-side boot integration, dispatcher. Violates Constraint #7 (single-feature-release cap; PRD already defines the 4 in-scope pillars).
3. **v0.22.0 drops `customMcpTool` from ADR-0011's kind union.** Manifest enumerates 4 kinds; `customMcpTool` added in v0.22.1 ADR. Breaks the discriminated union's completeness principle; a future contributor adding the kind later means a manifest union addition that external plugin authors targeting v0.22.0 don't see. Less honest than Option 1.

## Decision

**v0.22.0 ships `customMcpTool` as a kind-validate-only contribution on the discriminated union. The loader accepts it; the manifest authoring surface supports it; the MCP server does NOT integrate custom MCP tool dispatch in v0.22.0. The full wiring (REST endpoints + MCP-server-side boot integration + dispatcher) is deferred to v0.22.1+ per the patch constraints recorded in `docs/plans/v22/PATCH-CONSTRAINTS.md`.**

Concretely:
- `packages/shared/src/types/plugin.ts` — the `Contribution` discriminated union includes `{ kind: "customMcpTool", scope: "system", toolName: string, description: string, inputSchema: Record<string, unknown> }` as a first-class variant. Plugins CAN declare it.
- `packages/api/src/plugins/types.ts` — the `PluginModule` interface includes `mcpHandlers?: Record<toolName, (args: Record<string, unknown>) => Promise<unknown>>`. Plugins CAN export handlers.
- `pluginManager.validatePlugin` — validates that every declared `customMcpTool` contribution has a matching entry in `pluginModule.mcpHandlers` (fail-loud on declaration/runtime gap, same as the other kinds per ADR-0011). The contribution loads.
- `pluginManager.getCustomMcpTools()` — already exists at `plugins/pluginManager.ts:146`. Returns the array of `McpToolDefinition` objects from loaded plugins. This method is unchanged in v0.22.0 — it returns what it returns.
- **The MCP server does NOT consume `getCustomMcpTools()` in v0.22.0.** `packages/mcp/src/index.ts:TOOL_HANDLERS` remains a static in-tree map. The `orcy_*` count stays at 20 (per README "20 MCP tools" badge); custom MCP tools from plugins do NOT extend the count in v0.22.0.
- **No new REST endpoints for tool-definition query or tool-dispatch invocation in v0.22.0.** These land in v0.22.1+.

v0.22.1 wiring plan (NOT a v0.22.0 deliverable — recorded here so the future session doesn't re-litigate):

1. Add `GET /api/plugins/mcp-tools` REST route returning the array of `{ toolName, description, inputSchema }` for all loaded `customMcpTool` contributions across all enabled plugins. This is read-only; no plugin-handler invocation on this route.
2. MCP server boot sequence (`packages/mcp/src/index.ts`) gains a step after the existing tool registration: query `GET /api/plugins/mcp-tools` against the configured API URL; for each returned tool, register it in the MCP `TOOL_HANDLERS` map with a dispatcher handler that routes to `POST /api/plugins/mcp-tools/:toolName/invoke`.
3. Add `POST /api/plugins/mcp-tools/:toolName/invoke` REST route in the API process. Body is `{ args: Record<string, unknown> }`. The route looks up the registered handler in `pluginManager`'s in-memory map and dispatches with the constructed `PluginContext`. The handler's return value is forwarded as the MCP tool call response.
4. MCP server periodically re-queries `GET /api/plugins/mcp-tools` (e.g. every 60 seconds, configurable) to pick up plugins loaded/unloaded after MCP server boot. Tool definitions added between polls become available after the next poll; tool definitions removed become unavailable after the next poll. Mid-poll tool calls to removed tools return a "tool not found" error.

This wiring is recorded here as the v0.22.1 plan; the v0.22.1 session owns implementation. v0.22.0 ships with the kind on the union + the loader validation + the `getCustomMcpTools()` API existing (unchanged from v0.21) + zero MCP server integration.

## Rationale

- **The discriminated union must enumerate all 5 kinds for SDK completeness.** External plugin authors targeting v0.22.0 who want to ship a `customMcpTool` plugin alongside other contributions should see the kind on the union with full TypeScript types, even if dispatch isn't wired. They can write + compile + load-test their plugin; tool calls fail with a clear "custom MCP tool dispatch not wired in v0.22.0; lands in v0.22.1" error. Better than Option 3 (drop the kind) which forces them to wait for v0.22.1's manifest contract update before they can even compile.
- **v0.22.0 single-feature cap (Constraint #7) excludes the cross-process wiring.** Adding REST endpoints + MCP-server boot integration + periodic re-query + a dispatcher is meaningful new infra. PRD's 4 pillars (Plugin Platform, Custom Signal Detectors, Notification Channel Surface, Documentation) don't include it. Deferring to v0.22.1 matches the same "ship surface, wire later" pattern ADR-0017 used for Notification Channel surface-vs-migration.
- **Honest about the contract.** Option 1 keeps the discriminated union complete (5 kinds), validates + loads `customMcpTool` contributions, AND is explicit that dispatch isn't wired. A plugin author who ships a `customMcpTool` plugin against v0.22.0 sees the tool register in `pluginManager.getCustomMcpTools()` output but the MCP server doesn't surface it. The error message at agent-call time is "tool not found" — that's the contract. v0.22.1 makes it work.
- **Forward compatibility.** v0.22.0-loaded `customMcpTool` plugins do not need re-authoring when v0.22.1 ships the wiring. The manifest shape is unchanged; the `mcpHandlers` export shape is unchanged; the only delta is the MCP server consuming what was already exposed.

## Alternatives considered

- **Option 2 — Ship full wiring in v0.22.0 (reject).** Violates Constraint #7. Adds cross-process infra (REST endpoints, MCP-server boot polling, dispatcher route, context-construction path for MCP-routed handler invocations). Cross-process handler invocation means the `PluginContext` is constructed on the API side via the MCP-dispatcher route, not on the MCP side — the existing `pluginManager.dispatchDetectionEvent` + `runPreInterceptors` + channel-registry seams are API-process-local; the MCP-dispatcher route joins them as another entry point. Worth doing in v0.22.1 cleanly, not crammed into v0.22.0.

- **Option 3 — Drop `customMcpTool` from ADR-0011's kind union in v0.22.0 (reject).** Discriminated union completeness matters for the SDK contract. Dropping and re-adding later means external plugin authors targeting v0.22.0 see a 4-kind union and can't compile a `customMcpTool` plugin at all; when v0.22.1 adds the kind, their plugin works but they had to wait. Option 1 lets them compile + load-test now; dispatch arrives in v0.22.1.

- **Hybrid: ship kind-validate-only AND a minimal dispatcher that fails with a typed error.** v0.22.0 returns `{ error: "custom MCP tool dispatch not wired in v0.22.0; lands in v0.22.1" }` for any agent-side call to a custom tool name. Slightly better UX than "tool not found" because it's informative. **Accepted as part of Option 1** — the MCP server's tool-name lookup path returns this typed error for names registered in `pluginManager.getCustomMcpTools()` (queried once at MCP boot via existing log line, no REST endpoint needed in v0.22.0). This is a no-cost UX improvement; the v0.22.1 wiring replaces the typed error with the actual dispatcher.

## Consequences

- `packages/shared/src/types/plugin.ts` — `Contribution` discriminated union includes `customMcpTool` variant with `{ kind, scope: "system", toolName, description, inputSchema }`. (Same as if dispatch were wired — the manifest shape is forward-compatible.)
- `packages/api/src/plugins/types.ts` — `PluginModule` includes `mcpHandlers?: Record<toolName, (args) => Promise<unknown>>`. Forward-compatible.
- `packages/api/src/plugins/pluginManager.ts` — `validatePlugin` validates the manifest/module pairing for `customMcpTool` (every declared toolName has a matching handler in `mcpHandlers`). `getCustomMcpTools()` already exists at line 146 and continues to return the array. No new code needed for v0.22.0's validate-only contract.
- `packages/mcp/src/index.ts` — `TOOL_HANDLERS` remains the static in-tree map of 20 `orcy_*` tools. Custom MCP tool names are NOT registered. If the MCP server has any visibility into loaded plugin names (e.g. via a boot-time log scrape — unlikely in v0.22.0), the typed-error path from the "Hybrid" alternative above is the UX; otherwise agent clients see standard "tool not found" from the MCP protocol.
- **No REST endpoints added in v0.22.0 for MCP tool definition query or dispatch.** Those land in v0.22.1 per the wiring plan above.
- Tests must cover: loader accepts a manifest declaring `customMcpTool` contribution with matching handler; loader refuses a manifest declaring `customMcpTool` without matching handler (fail-loud per ADR-0011); `getCustomMcpTools()` returns the array. No tests for actual MCP dispatch (no dispatch in v0.22.0).
- README "20 MCP tools" badge stays accurate for v0.22.0. v0.22.1 may bump the count if reference plugins ship custom MCP tools; PRD for v0.22.1 owns that decision.
- v0.22.1 implementation session references this ADR for the wiring plan; the v0.22.1 PRD will cite this ADR's wiring section as locked design.

## Risk

- **Plugin authors may ship `customMcpTool` plugins against v0.22.0 expecting dispatch.** They'll discover at agent-call time that dispatch isn't wired. Mitigation: README plugin section + ADR + `docs/plans/v22/PATCH-CONSTRAINTS.md` explicitly state "v0.22.0 validates + loads; v0.22.1 wires dispatch." Plugin authors who read the docs know; plugin authors who don't hit "tool not found" and find the answer in the v0.22.0 release notes.
- **`getCustomMcpTools()` returns a non-empty array in v0.22.0 but the MCP server ignores it.** This is intentional but might confuse an operator inspecting `GET /api/plugins` and seeing `customMcpTools: [...]` in the loaded plugin manifest output. Mitigation: the loaded-plugins response from `GET /plugins` includes the same array; docs clarify dispatch-vs-load distinction.
- **v0.22.1 wiring plan is recorded here but not ADR-bound.** A future session could re-litigate the wiring shape (REST-poll vs WebSocket-push vs file-watch). The wiring plan in this ADR is the recommended approach; the v0.22.1 PRD owns the final shape. If the v0.22.1 session chooses a different wiring, it supersedes the plan section of this ADR but the v0.22.0 contract (kind-validate-only) stands regardless.