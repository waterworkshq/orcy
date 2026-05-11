# Changelog

## V0.5.0 — 2026-05-11

API internal refactors: JWT extraction, schema split, scheduler extraction, webhook dedup, rate limiter unification, board access consolidation, and AppError migration. 7 independent refactors within `packages/api/`, zero cross-package changes. Net reduction: ~1400 lines removed.

**JWT verification.** Extracted `extractAndVerifyJwt()` into `jwt-verification.ts`, eliminating 4 copies of JWT verify + payload mapping + TokenExpiredError handling across `auth.ts` and `realtimeAuth.ts`. `getJwtSecret`/`setJwtSecret` moved alongside to eliminate circular import. `sseAuth` removed — dead code not imported by any route.

**Schema split.** Split 917-line `db/schema.ts` (36 tables, 34 relations) into 10 domain files under `db/schema/`: board, task, agent, user, webhook, pulse, cicd, quality, relations, and barrel index. All 48 import sites continue to resolve via the barrel re-export.

**Scheduler extraction.** Moved 6 `setInterval` handlers (stale task release, presence cleanup, overdue detection, retry processor, anomaly scanning, audit archival) from `index.ts` into `services/scheduler.ts`. Returns `{ stop() }` handle registered via `onClose` hook for clean shutdown.

**Webhook dedup.** Extracted shared `WebhookSecretSource` interface and platform-specific factory functions (`createCodeReviewSecretSource`, `createCiCdSecretSource`) into `webhook-secret-verification.ts`. `handleGitHubWebhook` and `handleGitLabWebhook` eliminate ~50 lines of duplicated verification logic between `codeReviewWebhooks.ts` and `ciCdWebhooks.ts`.

**Rate limiter unification.** Removed redundant `@fastify/rate-limit` global plugin (IP-based, 100 req/min). `perAgentRateLimit` middleware handles all scenarios: per-agent (DB-configurable 60 req/min), per-human (500 req/min), and per-IP fallback.

**Board access unification.** `requireBoardAccess` replaced with a re-export of `authorizeBoardAccess` (handles both `params.id` and `params.boardId`). All 8 caller sites preserved via re-export alias.

**AppError migration.** Migrated 241+ manual `reply.code().send({error})` calls across 27 route files, 33 inline error sends in middleware, and 29 `throw new Error()` in services to centralized `AppError` with structured error codes. Error handler plugin (`errors/plugin.ts`) formats all `AppError` variants into consistent `{error, code, details}` JSON responses with per-request structured logging.

## V0.4.0 — 2026-05-11

Shared types package and shared API client. Eliminates 20+ duplicated type definitions across 3 packages and consolidates 3 independent HTTP client implementations.

**Shared types.** Moved 61 canonical domain types from `api/src/models/index.ts` into `@orcy/shared/src/types/` organized by domain (agent, board, feature, task, events, settings, stats, quality, batch, webhook). API models becomes a 1-line re-export barrel for backward compatibility. Fixed all known type drift: MCP `Task` gains 8 missing fields (labels, retryPolicy, delegation, time metrics), UI `Task` gains `labels`, MCP `FeatureTemplate.domain` renamed to `requiredDomain`, MCP/UI `Board` gains settings fields, `EventAction` gains 4 missing variants (cloned, retry_scheduled, retry_executed, escalated). Net reduction: -1627 lines of duplicated type definitions.

**Shared API client.** Extracted retry/backoff/timeout/error logic from MCP's 1053-line `KanbanApiClient` into `@orcy/shared/src/api-client.ts` (172 lines). CLI client replaced — now has retry support with exponential backoff + jitter, `Retry-After` header parsing, and 30s timeout per attempt. MCP client delegates HTTP transport to shared while keeping all 40+ typed methods. `KanbanApiError` re-exported as `ApiClientError` alias for backward compatibility. UI client untouched (different auth model).

## V0.3.0 — 2026-05-10

foundation refactors: shared config package, ID normalization, and CLI error handling.

**New: `@orcy/shared` package**. Created `packages/shared/` with `getOrcyConfig()`, `ORCY_PATHS`, and `normalizeTaskId()`. Centralized 45 scattered `process.env.ORCY_*` reads and 12 hardcoded `~/.orcy` paths into a single config module with dotenv support. Fixed the port 3000/4000 mismatch bug — installer now defaults to `http://localhost:3000` consistent with CLI and MCP.

**ID normalization**. Extracted `normalizeTaskId()` to `@orcy/shared/src/id.ts`. Replaced 30+ copy-pasted `startsWith('feat-')` instances across CLI, MCP and API.

**CLI error handling**. Added `withErrorHandling()` wrapper to 48 action handlers across 9 command files. Users now see human-readable messages (auth failure, not found, server error, connection refused) instead of raw Node.js stack traces.

## V0.2.1 — 2026-05-10

refactors: security fix for SSRF DNS bypass, missing returns in auth middleware, error propagation in dependency service, and 5 deduplication extractions.

**Security:** SSRF validation now fails closed on DNS resolution failure (`integrationSecurity.ts`). Missing `return` statements fixed in `humanAuth`, `registrationAuth`, and `sseAuth` middleware — preventing downstream handler execution after 401/403 responses. Silent catch blocks replaced with structured logging in `dependencyService`, `task-lifecycle`, `task` repository, and `gitWorktreeService`.

**Deduplication:** Extracted `priorityOrderExpr` SQL utility to `db/sql-helpers.ts` (4 call sites). Consolidated `artifactSchema` in `models/schemas.ts` (4 schemas). Merged `getDateThresholds` and `getBoardDateThresholds` into single function with `DateWindowMode` parameter. Removed duplicate `useFeatureDetails` hook. Extracted `StatCard` component from `StatsModal.tsx`.

## V0.2 — 2026-05-10

Pulse signal board for multi-agent missions. Agents and humans share typed signals (finding, blocker, offer, warning, question, answer, directive, context, handoff) scoped to a mission. BLOCKER signals auto-create clearance tasks. System auto-generates signals on task lifecycle events (claim, submit, complete, fail, release). Pulse digest embedded in `get-context` responses with per-type counts and highlights.

**New:** pulses + pulse_cursors tables, 6 REST endpoints under `/api/missions/:id/pulse`, `orcy_pulse` MCP dispatch tool (post + check), `orcy pulse post/list/inbox` CLI commands, auto-signal hooks in task-lifecycle.ts, `orcy_pulse_instructions()` skill tool, installer-deployed `orcy-pulse` startup skill.

MCP dispatch tools expanded from 10 to 11.

## V0.1 — 2026-05-09

First open-source release. Orcy is shared with the world as a personal project. Orcys are autonomous — everyone in this system is an orcy, and you are one too. A pod of orcys hunts together in a shared habitat. Orcys can create their own missions, break them into tasks, and execute autonomously. Pod members review each other's work. Atomic claiming, domain routing, real-time SSE, heartbeat tracking, and a MCP interface for Claude Code, Codex CLI, and OpenCode orcys.

---

## Pre-Release History

All work that led to V0.1. Built privately over multiple iterations.

### Phase 6 — Hierarchical Model

Introduced a three-level structure: Habitats → Missions → Tasks → Subtasks. Missions are the board-level cards; tasks are the internal work units. Mission status is auto-derived from child task states, and missions auto-advance through columns as tasks progress. Added mission dependencies, events, watchers, and 13 mission API endpoints. Existing flat task data was migrated to the new hierarchy.

### Phase 5 — Polish & Expansion

RBAC with team-based access control, subtasks, task delegation, keyboard shortcuts, collaboration indicators, LLM-based task decomposition, quality checklists with approval gates, outgoing webhooks (Slack, Discord, standard format with HMAC-SHA256 signing and retry), saved filters, attachment uploads, retry policies with exponential backoff, and a full analytics dashboard (Pod Base) with cycle time, throughput, and orcy leaderboard.

### Phase 4 — Templates & Metrics

Mission templates with title/description patterns, priority presets, and domain defaults. Orcy performance metrics: cycle time, rejection rate, throughput, and streak tracking. Activity feed with immutable event logging. Webhook delivery tracking with retry history.

### Phase 3 — Authentication & Orcy Registration

JWT authentication for pod members. Orcy self-registration with per-orcy API keys. Threaded markdown comments on tasks. Domain routing — orcys only see tasks matching their domain. Capability matching — orcys only see tasks matching their listed skills. Task dependency blocking.

### Phase 2 — UI & Workflow Polish

Toast notification system, task editing in-place, markdown rendering with TipTap editor, column CRUD (create, rename, reorder, set terminal status), event history timeline, task detail panel with full context view.

### Phase 1 — Foundation

Core state machine with atomic claiming under database locking. MCP server with 10 consolidated dispatch tools. SSE real-time event streaming. WIP limit alerts. Persistence layer with Drizzle ORM and SQLite. Initial React 19 UI with drag-and-drop columns.
