# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

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



## 0.19.0 — 2026-06-14

### Documentation

#### update roadmap with v0.18.1-0.18.3 releases ([`6501ecb`](https://github.com/waterworkshq/orcy/commit/6501ecb1a8cc01fb109ea5cd802dbe2433cdcf4a))


#### update documentation for v0.19 "Pod Bridge" and v0.20 "Orchestrated" releases ([`9c86669`](https://github.com/waterworkshq/orcy/commit/9c8666905b358f3cce28b60dc4be738a7ed9c470))

1. This update reflects the refined product direction for upcoming releases:
2. v0.19 "Pod Bridge" focuses on optional provider login, trusted pod access, and shared habitat API
3. v0.20 "Orchestrated" emphasizes multi-agent handoffs, fan-out/fan-in, and review chains

5. The changes include:
6. Updated CONTEXT.md with new definitions for pod affiliation, participant standing, and remote contributor concepts
7. Revised README.md release themes to match the new direction
8. Updated docs/ROADMAP.md with refined feature descriptions and rationale


#### add Pod Bridge documentation for v0.19 release ([`7961393`](https://github.com/waterworkshq/orcy/commit/7961393534da5ec8e7cea7fd43c491643eb55b41))

1. Update README.md to reflect v0.19 release theme and remove v0.19 from future releases
2. Add comprehensive Shared Habitat API documentation with authentication, authorization, and idempotency details
3. Document Pod Bridge database schema including identity providers, remote participants, and grants
4. Update roadmap to include completed v0.19.0 "Pod Bridge" release
5. Add remote access security documentation covering provider scopes, credential management, and grant isolation



### Features

#### implement pod bridge schema and repositories ([`9dcd869`](https://github.com/waterworkshq/orcy/commit/9dcd8694f46917f5ca3d113a72f8695f045bb644))

1. add comprehensive database schema and repository layer for pod bridge functionality including:
2. identity providers and external identities
3. remote pods, participants, and credentials
4. remote grants, invites, and idempotency keys
5. webhook endpoints for remote pod interactions

7. update audit types to support remote pod actors and actions
8. export new pod bridge types from shared package


#### implement remote participant authentication ([`c812c04`](https://github.com/waterworkshq/orcy/commit/c812c040dd8f27fdbb5ab7f2e8b2cefc06d2fe42))

1. add remote authentication middleware and service for pod bridge functionality:
2. remote participant authentication with x-orcy-remote-key header
3. remote credential validation and connection verification
4. habitat access authorization for remote participants
5. audit provenance context updates for remote actor types

7. update audit provenance to support remote actor references
8. add comprehensive tests for remote authentication flow


#### add remote access and shared invite functionality ([`2cef7a0`](https://github.com/waterworkshq/orcy/commit/2cef7a063bed251e909dc8690895676d08f8db20))

1. implement new remote access routes and services for pod bridge:
2. add remote access routes for authentication and authorization
3. implement shared invite routes for habitat access
4. create identity provider service for remote participant validation
5. add remote invite service for generating and managing access tokens
6. implement mcp config service for remote participant configuration
7. add remote access admin service for managing remote participants
8. create share habitat readiness service for access verification
9. include comprehensive tests for remote access functionality


#### enhance remote access and shared invite functionality ([`364c03f`](https://github.com/waterworkshq/orcy/commit/364c03f0768800cc11808e8c4a6bd0642e3b6962))

1. Add habitat ID validation in remote authentication middleware
2. Prevent local_member standing for remote participants
3. Improve error handling with generic messages for security
4. Add periodic re-validation for remote SSE connections
5. Implement atomic invite acceptance to prevent race conditions
6. Add transaction safety for credential rotation and grant operations
7. Improve idempotency key handling with conflict resolution
8. Add inline expiry checks for credentials
9. Enhance invite preview endpoint with proper token handling
10. Add reachability profile detection for VPS reverse proxy scenarios
11. Improve error handling and logging throughout remote access components
12. Add comprehensive input validation with Zod schemas
13. Enhance security by masking sensitive data in credential responses


#### extend schema and services to support remote participants ([`8a3ef9b`](https://github.com/waterworkshq/orcy/commit/8a3ef9b559ce35c197e910fa9904d57767e8a6fa))

1. Add "remote_human" and "remote_orcy" actor types across all schemas
2. Introduce remote participant assignment for tasks
3. Create shared API routes for remote participant access
4. Implement remote-specific task operations (claim, start, submit)
5. Add idempotency middleware for safe remote operations
6. Extend comment services to support remote authors
7. Add remote configuration support for MCP clients
8. Create remote client implementation for external participants
9. Add comprehensive tests for remote functionality
10. Update type definitions to include remote participant types


#### implement remote webhook delivery system ([`1d1bce4`](https://github.com/waterworkshq/orcy/commit/1d1bce4bb0f6f91c435b30c54b1c6156be5b639f))

1. Add remote webhook delivery schema and repository
2. Create remote webhook routes for endpoint management
3. Implement compact webhook dispatcher for remote events
4. Add remote notification resolver for recipient discovery
5. Extend notification service to support remote participants
6. Add webhook delivery tracking and retry mechanisms
7. Include comprehensive tests for webhook functionality
8. Update notification types to include remote actor types


#### enhance audit provenance with remote participant context ([`0564d12`](https://github.com/waterworkshq/orcy/commit/0564d1270cfeacefe837ef875752b1687983d07a))

1. Add 'remote_pod' actor type to all relevant schema enums
2. Implement remote audit context tracking in authentication middleware
3. Extend audit export and query services to support remote actor types
4. Add remote metadata to audit provenance for complete attribution
5. Create comprehensive test suite for remote audit functionality
6. Update event types and services to handle remote participant actions
7. Enhance code evidence linking to support remote sources
8. Add remote actor display name resolution in audit queries


#### add remote access management interface and functionality ([`4bcf60a`](https://github.com/waterworkshq/orcy/commit/4bcf60a954c5cf3f290548cec88a5a249c753ffc))

1. Add new RemotePodsPage component for managing remote pod connections
2. Implement remote access API endpoints for pods, grants, and participants
3. Add remote participant types and actor references to UI components
4. Update comment sections to display remote user indicators
5. Add remote access query keys and data fetching hooks
6. Enhance audit export modal to filter by remote actor types
7. Update navigation to include remote pods section
8. Add comprehensive test suite for remote access functionality


#### enhance webhook security with encrypted secrets ([`48e147d`](https://github.com/waterworkshq/orcy/commit/48e147d25e1d187e1fcf71fa0ece087f365c4910))

1. Add encrypted secret storage for webhook endpoints to improve security
2. Implement secret encryption and decryption utilities for sensitive data
3. Add webhook URL validation to prevent private network access
4. Update remote access grant revocation with more flexible modes
5. Improve error handling for remote idempotency in shared API routes
6. Enhance cleanup logic in remote invite services when pod creation fails
7. Remove outdated grant visibility rules for mission-level access



### Refactors

#### improve idempotency handling and remote access management ([`9afb191`](https://github.com/waterworkshq/orcy/commit/9afb191fba373d9e8c18fd2b5235dd210d066b30))

1. Replace JSON response body storage with raw text in remote idempotency keys
2. Implement stable stringify function for consistent request hashing
3. Add grace period logic for remote access grants
4. Improve error handling in remote idempotency middleware
5. Add index for remote assigned participant in task schema
6. Enhance team middleware with better error messages
7. Update remote webhook delivery to exclude signature from list results
8. Add URL validation for evidence links in shared API
9. Implement stricter schema validation for remote access routes
10. Remove remote participant context from audit metadata in shared API routes
