# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.16.4 — 2026-06-02

### Features

#### add repository error handling and SQLite error mapping ([`1d644c5`](https://github.com/waterworkshq/orcy/commit/1d644c5b1ff1463ae7c698ae007e82d810408884))

1. This change introduces a comprehensive error handling system for database operations in the API layer. It adds:

3. 1. A new `RepositoryError` class that wraps database errors with contextual information (entity, operation, ID)
4. 2. Factory functions for creating specific repository errors (create, update, delete, upsert, read, transaction)
5. 3. SQLite error detection and mapping to appropriate HTTP status codes
6. 4. Enhanced error logging with additional context in the global error handler
7. 5. Updated all repository functions to use the new error handling pattern

9. The changes improve error reporting by providing more specific error messages and better context when database operations fail, making it easier to diagnose and handle issues in the application.



## 0.16.3 — 2026-06-02

### Chores

#### add patch release command to package.json ([`a672a04`](https://github.com/waterworkshq/orcy/commit/a672a049616783d2851a4851fc21f389934949e7))

1. Added a new npm script "release:patch" to execute release-it with patch version bump. This provides a convenient way to trigger patch releases through the package.json scripts section.



### Features

#### add created_at timestamp to code_evidence_completeness and return boolean from delete operations ([`6471861`](https://github.com/waterworkshq/orcy/commit/6471861427e9840bc75f411b35ca49514d67de98))

1. Add created_at column to track when completeness records are created for audit purposes. Update schema, migration, and repository to populate this field on upsertNotApplicable.

3. Refactor repository delete functions to return boolean indicating whether an item was found and deleted, improving caller feedback in codeEvidenceRepository, pipelineEvent, and pullRequest modules.


#### refactor code evidence routes into modular components ([`4b4d186`](https://github.com/waterworkshq/orcy/commit/4b4d186624b76011614fd8f90a7ab2194de2eca8))

1. Split the monolithic codeEvidence.ts route file into smaller, focused modules:
2. Created separate route files for mission, task, and repository operations
3. Extracted shared schemas and utilities into a shared module
4. Organized service layer into specialized services for different aspects of code evidence
5. Improved maintainability and separation of concerns

7. This refactoring enhances code organization and makes the codebase easier to navigate and maintain.



### Refactors

#### add self-referencing foreign key to code_evidence_links ([`d7825fb`](https://github.com/waterworkshq/orcy/commit/d7825fb70b37b3d283a257bcbb2ea8329ec72f11))

1. Add a self-referencing foreign key constraint on code_evidence_links.replacement_link_id to enable link replacement functionality. This required rebuilding the table with foreign key support and updating the schema definition.



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
