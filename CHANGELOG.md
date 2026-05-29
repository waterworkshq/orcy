# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.15.2 — 2026-05-29

### Bug Fixes

#### enforce strength constraints and hash-based normalization for dedup ([`5ce109c`](https://github.com/waterworkshq/orcy/commit/5ce109cd6ed95b98c7825be670b9c10502a8d86d))

1. Add CHECK constraints to both skill tables ensuring strength values stay within [0,1].
2. Change normalize() to use an 80‑character prefix with a deterministic hash suffix for collision‑resistant deduplication.
3. Refactor single‑row repository queries to use .get() instead of .all().
4. Extract a reusable StrengthBar component and improve SkillPanel accessibility with ARIA roles and keyboard navigation.
5. Initialize skill event hooks explicitly on server startup.
6. Add a listSkillSignals method to the MCP API client.



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
