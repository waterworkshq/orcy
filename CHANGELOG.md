# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.16.6 — 2026-06-03

### Performance

#### improve effort tracking metrics and database indexes ([`f7e99a3`](https://github.com/waterworkshq/orcy/commit/f7e99a37a2a9bdaa885221d1a6ec14fa89842ecb))

1. Change estimation_accuracy and planning_accuracy to real type for fractional values
2. Add new indexes for task event transitions to improve query performance
3. Implement canonical effort metrics with logged effort basis
4. Add audit export route tests with proper authentication
5. Improve board health and summary services with real metrics
6. Update effort service to record audit events for logging and corrections
7. Fix effort calculation to prefer logged effort over inferred time



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
