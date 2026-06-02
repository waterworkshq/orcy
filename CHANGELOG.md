# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.16.2 — 2026-06-02

### Bug Fixes

#### add missing mission gap handling actions and improve SSE event data ([`8e04b0e`](https://github.com/waterworkshq/orcy/commit/8e04b0ea90acd5b4af6a4e25c9eaf64f6c9fe5c5))

1. Add four new mission code evidence actions for managing evidence gaps:
2. mark-not-applicable: Mark mission evidence as not applicable with reason
3. clear-not-applicable: Clear not-applicable status from mission evidence
4. report-gap: Report a new evidence gap for a mission
5. resolve-gap: Resolve an existing evidence gap

7. Also include:
8. Add normalizeMissionId function to shared package for consistent ID handling
9. Add habitatId to code evidence responses for proper SSE event routing
10. Improve SSE event publishing to include full task/mission data instead of just IDs
11. Add pagination support (limit/offset) to effort entry queries
12. Add atomic findOrCreateActive pattern for code evidence links
13. Add required parameter validation to dispatch handlers
14. Update error handling to return structured error results instead of throwing


#### add actor_id validation for effort entries and improve repository consistency ([`f6b7b88`](https://github.com/waterworkshq/orcy/commit/f6b7b882b58c9212216ada76f7e46fdc48fd1fa2))

1. Require actor_id for human and agent effort entries in logEffort and
2. correctEffortEntry to ensure proper attribution.

4. Improve repository functions by:
5. Using transactions for atomic upsert operations in codeBranch and codeCommit
6. Using onConflictDoUpdate for codeEvidence upsert
7. Adding configurable limit parameters to all list queries with sensible defaults
8. Changing findByRepoAndName/findByRepoAndSha to return arrays for consistent behavior
9. Adding WorktreeSettingsPayload interface for type safety

11. Update tests to reflect new validation requirements and array return types.



### Refactors

#### extract shared CodeEvidencePanel component ([`5c27d4e`](https://github.com/waterworkshq/orcy/commit/5c27d4e2ad4cd970be26a505241026b3748b6817))

1. Consolidate duplicate TaskCodeEvidence and MissionCodeEvidence into a single
2. reusable component with unified styling, loading states, and error handling.
3. Also add batch insert operations to code evidence repositories, add confidence
4. validation, improve relative time formatting, and add effort query key helpers.



## 0.16.1 — 2026-06-01

### Bug Fixes

#### add habitat ID filtering and flatten MCP tool parameters ([`96f2035`](https://github.com/waterworkshq/orcy/commit/96f2035d789b22c2c6f25ea73924fc0c9099c5cb))

1. The repository query for code evidence completeness was incorrectly filtering only by targetType instead of both targetType and targetId. Added habitatId parameter to code evidence linking for proper repository lookup. Refactored effort routes to use Zod schema validation and added support for correcting effort entries. Flattened MCP tool parameters for better developer experience.



### Refactors

#### add optimistic locking with retry logic for concurrent updates ([`198ba2e`](https://github.com/waterworkshq/orcy/commit/198ba2e6711fc528cf97c81a5cafcbc08d9808d9))

1. Optimistic concurrency control with retry mechanism for task effort and time metric recalculation to prevent race conditions. Refactored recalculateTaskEffortMetrics and updateTaskTimeMetrics to check task versions and retry on conflicts. Also improved agent metrics calculation by replacing N+1 query pattern with aggregated SQL joins, and added safety checks for regex pattern matching in repository lookups.



## 0.16.0 — 2026-05-31

### Documentation

#### update documentation for code evidence system ([`2fb9446`](https://github.com/waterworkshq/orcy/commit/2fb9446e1d8e7211aaf85c02edeaef782e211ba5))

1. Adds comprehensive Code Evidence API reference with endpoints for
2. linking, listing, and managing code evidence against tasks and
3. missions. Updates architecture documentation to reflect new code
4. evidence tools, increased tool counts, and database schema expansion
5. to 62 tables. Extends database documentation with new code evidence
6. tables, foreign key relationships, and additional audit trail actions
7. for code evidence operations.


#### update documentation for effort logging and code evidence features ([`8ac26a6`](https://github.com/waterworkshq/orcy/commit/8ac26a6ddf78453b4440b23af02414906ef17b71))

1. Updates README, API reference, capabilities, database schema, roadmap, and
2. skill documentation to reflect v0.16 provenance features including effort
3. logging endpoints, code evidence linking, and completeness tracking. Adds
4. missing type imports for code evidence responses and fixes TypeScript
5. annotations in TaskCodeEvidence component.



### Features

#### add code evidence provenance tracking system ([`ac9d1ad`](https://github.com/waterworkshq/orcy/commit/ac9d1ade4b0067e5be27757365cae1e82c44737e))

1. Introduce a comprehensive code evidence provenance layer that tracks
2. the relationship between tasks/missions and their code artifacts
3. (branches, commits, PRs, reviews, changed files, pipeline runs).

5. Adds eight new database tables with Drizzle schema definitions,
6. repository layer with CRUD and upsert operations, a service layer
7. with URL parsing, commit trailer detection, deduplication, gap
8. tracking, completeness scoring, and correction workflows. Extends
9. existing pull_requests and pipeline_events tables with foreign keys
10. to the new provenance tables. Adds shared type definitions and SSE
11. event types for real-time evidence updates.


#### wire code evidence into webhooks, routes, and backfill pipeline ([`c3ca2c2`](https://github.com/waterworkshq/orcy/commit/c3ca2c21e7706a62490d42f2dbe839439644c7a5))

1. Connect the code evidence subsystem to the rest of the application by
2. registering REST route handlers for task/mission evidence and repository
3. settings, piping GitHub and GitLab webhook events through the evidence
4. linking service, and implementing the backfill routine that migrates
5. existing pull requests and pipeline events into the evidence model.

7. Also fixes a bug where habitatId was hardcoded as an empty string when
8. creating evidence links from webhooks, adds getAll() queries to PR and
9. pipeline repositories needed by backfill, and extends MissionEventAction
10. with code evidence lifecycle actions.


#### add code evidence tools to task and mission dispatch ([`0b927d1`](https://github.com/waterworkshq/orcy/commit/0b927d1e01594528d1f95538c7af53eb71d8fde9))

1. Exposes code evidence linking, listing, correction, not-applicable
2. marking, gap reporting, and gap resolution through MCP dispatch
3. tools for both tasks and missions. Includes new KanbanApiClient
4. methods, tool definitions, and comprehensive test coverage.


#### add code evidence panels to task and mission detail views ([`15fb03d`](https://github.com/waterworkshq/orcy/commit/15fb03d34a7a7c2171e8b2323ffd8a947a539482))

1. Adds TaskCodeEvidence and MissionCodeEvidence components with support
2. for linking code, correcting links, reporting gaps, and marking items
3. as not applicable. Includes new RepositoryTab in habitat settings for
4. managing repository identity configuration.


#### add effort tracking system with logging and reporting ([`a8a27cc`](https://github.com/waterworkshq/orcy/commit/a8a27cc9dd77f3d3a9a5d12c11f851ad7e0d54e9))

1. Adds effort entry tracking for tasks with support for human and agent
2. contributions, correction adjustments, and comprehensive reporting.
3. Includes database migration, repository and service implementations,
4. quality gate integration, and real-time SSE event broadcasting.


#### add REST endpoints for effort reporting and entry corrections ([`97e1cda`](https://github.com/waterworkshq/orcy/commit/97e1cda7721ce22bca3b59897ff0259b0f239576))

1. Implements effort tracking API with routes for retrieving task effort reports, listing effort entries with optional correction inclusion, logging new effort entries, and applying correction adjustments. Includes comprehensive test coverage for repository, service, and route layers, plus integration with task lifecycle metrics calculation.


#### add effort tracking actions to task dispatch and lifecycle tools ([`321df3b`](https://github.com/waterworkshq/orcy/commit/321df3b2602027134bb743124e02d97fefb06fee))

1. Adds log-effort, list-effort, get-effort-report, and correct-effort-entry actions
2. to the task dispatch tool with corresponding KanbanApiClient methods and tool
3. implementations in lifecycle-gaps.ts. Includes comprehensive test coverage for the
4. new dispatch actions and effort tool functions. Accompanied by UI integration through
5. TaskEffortSection component, React Query hooks, and updated type definitions for
6. effort data management across the stack.
