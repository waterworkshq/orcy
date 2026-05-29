# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.15.1 — 2026-05-29

### Bug Fixes

#### add input validation, error handling, and security improvements ([`f220f5c`](https://github.com/waterworkshq/orcy/commit/f220f5c92986eafd31d48e4b8187b7750a5a387d))

1. Introduce Zod schemas for contribution and signals request validation
2. Return unsubscribe functions from event hooks (comment, pulse, task)
3. Convert regenerateAllSkills to async with setImmediate yield
4. Add error states and retry buttons to skill panel UI
5. Incorporate rehype-sanitize for safe HTML rendering
6. Enforce valid skill categories in MCP tool and repository
7. Update API client return types for habitat skill endpoints



## 0.15.0 — 2026-05-29

### Bug Fixes

#### prevent duplicate skill records and add habitat ownership validation ([`1361aa5`](https://github.com/waterworkshq/orcy/commit/1361aa5c6114d9acd90d19da7821bdcabc271e73))

1. Add unique index on habitat_skills.habitat_id and unique composite index on habitat_skill_signals (habitat_id, cluster_key) via migration 0016
2. Fix race condition in getOrCreateSkill with catch-and-retry logic
3. Validate habitat existence in all skill routes (GET, regenerate, contribute, signals, delete)
4. Return forbidden error when attempting to delete a signal belonging to a different habitat
5. Track cross-mission counts for signals derived from multiple mission contexts
6. Ingest task success signals on completed/approved events alongside existing rejection handling
7. Improve SkillPanel collapse button accessibility: role="button", keyboard support, aria-expanded



### Documentation

#### update project documentation for habitat skill feature ([`ae6bfe0`](https://github.com/waterworkshq/orcy/commit/ae6bfe05c152603d356c33609d4c77a5a3cbca2a))

1. README.md: update MCP tool count to 15, add skill description
2. API.md: add Habitat Skills API section with CRUD endpoints
3. ARCHITECTURE.md: update layer descriptions, add SkillPanel to UI
4. CAPABILITIES.md: add Dynamic Habitat Skills capability
5. DATABASE.md: add habitat_skills and habitat_skill_signals tables
6. PROJECT-STRUCTURE.md: update file counts and directories
7. ROADMAP.md: add v0.15.0 entry, remove duplicate upcoming section
8. SKILL.md: add orcy_habitat_skill tool documentation and agent protocol updates



### Features

#### add habitat skill knowledge base with pulse-signal clustering ([`cda4a79`](https://github.com/waterworkshq/orcy/commit/cda4a79991cda63cfc2a555f123b75006770ff14))

1. Introduce a habitat skill system that accumulates project knowledge (conventions,
2. patterns, pitfalls) from pulse signals and agent observations. Includes new
3. database tables, REST endpoints for get/refresh/contribute, a scheduler-based
4. regeneration service, pulse and comment hook integration, CLI commands, MCP
5. tools, and a SkillPanel UI component.



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
