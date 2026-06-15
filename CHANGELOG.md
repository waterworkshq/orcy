# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.19.3 — 2026-06-15

### Documentation

#### add comprehensive JSDoc documentation to type definitions ([`9427b86`](https://github.com/waterworkshq/orcy/commit/9427b86684d4f76d15ffd9c56b28f2267ab4f602))

1. Add detailed JSDoc comments to all type definitions in the shared package, providing clear descriptions of each interface, type, and enum. The documentation explains the purpose, usage, and relationships between types to improve developer understanding and IDE support.


#### add inline documentation to API services and type definitions ([`49dcfce`](https://github.com/waterworkshq/orcy/commit/49dcfcec491762fa005ec7f7e3711dc9306d4fb5))

1. Add detailed JSDoc comments to service functions and type definitions across the shared package and API services, improving code readability and developer understanding. The documentation explains function purposes, parameters, return values, and type semantics to enhance maintainability and IDE support.


#### add comprehensive JSDoc documentation to service functions ([`619d723`](https://github.com/waterworkshq/orcy/commit/619d723b979bc5c74d6c7ac9e3cbc0ccbcbcb865))

1. Add detailed inline documentation to all service functions across the API package, including clear descriptions of function purposes, parameters, return values, and side effects. The documentation follows JSDoc standards with proper type annotations and explains complex business logic to improve code maintainability and developer experience.


#### enhance service function documentation with detailed JSDoc ([`7ccd9c4`](https://github.com/waterworkshq/orcy/commit/7ccd9c46fa52a5bcf9069ba3033f0256cfef7260))

1. Add comprehensive inline documentation to all service functions across the API package, including clear descriptions of function purposes, parameters, return values, and side effects. The documentation follows JSDoc standards with proper type annotations and explains complex business logic to improve code maintainability and developer experience.


#### enhance tool documentation with comprehensive JSDoc ([`965bf32`](https://github.com/waterworkshq/orcy/commit/965bf32322993ddb59e5dd2cf533b2d2b579375d))

1. Add detailed JSDoc comments to MCP dispatch tools and handlers across the mcp package, describing their purpose, functionality, and relationship to underlying implementations. The documentation improves code maintainability and clarifies the architecture of the dispatch system for developers working with MCP tool integration.


#### add JSDoc to remaining dispatch files and utility modules ([`f0d0a9c`](https://github.com/waterworkshq/orcy/commit/f0d0a9cbb4f4f3983d876ead1117770bcca16edb))


#### add comprehensive JSDoc documentation to CLI commands and daemon modules ([`5c36a66`](https://github.com/waterworkshq/orcy/commit/5c36a66c67bbe7bb418e59cf2037ae5b9c7cbac6))

1. Add detailed JSDoc comments to CLI command registration functions and daemon modules, explaining their purpose, functionality, and relationships to underlying implementations. The documentation improves code maintainability and clarifies the architecture of the CLI and daemon systems for developers working with Orcy integration.


#### enhance service interfaces and function documentation ([`661a5a3`](https://github.com/waterworkshq/orcy/commit/661a5a3a7535f425a32cf753b39116db195bc90d))

1. Add detailed JSDoc comments to service interfaces and function implementations across API services, improving code readability and maintainability. The documentation clarifies the purpose, parameters, and return values of key functions in webhook dispatching, OAuth handling, task management, and integration services.


#### add JSDoc documentation to integration services and webhook handlers ([`567d9cc`](https://github.com/waterworkshq/orcy/commit/567d9cc255d461e888c613cb4023646611501b84))

1. Add detailed JSDoc documentation to integration adapters (GitHub, Jira, Linear), OAuth services, task management services, and webhook handlers, clarifying function purposes, parameters, and return values. The documentation improves code readability and maintainability across core API functionality.


#### add comprehensive JSDoc documentation to automation and notification services ([`b45f63d`](https://github.com/waterworkshq/orcy/commit/b45f63d54d094714b5f6eae73ec50e1df9bf949c))

1. Add detailed JSDoc documentation to automation services (context builder, evaluator, executor, simulation, template renderer) and notification services (delivery, clearance, command, digest, migration), clarifying function purposes, parameters, and return values. The documentation improves code readability and maintainability across core API functionality.


#### add comprehensive JSDoc documentation to core services ([`5bd40be`](https://github.com/waterworkshq/orcy/commit/5bd40beb9d65ac62a349e4c8ec5f089ecd7777c9))

1. Add detailed JSDoc documentation to core API services including analytics, audit, authentication, automation, board management, capacity planning, chat integrations, CI/CD, code evidence, comments, dependency tracking, Discord integration, effort tracking, event enrichment, feature comments, file storage, Git worktrees, habitat digests, session management, notification channels, quality gates, remote notifications, retry logic, scheduled tasks, secret management, shared grants, sprint analytics, subtasks, task scoring, suggestions, time tracking, trend analysis, and task watching. The documentation clarifies function purposes, parameters, return types, and behavior across the entire service layer.


#### enhance type documentation across shared and API packages ([`d814ad6`](https://github.com/waterworkshq/orcy/commit/d814ad6c8affd589420c3a890e5ecf6e94aa4b73))

1. Add detailed JSDoc documentation to type definitions and interfaces across shared and API packages, clarifying purpose, usage, and relationships between complex types including AgentQualitySignal, ForecastEstimate, RemoteGrantType, ParticipantStanding, and PodAffiliation. The documentation improves type discoverability and provides clear context for API consumers and developers working with these shared contracts.


#### mark v0.19.3 as released and remove from upcoming ([`8a136b5`](https://github.com/waterworkshq/orcy/commit/8a136b5d5b097fed72cccd1a508c2e9ef89688bb))



## 0.19.2 — 2026-06-15

### Documentation

#### update daemon interface types and documentation ([`9a202b2`](https://github.com/waterworkshq/orcy/commit/9a202b24ee5e6ad07548e1e7ed0f120836e311d4))

1. Add comprehensive JSDoc documentation to daemon interface types and implement strategy pattern for daemon operations. Update architecture documentation to reflect the new daemon interface seam with lazy loading, lifecycle management, and claim/heartbeat strategies.


#### expand documentation for automation, notifications, and shared habitat features ([`3865cfb`](https://github.com/waterworkshq/orcy/commit/3865cfb5c89da1fd861612acb5731baa187d23be))

1. Update README.md, CAPABILITIES.md, SKILL.md, TESTING.md, and TROUBLESHOOTING.md with comprehensive documentation for new features including workflow automation with event-driven rules, notification system V2 with multi-channel routing, Pod Bridge for secure remote collaboration, and testing patterns.


#### move v0.19.2 to Delivered, add v0.19.3 to Upcoming ([`cd20e76`](https://github.com/waterworkshq/orcy/commit/cd20e7689c5f3c0f49e60c9222aa14b8a8c0025c))



## 0.19.1 — 2026-06-15

### Documentation

#### update roadmap for v0.19.1 release ([`76506f8`](https://github.com/waterworkshq/orcy/commit/76506f8e8ad47afb56b6e5e13673973efbe0e427))

1. Add v0.19.1 release entry to ROADMAP.md with "Deepen: API → Daemon Interface Seam" theme. Update version number from v0.19.0 to v0.19.1. Include detailed description of daemon interface seam implementation including shared types migration, interface contracts definition, API migration, tick loop consolidation, and Zod schema derivation.



### Refactors

#### consolidate daemon types and interface contracts ([`f580bfe`](https://github.com/waterworkshq/orcy/commit/f580bfe8c3c5940fc89a7f623662cf812b05dd54))

1. Move `SessionStatus`, `ClaimResult`, `DetectedCli`, `RegisteredAgent`, `ActiveSession`, `ISessionUpdater` from `daemon/src/types.ts` to `shared/src/types/daemon.ts`. Add `AGENT_TYPES` / `SESSION_STATUSES` runtime arrays. Unify `CliType` with `AgentType`.

3. Define interface contracts `ISessionManager`, `ISessionUpdater`, `ICliDetector`, `IClaimStrategy`, `IHeartbeatStrategy`, `IPollLoop` in `@orcy/shared`. Daemon's `SessionManager` annotated `implements ISessionManager`.

5. Migrate API off concrete daemon by creating `api/src/daemon-wiring.ts` that calls `createSessionManager` from daemon at startup. API imports `ISessionManager` from shared, not the `SessionManager` class. `InProcessSessionUpdater` and `updateSessionStatus` propagate the shared `SessionStatus` type.

7. Consolidate tick loop by extracting `runPollTick` (shared pure async function taking `IClaimStrategy`) to replace duplicated `tick()` in daemon and API. Add `httpClaimStrategy` and `inProcessClaimStrategy` strategy classes.

9. Derive Zod schemas from `AGENT_TYPES` array to replace hardcoded enums in `api/src/models/schemas.ts`.

11. Remove runtime dependency on `"@orcy/daemon": "workspace:*"` from `api/package.json`.


#### implement interface contracts for session management and cli detection ([`60f1cb4`](https://github.com/waterworkshq/orcy/commit/60f1cb4683664542ccbd90ae70630ae0e502eb8f))

1. Add interface implementations to align daemon components with shared contracts. Update `SessionManager` to implement `ISessionManager` interface and export new factory functions for dependency injection.

3. The changes introduce proper interface contracts in `@orcy/shared` and implement them in the daemon package to improve type safety and consistency across the codebase.


#### centralize daemon component lifecycle management ([`25c1ca1`](https://github.com/waterworkshq/orcy/commit/25c1ca15db483622cf7697f179cdec79180a3534))

1. Introduce daemon-wiring module to manage session manager lifecycle and CLI detection with dependency injection. Replace direct daemon imports with type-safe interfaces from @orcy/shared/types to improve code consistency and maintainability.

3. The changes centralize daemon component initialization, enhance type safety through shared interface contracts, and provide proper resource cleanup mechanisms.


#### extract daemon polling logic to shared package ([`7b61add`](https://github.com/waterworkshq/orcy/commit/7b61add108d1f9f527dca02f62d10235596defc9))

1. Move claim and heartbeat strategy interfaces to shared types with HTTP and in-process implementations. Centralize polling functionality in shared package with runPollTick function. Update daemon and API components to use extracted interfaces and polling logic.


#### implement dynamic daemon module loading ([`af44041`](https://github.com/waterworkshq/orcy/commit/af44041ff2b5398370fcc6cda9411518427a57de))

1. Move daemon dependency from runtime to devDependencies and implement lazy loading pattern. Add initialization function that dynamically imports daemon module when needed. Update daemon factory functions to export proper interfaces for dynamic loading. Add interface compliance tests to ensure proper contract implementation.
