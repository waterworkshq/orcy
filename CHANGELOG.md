# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.15.3 — 2026-05-29

### Bug Fixes

#### resolve stale cross-mission counts, FK retry loop, and signal matching gaps ([`8bf26d8`](https://github.com/waterworkshq/orcy/commit/8bf26d8320efe8d6d8bb30a3c2008529abfc0558))

1. Defer cross-mission count updates to scoreAllSignals batch pass
2. instead of per-ingest to avoid stale intermediate values
3. Prevent infinite retry on foreign key constraint violations in
4. getOrCreateSkill by re-throwing FK errors immediately
5. Match task success signals against existing "Rejection:" and
6. "Failure:" prefixed cluster keys to link outcomes correctly
7. Correct MCP client to read skill properties from nested skill
8. object instead of top-level response
9. Rename list endpoint response key from "items" to "signals"
10. Include signal limit in UI query key for proper cache isolation
11. Export escapeMarkdown utility from service module



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
