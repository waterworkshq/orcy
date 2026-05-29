# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.14.0 — 2026-05-29

### Features

#### add cursor/gemini agent types and daemon persistence layer (v0.14 Phase 1-2) ([`b9db4a8`](https://github.com/waterworkshq/orcy/commit/b9db4a84e3fb9b8a7314082e905a58a91f0ed36d))

1. Phase 1 — Shared Agent Type Expansion:
2. Add cursor and gemini to AgentType in shared, API schema, zod validation,
3. MCP constants/tools/api, and UI API client (7 files)

5. Phase 2 — Daemon Persistence and Auth:
6. Add daemon_instances, daemon_agents, daemon_sessions DB schema with
7. Drizzle relations and migration 0014_daemon.sql
8. Add daemon token helpers (generate, hash, verify)
9. Add daemon auth middleware (X-Daemon-Token header validation)
10. Add daemon repository with full CRUD for instances, agents, sessions
11. Add 31 tests covering token helpers, repository operations, and auth


#### add daemon registration, heartbeat, and session endpoints ([`294ade7`](https://github.com/waterworkshq/orcy/commit/294ade7a4e7efcdb7e39510bb09ebd3a0eaced45))

1. Introduce daemon management routes including CLI detection registration,
2. heartbeat updates, task claiming, and session lifecycle. Add Zod validation
3. schemas and corresponding unit tests.


#### implement daemon core modules with API client, CLI detection, and persistence ([`84b8024`](https://github.com/waterworkshq/orcy/commit/84b8024dcbc12d71a9df65d64a8588090cb706c4))


#### add workdir management and MCP config preparation (v0.14 Phase 5) ([`b425d11`](https://github.com/waterworkshq/orcy/commit/b425d11de0b5c31600ee11162b59c45defa0cea1))


#### feat(daemon): add autonomous daemon for unattended AI CLI execution
- Session lifecycle: adapters, manager, spawner for CLI processes
- Poll loop: claim tasks, spawn sessions, monitor progress
- Recovery: handle orphaned sessions on restart
- API: GET /daemon/sessions, session progress in heartbeat
- CLI: daemon detect/register/start/stop/status commands
- Scheduler: daemon nudging and habitat digest generation
- Docs: HUMAN-GUIDE, INSTALL, README for autonomous mode ([`c6953d0`](https://github.com/waterworkshq/orcy/commit/c6953d0c60eea98f4937eb719a4da09d7d39b625))


#### add in-process daemon engine, UI controls, and worktree settings ([`230b1bb`](https://github.com/waterworkshq/orcy/commit/230b1bbb1e341afc43e5c6cf93189ddbf18c7a14))

1. Add daemonEngine and inProcessSessionUpdater for API-side daemon runtime
2. Add /daemons/* human-admin routes for setup, start/stop, status, CLI detection
3. Add DaemonSection, DaemonCard, DaemonSetupDialog, WorktreeTab UI components
4. Replace direct DaemonApiClient dependency with ISessionUpdater interface
5. Enforce maxConcurrency and per-agent session dedup in claim-next endpoint
6. Persist pid, workdir, cliSessionId in daemon session updates
7. Update documentation for autonomous mode, first-run setup, and UI daemon management
8. Fix docs: board→habitat, bun:sqlite→better-sqlite3, tool count, default credentials
9. Add aria-label/aria-labelledby to ToggleSwitch for accessibility



## 0.13.1 — 2026-05-28

### Tests

#### add unit tests for services, webhooks, repositories, and event modules ([`3286176`](https://github.com/waterworkshq/orcy/commit/3286176cfe2b7264c1e05cc62daeba688bb0b05b))



## 0.13.0 — 2026-05-26

### Features

#### add Jira & Linear adapters, OAuth, and intake review UI ([`a1fe61f`](https://github.com/waterworkshq/orcy/commit/a1fe61f81259b604c614962aab9452a78dce04ba))

1. Adds Jira Cloud and Linear issue adapters, extending the external intake
2. system from v0.12 with full provider-specific implementations:

4. Jira Cloud adapter: JQL search, ADF text extraction, API token/basic auth
5. and OAuth 3LO flows with environment-level client secret configuration
6. Linear adapter: GraphQL queries, cursor pagination, OAuth PKCE public-client
7. flow (no client secret required)
8. Shared OAuth infrastructure: callback server (port 17530), PKCE state store,
9. code verifier management
10. Intake candidate review UI: promote/ignore/clarify actions with dedicated
11. habitat filter view
12. CLI `orcy integrations connect` and `orcy integrations guide` subcommands
13. Provider connection panels for Jira and Linear in Habitat Settings UI
14. New API routes and repositories for intake candidates and OAuth orchestration
15. Updated documentation (README, CONFIGURATION, SECURITY, ROADMAP to v0.13)
16. Test coverage for all new modules and route handlers
