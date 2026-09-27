# API Route Index

> GENERATED FILE — do not edit by hand. Regenerate with `node scripts/generate-route-index.mjs`.
> API-only production assembly baseline: `packages/api/src/test/fixtures/routeBaseline/apiOnly.json`; UI and plugin routes are not included.
> Paths are presentation-normalized (`:param`); policy IDs describe installed authentication, not object-level authorization. Current `/api/v1` and deprecated `/api` twins share a row only when method, path, and policy match. `/api/shared` Remote Participant routes stay independent; manual-invite deprecated twins are paired with `/api/v1/shared/invites/*`. Generated HEAD twins and framework OPTIONS `*` CORS preflight are excluded from operation totals; explicit HEAD/OPTIONS remain. See `docs/API.md` for selected endpoint contracts.

## agents

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| GET | `/agents` | `local_actor` | current + deprecated twin |
| POST | `/agents` | `registration` | current + deprecated twin |
| DELETE | `/agents/:param` | `human` | current + deprecated twin |
| GET | `/agents/:param` | `local_actor` | current + deprecated twin |
| PATCH | `/agents/:param` | `human` | current + deprecated twin |
| POST | `/agents/:param/heartbeat` | `agent` | current + deprecated twin |
| GET | `/agents/:param/messages` | `agent` | current + deprecated twin |
| POST | `/agents/:param/messages` | `agent` | current + deprecated twin |
| PUT | `/agents/:param/messages/read-all` | `agent` | current + deprecated twin |
| DELETE | `/agents/:param/self` | `agent` | current + deprecated twin |
| GET | `/agents/:param/stats` | `local_actor` | current + deprecated twin |
| GET | `/agents/:param/suggestions` | `local_actor` | current + deprecated twin |
| DELETE | `/agents/messages/:param` | `agent` | current + deprecated twin |
| PUT | `/agents/messages/:param/read` | `agent` | current + deprecated twin |
| GET | `/agents/stats` | `local_actor` | current + deprecated twin |

## attachments

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| DELETE | `/attachments/:param` | `local_actor` | current + deprecated twin |
| GET | `/attachments/:param/download` | `local_actor` | current + deprecated twin |

## audit

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| DELETE | `/audit/schedules/:param` | `human` | current + deprecated twin |

## auth

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| POST | `/auth/change-password` | `human` | current + deprecated twin |
| POST | `/auth/login` | `anonymous` | current + deprecated twin |
| POST | `/auth/logout` | `human` | current + deprecated twin |
| GET | `/auth/me` | `human` | current + deprecated twin |
| PATCH | `/auth/me` | `human` | current + deprecated twin |
| POST | `/auth/register` | `anonymous` | current + deprecated twin |
| GET | `/auth/setup-status` | `anonymous` | current + deprecated twin |
| GET | `/auth/stream-token` | `human` | current + deprecated twin |

## automation-deliveries

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| POST | `/automation-deliveries/:param/retry` | `human` | current + deprecated twin |
| POST | `/automation-deliveries/:param/waive` | `human` | current + deprecated twin |

## automation-rules

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| DELETE | `/automation-rules/:param` | `human` | current + deprecated twin |
| GET | `/automation-rules/:param` | `local_actor` | current + deprecated twin |
| PUT | `/automation-rules/:param` | `human` | current + deprecated twin |
| POST | `/automation-rules/:param/disable` | `human` | current + deprecated twin |
| POST | `/automation-rules/:param/enable` | `human` | current + deprecated twin |
| POST | `/automation-rules/:param/run` | `human` | current + deprecated twin |
| GET | `/automation-rules/:param/runs` | `local_actor` | current + deprecated twin |
| POST | `/automation-rules/:param/simulate` | `local_actor` | current + deprecated twin |

## chat

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| POST | `/chat/discord/interaction` | `verified_ingress:discord_ed25519` | current + deprecated twin |
| POST | `/chat/slack/command` | `verified_ingress:slack_signing` | current + deprecated twin |

## chat-integrations

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| DELETE | `/chat-integrations/:param` | `human` | current + deprecated twin |
| PUT | `/chat-integrations/:param` | `human` | current + deprecated twin |
| POST | `/chat-integrations/:param/test` | `human` | current + deprecated twin |

## columns

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| DELETE | `/columns/:param` | `human` | current + deprecated twin |
| PATCH | `/columns/:param` | `human` | current + deprecated twin |

## daemon

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| POST | `/daemon/heartbeat` | `daemon` | current + deprecated twin |
| POST | `/daemon/register` | `registration` | current + deprecated twin |
| GET | `/daemon/sessions` | `daemon` | current + deprecated twin |
| PATCH | `/daemon/sessions/:param` | `daemon` | current + deprecated twin |
| POST | `/daemon/tasks/claim-next` | `daemon` | current + deprecated twin |

## daemons

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| GET | `/daemons` | `human` | current + deprecated twin |
| GET | `/daemons/:param` | `human` | current + deprecated twin |
| POST | `/daemons/:param/start` | `human` | current + deprecated twin |
| POST | `/daemons/:param/stop` | `human` | current + deprecated twin |
| GET | `/daemons/detect-clis` | `human` | current + deprecated twin |
| POST | `/daemons/register` | `human` | current + deprecated twin |

## dashboard

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| GET | `/dashboard` | `human` | current + deprecated twin |

## habitats

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| GET | `/habitats` | `local_actor` | current + deprecated twin |
| POST | `/habitats` | `human` | current + deprecated twin |
| DELETE | `/habitats/:param` | `human` | current + deprecated twin |
| GET | `/habitats/:param` | `local_actor` | current + deprecated twin |
| PATCH | `/habitats/:param` | `human` | current + deprecated twin |
| GET | `/habitats/:param/agent-messages` | `human` | current + deprecated twin |
| GET | `/habitats/:param/agent-quality` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/anomalies` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/archive-events` | `human` | current + deprecated twin |
| GET | `/habitats/:param/audit/events` | `human` | current + deprecated twin |
| GET | `/habitats/:param/audit/export` | `human` | current + deprecated twin |
| POST | `/habitats/:param/audit/schedule` | `human` | current + deprecated twin |
| GET | `/habitats/:param/audit/schedules` | `human` | current + deprecated twin |
| GET | `/habitats/:param/audit/summary` | `human` | current + deprecated twin |
| GET | `/habitats/:param/automation-inbox` | `human` | current + deprecated twin |
| GET | `/habitats/:param/automation-rules` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/automation-rules` | `human` | current + deprecated twin |
| GET | `/habitats/:param/automation-runs` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/bottlenecks` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/burndown` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/capacity` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/chat-integrations` | `human` | current + deprecated twin |
| POST | `/habitats/:param/chat-integrations` | `human` | current + deprecated twin |
| GET | `/habitats/:param/chat-integrations/:param/speaker-mappings` | `human` | current + deprecated twin |
| POST | `/habitats/:param/chat-integrations/:param/speaker-mappings` | `human` | current + deprecated twin |
| DELETE | `/habitats/:param/chat-integrations/:param/speaker-mappings/:param` | `human` | current + deprecated twin |
| POST | `/habitats/:param/columns` | `human` | current + deprecated twin |
| POST | `/habitats/:param/columns/reorder` | `human` | current + deprecated twin |
| GET | `/habitats/:param/cumulative-flow` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/effect-receipts` | `human` | current + deprecated twin |
| GET | `/habitats/:param/effect-receipts/:param` | `human` | current + deprecated twin |
| POST | `/habitats/:param/effect-receipts/:param/requeue` | `human` | current + deprecated twin |
| GET | `/habitats/:param/events` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/experience-metrics` | `human` | current + deprecated twin |
| GET | `/habitats/:param/export` | `human` | current + deprecated twin |
| GET | `/habitats/:param/extraction/agent/findings` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/extraction/agent/findings/:param` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/extraction/findings` | `human` | current + deprecated twin |
| GET | `/habitats/:param/extraction/findings/:param` | `human` | current + deprecated twin |
| POST | `/habitats/:param/extraction/findings/:param/accept` | `human` | current + deprecated twin |
| POST | `/habitats/:param/extraction/findings/:param/citations/refresh` | `human` | current + deprecated twin |
| POST | `/habitats/:param/extraction/findings/:param/promote` | `human` | current + deprecated twin |
| GET | `/habitats/:param/extraction/findings/:param/promotion-eligibility` | `human` | current + deprecated twin |
| POST | `/habitats/:param/extraction/findings/:param/reject` | `human` | current + deprecated twin |
| POST | `/habitats/:param/extraction/findings/:param/revise` | `human` | current + deprecated twin |
| POST | `/habitats/:param/extraction/findings/:param/withdraw` | `human` | current + deprecated twin |
| GET | `/habitats/:param/extraction/policies` | `human` | current + deprecated twin |
| POST | `/habitats/:param/extraction/policies` | `human` | current + deprecated twin |
| GET | `/habitats/:param/extraction/policies/:param` | `human` | current + deprecated twin |
| PATCH | `/habitats/:param/extraction/policies/:param` | `human` | current + deprecated twin |
| POST | `/habitats/:param/extraction/policies/:param/dry-run` | `human` | current + deprecated twin |
| POST | `/habitats/:param/extraction/policies/:param/ensure` | `human` | current + deprecated twin |
| POST | `/habitats/:param/extraction/policies/:param/fresh-rerun` | `human` | current + deprecated twin |
| GET | `/habitats/:param/extraction/review/queue` | `human` | current + deprecated twin |
| GET | `/habitats/:param/extraction/runs` | `human` | current + deprecated twin |
| GET | `/habitats/:param/health` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/health/history` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/import` | `human` | current + deprecated twin |
| GET | `/habitats/:param/insights` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/insights` | `local_actor` | current + deprecated twin |
| DELETE | `/habitats/:param/insights/:param` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/intake-candidates` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/integrations` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/integrations/github/oauth/device/poll` | `human` | current + deprecated twin |
| POST | `/habitats/:param/integrations/github/oauth/device/start` | `human` | current + deprecated twin |
| POST | `/habitats/:param/integrations/github/pat` | `human` | current + deprecated twin |
| POST | `/habitats/:param/integrations/jira/api-key` | `human` | current + deprecated twin |
| POST | `/habitats/:param/integrations/jira/oauth/complete` | `human` | current + deprecated twin |
| POST | `/habitats/:param/integrations/jira/oauth/start` | `human` | current + deprecated twin |
| POST | `/habitats/:param/integrations/linear/api-key` | `human` | current + deprecated twin |
| POST | `/habitats/:param/integrations/linear/oauth/complete` | `human` | current + deprecated twin |
| POST | `/habitats/:param/integrations/linear/oauth/start` | `human` | current + deprecated twin |
| GET | `/habitats/:param/metrics` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/missions` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/missions` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/notification-preferences` | `human` | current + deprecated twin |
| PUT | `/habitats/:param/notification-preferences` | `human` | current + deprecated twin |
| POST | `/habitats/:param/notifications/admin/clear` | `human` | current + deprecated twin |
| GET | `/habitats/:param/notifications/admin/delivery-monitor` | `human` | current + deprecated twin |
| POST | `/habitats/:param/notifications/admin/migrate-legacy` | `human` | current + deprecated twin |
| GET | `/habitats/:param/notifications/admin/migrate-legacy/status` | `human` | current + deprecated twin |
| GET | `/habitats/:param/notifications/admin/retention` | `human` | current + deprecated twin |
| PUT | `/habitats/:param/notifications/admin/retention` | `human` | current + deprecated twin |
| GET | `/habitats/:param/notifications/admin/subscriptions` | `human` | current + deprecated twin |
| POST | `/habitats/:param/notifications/admin/subscriptions` | `human` | current + deprecated twin |
| DELETE | `/habitats/:param/notifications/admin/subscriptions/:param` | `human` | current + deprecated twin |
| PUT | `/habitats/:param/notifications/admin/subscriptions/:param` | `human` | current + deprecated twin |
| GET | `/habitats/:param/notifications/deliveries/:param` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/notifications/deliveries/:param/ack` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/notifications/deliveries/:param/clear` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/notifications/deliveries/:param/snooze` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/notifications/history` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/notifications/inbox` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/notifications/subscriptions` | `local_actor` | current + deprecated twin |
| DELETE | `/habitats/:param/plugins/:param/quarantine` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/plugins/enrollments` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/plugins/enrollments` | `local_actor` | current + deprecated twin |
| DELETE | `/habitats/:param/plugins/enrollments/:param` | `local_actor` | current + deprecated twin |
| PATCH | `/habitats/:param/plugins/enrollments/:param` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/plugins/runs` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/plugins/runs/:param/lost` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/plugins/stale-runs` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/predictions` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/priority-report` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/pulse` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/pulse` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/pulse/digest` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/remote-access/credentials/:param` | `human` | current + deprecated twin |
| POST | `/habitats/:param/remote-access/credentials/:param/mcp-config` | `human` | current + deprecated twin |
| POST | `/habitats/:param/remote-access/credentials/:param/revoke` | `human` | current + deprecated twin |
| POST | `/habitats/:param/remote-access/credentials/:param/rotate` | `human` | current + deprecated twin |
| GET | `/habitats/:param/remote-access/grants` | `human` | current + deprecated twin |
| POST | `/habitats/:param/remote-access/grants` | `human` | current + deprecated twin |
| GET | `/habitats/:param/remote-access/grants/:param` | `human` | current + deprecated twin |
| POST | `/habitats/:param/remote-access/grants/:param/revoke` | `human` | current + deprecated twin |
| POST | `/habitats/:param/remote-access/grants/preview` | `human` | current + deprecated twin |
| GET | `/habitats/:param/remote-access/invites` | `human` | current + deprecated twin |
| POST | `/habitats/:param/remote-access/invites` | `human` | current + deprecated twin |
| POST | `/habitats/:param/remote-access/invites/:param/revoke` | `human` | current + deprecated twin |
| GET | `/habitats/:param/remote-access/management` | `human` | current + deprecated twin |
| GET | `/habitats/:param/remote-access/participants/:param` | `human` | current + deprecated twin |
| PATCH | `/habitats/:param/remote-access/participants/:param` | `human` | current + deprecated twin |
| GET | `/habitats/:param/remote-access/participants/:param/credentials` | `human` | current + deprecated twin |
| POST | `/habitats/:param/remote-access/participants/:param/credentials` | `human` | current + deprecated twin |
| GET | `/habitats/:param/remote-access/providers` | `human` | current + deprecated twin |
| POST | `/habitats/:param/remote-access/providers` | `human` | current + deprecated twin |
| DELETE | `/habitats/:param/remote-access/providers/:param` | `human` | current + deprecated twin |
| PATCH | `/habitats/:param/remote-access/providers/:param` | `human` | current + deprecated twin |
| POST | `/habitats/:param/remote-access/providers/:param/initiate` | `human` | current + deprecated twin |
| GET | `/habitats/:param/remote-access/readiness` | `human` | current + deprecated twin |
| GET | `/habitats/:param/remote-access/remote-pods` | `human` | current + deprecated twin |
| GET | `/habitats/:param/remote-access/remote-pods/:param` | `human` | current + deprecated twin |
| PATCH | `/habitats/:param/remote-access/remote-pods/:param` | `human` | current + deprecated twin |
| GET | `/habitats/:param/remote-access/remote-pods/:param/participants` | `human` | current + deprecated twin |
| GET | `/habitats/:param/remote-access/webhook-endpoints` | `human` | current + deprecated twin |
| POST | `/habitats/:param/remote-access/webhook-endpoints` | `human` | current + deprecated twin |
| DELETE | `/habitats/:param/remote-access/webhook-endpoints/:param` | `human` | current + deprecated twin |
| GET | `/habitats/:param/remote-access/webhook-endpoints/:param` | `human` | current + deprecated twin |
| PATCH | `/habitats/:param/remote-access/webhook-endpoints/:param` | `human` | current + deprecated twin |
| POST | `/habitats/:param/remote-access/webhook-endpoints/:param/approve` | `human` | current + deprecated twin |
| POST | `/habitats/:param/remote-access/webhook-endpoints/:param/disable` | `human` | current + deprecated twin |
| POST | `/habitats/:param/remote-access/webhook-endpoints/:param/enable` | `human` | current + deprecated twin |
| POST | `/habitats/:param/remote-access/webhook-endpoints/:param/reject` | `human` | current + deprecated twin |
| GET | `/habitats/:param/repository` | `local_actor` | current + deprecated twin |
| PUT | `/habitats/:param/repository` | `human` | current + deprecated twin |
| POST | `/habitats/:param/repository/infer-from-integration` | `human` | current + deprecated twin |
| POST | `/habitats/:param/repository/infer-from-worktree` | `human` | current + deprecated twin |
| GET | `/habitats/:param/review-rules` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/review-rules` | `human` | current + deprecated twin |
| GET | `/habitats/:param/roadmap` | `local_actor` | current + deprecated twin |
| PATCH | `/habitats/:param/roadmap-focus` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/rules` | `local_actor` | current + deprecated twin |
| PUT | `/habitats/:param/rules` | `human` | current + deprecated twin |
| POST | `/habitats/:param/rules/evaluate` | `human` | current + deprecated twin |
| GET | `/habitats/:param/saved-filters` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/saved-filters` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/scheduled-tasks` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/scheduled-tasks` | `human` | current + deprecated twin |
| GET | `/habitats/:param/skill` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/skill/contribute` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/skill/refresh` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/skill/signals` | `human` | current + deprecated twin |
| DELETE | `/habitats/:param/skill/signals/:param` | `human` | current + deprecated twin |
| GET | `/habitats/:param/sprints` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/sprints` | `human` | current + deprecated twin |
| GET | `/habitats/:param/sprints/active` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/stats` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/summary` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/tasks` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/tasks/batch` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/templates` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/templates` | `human` | current + deprecated twin |
| GET | `/habitats/:param/triage/orphans/:param/investigation` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/triage/orphans/:param/map` | `local_actor` | current + deprecated twin |
| PUT | `/habitats/:param/webhook-secrets` | `human` | current + deprecated twin |
| POST | `/habitats/:param/wiki/authoring-context` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/wiki/bootstrap` | `local_actor` | current + deprecated twin |
| DELETE | `/habitats/:param/wiki/cadence` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/wiki/cadence` | `local_actor` | current + deprecated twin |
| PUT | `/habitats/:param/wiki/cadence` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/wiki/coverage/no-update-needed` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/wiki/pages` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/wiki/pages` | `local_actor` | current + deprecated twin |
| DELETE | `/habitats/:param/wiki/pages/:param` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/wiki/pages/:param` | `local_actor` | current + deprecated twin |
| PATCH | `/habitats/:param/wiki/pages/:param` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/wiki/pages/:param/authoring-context` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/wiki/pages/:param/links` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/wiki/pages/:param/links` | `local_actor` | current + deprecated twin |
| DELETE | `/habitats/:param/wiki/pages/:param/links/:param` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/wiki/pages/:param/versions` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/wiki/pages/:param/versions` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/wiki/pages/:param/versions/:param` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/wiki/pages/:param/versions/:param/restore` | `local_actor` | current + deprecated twin |
| POST | `/habitats/:param/wiki/refresh` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/wiki/search` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/wiki/signal-surface` | `local_actor` | current + deprecated twin |
| GET | `/habitats/:param/workflow-metrics` | `human` | current + deprecated twin |
| POST | `/habitats/agent` | `agent` | current + deprecated twin |
| POST | `/habitats/import` | `human` | current + deprecated twin |

## intake-candidates

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| GET | `/intake-candidates/:param` | `local_actor` | current + deprecated twin |
| POST | `/intake-candidates/:param/ignore` | `human` | current + deprecated twin |
| POST | `/intake-candidates/:param/needs-clarification` | `human` | current + deprecated twin |
| POST | `/intake-candidates/:param/promote` | `human` | current + deprecated twin |

## integrations

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| DELETE | `/integrations/:param` | `human` | current + deprecated twin |
| PATCH | `/integrations/:param` | `human` | current + deprecated twin |
| POST | `/integrations/:param/sync` | `human` | current + deprecated twin |
| GET | `/integrations/:param/sync-runs` | `human` | current + deprecated twin |

## missions

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| DELETE | `/missions/:param` | `local_actor` | current + deprecated twin |
| GET | `/missions/:param` | `local_actor` | current + deprecated twin |
| PATCH | `/missions/:param` | `local_actor` | current + deprecated twin |
| POST | `/missions/:param/apply-template/:param` | `human` | current + deprecated twin |
| POST | `/missions/:param/archive` | `local_actor` | current + deprecated twin |
| GET | `/missions/:param/audit/bundle` | `local_actor` | current + deprecated twin |
| GET | `/missions/:param/blocked-status` | `local_actor` | current + deprecated twin |
| GET | `/missions/:param/code-evidence` | `local_actor` | current + deprecated twin |
| POST | `/missions/:param/code-evidence` | `local_actor` | current + deprecated twin |
| POST | `/missions/:param/code-evidence/:param/correct` | `local_actor` | current + deprecated twin |
| POST | `/missions/:param/code-evidence/gaps` | `local_actor` | current + deprecated twin |
| POST | `/missions/:param/code-evidence/gaps/:param/resolve` | `local_actor` | current + deprecated twin |
| DELETE | `/missions/:param/code-evidence/not-applicable` | `local_actor` | current + deprecated twin |
| POST | `/missions/:param/code-evidence/not-applicable` | `local_actor` | current + deprecated twin |
| GET | `/missions/:param/comments` | `local_actor` | current + deprecated twin |
| POST | `/missions/:param/comments` | `local_actor` | current + deprecated twin |
| DELETE | `/missions/:param/comments/:param` | `local_actor` | current + deprecated twin |
| PATCH | `/missions/:param/comments/:param` | `local_actor` | current + deprecated twin |
| POST | `/missions/:param/decompose` | `human` | current + deprecated twin |
| GET | `/missions/:param/dependencies` | `local_actor` | current + deprecated twin |
| POST | `/missions/:param/dependencies` | `local_actor` | current + deprecated twin |
| DELETE | `/missions/:param/dependencies/:param` | `local_actor` | current + deprecated twin |
| GET | `/missions/:param/dependency-graph` | `local_actor` | current + deprecated twin |
| GET | `/missions/:param/details` | `local_actor` | current + deprecated twin |
| GET | `/missions/:param/effort-report` | `local_actor` | current + deprecated twin |
| GET | `/missions/:param/external-links` | `local_actor` | current + deprecated twin |
| POST | `/missions/:param/move` | `local_actor` | current + deprecated twin |
| GET | `/missions/:param/progress` | `local_actor` | current + deprecated twin |
| GET | `/missions/:param/pulse` | `local_actor` | current + deprecated twin |
| POST | `/missions/:param/pulse` | `local_actor` | current + deprecated twin |
| GET | `/missions/:param/pulse/digest` | `local_actor` | current + deprecated twin |
| POST | `/missions/:param/task-publications` | `local_actor` | current + deprecated twin |
| GET | `/missions/:param/tasks` | `local_actor` | current + deprecated twin |
| POST | `/missions/:param/unarchive` | `local_actor` | current + deprecated twin |
| GET | `/missions/:param/workflow` | `human` | current + deprecated twin |
| POST | `/missions/:param/workflow` | `human` | current + deprecated twin |

## organizations

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| GET | `/organizations` | `human` | current + deprecated twin |
| POST | `/organizations` | `human` | current + deprecated twin |
| GET | `/organizations/:param` | `human` | current + deprecated twin |
| GET | `/organizations/:param/teams` | `human` | current + deprecated twin |
| POST | `/organizations/:param/teams` | `human` | current + deprecated twin |

## platform

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| GET | `/` | `anonymous` | standalone |
| GET | `/health` | `anonymous` | standalone |
| GET | `/sse/habitats/:param/stream` | `realtime` | standalone |
| POST | `/sse/presence/heartbeat` | `human` | standalone |
| POST | `/sse/presence/join` | `human` | standalone |
| POST | `/sse/presence/leave` | `human` | standalone |
| GET | `/sse/presence/viewers/:param` | `human` | standalone |

## plugins

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| GET | `/plugins` | `local_actor` | current + deprecated twin |

## pulse

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| DELETE | `/pulse/:param` | `local_actor` | current + deprecated twin |
| POST | `/pulse/:param/react` | `local_actor` | current + deprecated twin |
| GET | `/pulse/:param/replies` | `local_actor` | current + deprecated twin |
| GET | `/pulse/inbox` | `local_actor` | current + deprecated twin |

## quality

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| GET | `/quality/templates` | `local_actor` | current + deprecated twin |
| POST | `/quality/templates` | `human` | current + deprecated twin |

## remote-participant

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| GET | `/api/shared/credentials/current` | `remote_participant` | Remote Participant API |
| GET | `/api/shared/grants` | `remote_participant` | Remote Participant API |
| GET | `/api/shared/habitats/:param` | `remote_participant` | Remote Participant API |
| GET | `/api/shared/habitats/:param/missions` | `remote_participant` | Remote Participant API |
| GET | `/api/shared/me` | `remote_participant` | Remote Participant API |
| GET | `/api/shared/missions/:param` | `remote_participant` | Remote Participant API |
| GET | `/api/shared/missions/:param/comments` | `remote_participant` | Remote Participant API |
| POST | `/api/shared/missions/:param/comments` | `remote_participant` | Remote Participant API |
| GET | `/api/shared/missions/:param/pulse` | `remote_participant` | Remote Participant API |
| POST | `/api/shared/missions/:param/pulse` | `remote_participant` | Remote Participant API |
| GET | `/api/shared/missions/:param/workflow` | `remote_participant` | Remote Participant API |
| GET | `/api/shared/notifications` | `remote_participant` | Remote Participant API |
| POST | `/api/shared/notifications/deliveries/:param/ack` | `remote_participant` | Remote Participant API |
| POST | `/api/shared/notifications/deliveries/:param/snooze` | `remote_participant` | Remote Participant API |
| GET | `/api/shared/notifications/history` | `remote_participant` | Remote Participant API |
| GET | `/api/shared/tasks/:param` | `remote_participant` | Remote Participant API |
| POST | `/api/shared/tasks/:param/claim` | `remote_participant` | Remote Participant API |
| GET | `/api/shared/tasks/:param/comments` | `remote_participant` | Remote Participant API |
| POST | `/api/shared/tasks/:param/comments` | `remote_participant` | Remote Participant API |
| POST | `/api/shared/tasks/:param/evidence-links` | `remote_participant` | Remote Participant API |
| POST | `/api/shared/tasks/:param/heartbeat` | `remote_participant` | Remote Participant API |
| POST | `/api/shared/tasks/:param/release` | `remote_participant` | Remote Participant API |
| POST | `/api/shared/tasks/:param/submit` | `remote_participant` | Remote Participant API |
| GET | `/api/shared/tasks/:param/workflow-context` | `remote_participant` | Remote Participant API |
| POST | `/api/shared/triage/findings/:param/route` | `remote_participant` | Remote Participant API |

## review-rules

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| DELETE | `/review-rules/:param` | `human` | current + deprecated twin |
| PATCH | `/review-rules/:param` | `human` | current + deprecated twin |

## saved-filters

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| DELETE | `/saved-filters/:param` | `local_actor` | current + deprecated twin |
| PUT | `/saved-filters/:param` | `local_actor` | current + deprecated twin |

## scheduled-occurrences

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| POST | `/scheduled-occurrences/:param/retry` | `human` | current + deprecated twin |

## scheduled-tasks

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| DELETE | `/scheduled-tasks/:param` | `human` | current + deprecated twin |
| GET | `/scheduled-tasks/:param` | `local_actor` | current + deprecated twin |
| PATCH | `/scheduled-tasks/:param` | `human` | current + deprecated twin |
| POST | `/scheduled-tasks/:param/disable` | `human` | current + deprecated twin |
| POST | `/scheduled-tasks/:param/enable` | `human` | current + deprecated twin |
| POST | `/scheduled-tasks/:param/run` | `human` | current + deprecated twin |

## shared/invites

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| POST | `/shared/invites/accept` | `manual_invite` | current + deprecated twin |
| POST | `/shared/invites/preview` | `manual_invite` | current + deprecated twin |

## sprints

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| DELETE | `/sprints/:param` | `human` | current + deprecated twin |
| GET | `/sprints/:param` | `local_actor` | current + deprecated twin |
| PATCH | `/sprints/:param` | `human` | current + deprecated twin |
| GET | `/sprints/:param/burndown` | `local_actor` | current + deprecated twin |
| POST | `/sprints/:param/cancel` | `human` | current + deprecated twin |
| GET | `/sprints/:param/carry-over` | `local_actor` | current + deprecated twin |
| POST | `/sprints/:param/complete` | `human` | current + deprecated twin |
| GET | `/sprints/:param/metrics` | `local_actor` | current + deprecated twin |
| POST | `/sprints/:param/missions` | `human` | current + deprecated twin |
| DELETE | `/sprints/:param/missions/:param` | `human` | current + deprecated twin |
| POST | `/sprints/:param/start` | `human` | current + deprecated twin |

## task-creation-attempts

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| GET | `/task-creation-attempts/:param` | `local_actor` | current + deprecated twin |

## tasks

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| DELETE | `/tasks/:param` | `local_actor` | current + deprecated twin |
| GET | `/tasks/:param` | `local_actor` | current + deprecated twin |
| PATCH | `/tasks/:param` | `agent` | current + deprecated twin |
| GET | `/tasks/:param/approval-status` | `local_actor` | current + deprecated twin |
| POST | `/tasks/:param/approve` | `local_actor` | current + deprecated twin |
| POST | `/tasks/:param/assignment-attempts` | `local_actor` | current + deprecated twin |
| GET | `/tasks/:param/attachments` | `local_actor` | current + deprecated twin |
| POST | `/tasks/:param/attachments` | `local_actor` | current + deprecated twin |
| GET | `/tasks/:param/audit/bundle` | `local_actor` | current + deprecated twin |
| GET | `/tasks/:param/blocked-status` | `local_actor` | current + deprecated twin |
| POST | `/tasks/:param/claim` | `agent` | current + deprecated twin |
| GET | `/tasks/:param/clone-preparation` | `local_actor` | current + deprecated twin |
| POST | `/tasks/:param/clone-publications` | `local_actor` | current + deprecated twin |
| GET | `/tasks/:param/code-evidence` | `local_actor` | current + deprecated twin |
| POST | `/tasks/:param/code-evidence` | `local_actor` | current + deprecated twin |
| POST | `/tasks/:param/code-evidence/:param/correct` | `local_actor` | current + deprecated twin |
| POST | `/tasks/:param/code-evidence/gaps` | `local_actor` | current + deprecated twin |
| POST | `/tasks/:param/code-evidence/gaps/:param/resolve` | `local_actor` | current + deprecated twin |
| DELETE | `/tasks/:param/code-evidence/not-applicable` | `local_actor` | current + deprecated twin |
| POST | `/tasks/:param/code-evidence/not-applicable` | `local_actor` | current + deprecated twin |
| GET | `/tasks/:param/comments` | `local_actor` | current + deprecated twin |
| POST | `/tasks/:param/comments` | `agent` | current + deprecated twin |
| DELETE | `/tasks/:param/comments/:param` | `agent` | current + deprecated twin |
| PATCH | `/tasks/:param/comments/:param` | `agent` | current + deprecated twin |
| POST | `/tasks/:param/complete` | `agent` | current + deprecated twin |
| POST | `/tasks/:param/decompose` | `human` | current + deprecated twin |
| POST | `/tasks/:param/delegate` | `agent` | current + deprecated twin |
| GET | `/tasks/:param/dependencies` | `local_actor` | current + deprecated twin |
| POST | `/tasks/:param/dependencies` | `local_actor` | current + deprecated twin |
| DELETE | `/tasks/:param/dependencies/:param` | `local_actor` | current + deprecated twin |
| GET | `/tasks/:param/details` | `local_actor` | current + deprecated twin |
| GET | `/tasks/:param/effort-entries` | `local_actor` | current + deprecated twin |
| POST | `/tasks/:param/effort-entries` | `local_actor` | current + deprecated twin |
| POST | `/tasks/:param/effort-entries/:param/correct` | `local_actor` | current + deprecated twin |
| GET | `/tasks/:param/effort-report` | `local_actor` | current + deprecated twin |
| PUT | `/tasks/:param/estimate` | `local_actor` | current + deprecated twin |
| GET | `/tasks/:param/events` | `local_actor` | current + deprecated twin |
| POST | `/tasks/:param/fail` | `agent` | current + deprecated twin |
| GET | `/tasks/:param/failure-context` | `local_actor` | current + deprecated twin |
| GET | `/tasks/:param/pipeline-events` | `human` | current + deprecated twin |
| GET | `/tasks/:param/pull-requests` | `human` | current + deprecated twin |
| GET | `/tasks/:param/quality-checklist` | `local_actor` | current + deprecated twin |
| PUT | `/tasks/:param/quality-checklist/:param/items/:param` | `local_actor` | current + deprecated twin |
| POST | `/tasks/:param/quality-checklist/validate` | `local_actor` | current + deprecated twin |
| POST | `/tasks/:param/reject` | `local_actor` | current + deprecated twin |
| POST | `/tasks/:param/release` | `agent` | current + deprecated twin |
| POST | `/tasks/:param/retry` | `agent` | current + deprecated twin |
| GET | `/tasks/:param/review-requirement` | `human` | current + deprecated twin |
| POST | `/tasks/:param/review-requirement/resolve` | `human` | current + deprecated twin |
| GET | `/tasks/:param/reviewers` | `local_actor` | current + deprecated twin |
| POST | `/tasks/:param/reviewers` | `human` | current + deprecated twin |
| DELETE | `/tasks/:param/reviewers/:param` | `human` | current + deprecated twin |
| POST | `/tasks/:param/start` | `agent` | current + deprecated twin |
| POST | `/tasks/:param/submit` | `agent` | current + deprecated twin |
| GET | `/tasks/:param/subtasks` | `agent` | current + deprecated twin |
| POST | `/tasks/:param/subtasks` | `agent` | current + deprecated twin |
| DELETE | `/tasks/:param/subtasks/:param` | `agent` | current + deprecated twin |
| PATCH | `/tasks/:param/subtasks/:param` | `agent` | current + deprecated twin |
| GET | `/tasks/:param/time-report` | `local_actor` | current + deprecated twin |
| POST | `/tasks/:param/unblock` | `agent` | current + deprecated twin |
| DELETE | `/tasks/:param/watch` | `human` | current + deprecated twin |
| POST | `/tasks/:param/watch` | `human` | current + deprecated twin |
| GET | `/tasks/:param/watchers` | `human` | current + deprecated twin |
| GET | `/tasks/:param/workflow-context` | `local_actor` | current + deprecated twin |
| GET | `/tasks/:param/worktree` | `agent` | current + deprecated twin |

## teams

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| DELETE | `/teams/:param` | `human` | current + deprecated twin |
| GET | `/teams/:param` | `human` | current + deprecated twin |
| GET | `/teams/:param/members` | `human` | current + deprecated twin |
| POST | `/teams/:param/members` | `human` | current + deprecated twin |
| DELETE | `/teams/:param/members/:param` | `human` | current + deprecated twin |
| PATCH | `/teams/:param/members/:param` | `human` | current + deprecated twin |

## templates

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| DELETE | `/templates/:param` | `human` | current + deprecated twin |
| PATCH | `/templates/:param` | `human` | current + deprecated twin |
| POST | `/templates/:param/usage` | `local_actor` | current + deprecated twin |

## triage

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| GET | `/triage/clusters/top` | `local_actor` | current + deprecated twin |
| GET | `/triage/findings` | `local_actor` | current + deprecated twin |
| GET | `/triage/findings/:param` | `local_actor` | current + deprecated twin |
| PATCH | `/triage/findings/:param` | `local_actor` | current + deprecated twin |
| POST | `/triage/findings/:param/activate` | `local_actor` | current + deprecated twin |
| POST | `/triage/findings/:param/resolve` | `local_actor` | current + deprecated twin |
| POST | `/triage/findings/:param/route` | `local_actor` | current + deprecated twin |
| POST | `/triage/findings/:param/wontfix` | `local_actor` | current + deprecated twin |
| POST | `/triage/release-trigger` | `local_actor` | current + deprecated twin |
| GET | `/triage/resolutions` | `local_actor` | current + deprecated twin |

## users

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| PUT | `/users/me/email` | `human` | current + deprecated twin |
| GET | `/users/me/notification-preferences` | `human` | current + deprecated twin |
| PUT | `/users/me/notification-preferences` | `human` | current + deprecated twin |
| GET | `/users/me/teams` | `human` | current + deprecated twin |

## webhooks

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| GET | `/webhooks` | `human` | current + deprecated twin |
| POST | `/webhooks` | `human` | current + deprecated twin |
| DELETE | `/webhooks/:param` | `human` | current + deprecated twin |
| PUT | `/webhooks/:param` | `human` | current + deprecated twin |
| GET | `/webhooks/:param/deliveries` | `human` | current + deprecated twin |
| POST | `/webhooks/:param/rotate-secret` | `human` | current + deprecated twin |
| POST | `/webhooks/:param/test` | `human` | current + deprecated twin |
| POST | `/webhooks/github` | `verified_ingress:github_code_review_hmac` | current + deprecated twin |
| POST | `/webhooks/github-ci` | `verified_ingress:github_ci_hmac` | current + deprecated twin |
| POST | `/webhooks/github/issues` | `verified_ingress:github_issues_hmac` | current + deprecated twin |
| POST | `/webhooks/gitlab` | `verified_ingress:gitlab_code_review_token` | current + deprecated twin |
| POST | `/webhooks/gitlab-ci` | `verified_ingress:gitlab_ci_token` | current + deprecated twin |

## workflows

| Method | Path | Auth policy | Surfaces |
|---|---|---|---|
| DELETE | `/workflows/:param` | `human` | current + deprecated twin |
| PATCH | `/workflows/:param` | `human` | current + deprecated twin |
| GET | `/workflows/:param/failure-contexts` | `human` | current + deprecated twin |
| POST | `/workflows/:param/gates/:param/unblock` | `human` | current + deprecated twin |

---

Total operations (generated HEAD and framework preflight excluded; twins deduplicated): 472 across 36 families.
