# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.16.5 — 2026-06-03

### Refactors

#### clean up repository imports and type definitions ([`75276be`](https://github.com/waterworkshq/orcy/commit/75276bea9a553b3c1437bfa3e51dc678d4552ec2))

1. This change removes unused error imports from repository files, updates type definitions to remove unused interfaces, and simplifies relation definitions. It also modernizes some code patterns by replacing ternary operators with Boolean() and updating test file mock organization. The changes reduce bundle size and improve code maintainability by eliminating dead code.



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
