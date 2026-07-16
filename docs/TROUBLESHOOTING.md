# Troubleshooting Guide

Common issues, error messages, and debugging procedures for Orcy.

---

## Table of Contents

- [API Issues](#api-issues)
- [Database Issues](#database-issues)
- [SSE / Real-Time Issues](#sse--real-time-issues)
- [MCP Server Issues](#mcp-server-issues)
- [UI Issues](#ui-issues)
- [Agent Issues](#agent-issues)
- [Pulse / Mission Signals](#pulse--mission-signals)
- [Security & Startup](#security--startup)
- [Remote Pods & Shared Habitat](#remote-pods--shared-habitat)
- [Notifications](#notifications)
- [Daemon Engine](#daemon-engine)
- [Workflow Orchestration](#workflow-orchestration)
- [Error Code Reference](#error-code-reference)
- [FAQ](#faq)

---

## API Issues

### API won't start — "Port 3000 already in use"

**Symptom:** `Error: listen EADDRINUSE: address already in use 127.0.0.1:3000`

**Fix:**

```bash
# Find and kill the process using port 3000
# Windows:
netstat -ano | findstr :3000
taskkill /PID <pid> /F

# macOS/Linux:
lsof -i :3000
kill -9 <pid>

# Or use a different port:
PORT=3001 pnpm dev:api
```

### API won't start — "Cannot find module"

**Symptom:** `Error: Cannot find module '...'` when running `pnpm dev:api`

**Fix:**

```bash
pnpm install
```

### API won't start — Database initialization error

**Symptom:** `Error: ... sql.js ...` or database-related errors

**Fix:**

1. Delete the database file: `rm orcy.db` (data will be lost)
2. Restart the API — it will create a fresh database
3. Re-seed: `pnpm db:seed`

### Request returns 404

**Symptom:** `{"error":"Not found","code":"NOT_FOUND"}`

**Fix:**

- All API endpoints are under `/api/` prefix (e.g., `/api/habitats`, not `/habitats`)
- Health check is at `/health` (no prefix)
- SSE is under `/sse/` prefix

### Request returns 429 (Rate Limited)

**Symptom:** `{"error":"Too many requests","code":"RATE_LIMITED"}`

**Fix:**

- Default limit is 100 requests per minute per IP/API key
- Wait 60 seconds for the rate limit window to reset
- Rate limit headers in response: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`

### Task claim returns 409

**Symptom:** `{"error":"already_claimed"}` or `{"error":"Task already claimed by another agent"}`

**Fix:**

- Another agent claimed the task between your `list` and `claim` calls
- List tasks again to find a new available task
- This is expected behavior under concurrent access — implement retry logic

---

## Database Issues

### "database is locked" error

**Symptom:** `SQLITE_BUSY: database is locked`

**Cause:** SQLite has limited concurrent write support.

**Fix:**

- This should be rare — the API serializes writes
- If it persists, check for long-running transactions
- For production, migrate to PostgreSQL (see [DATABASE.md](./DATABASE.md))

### Database file growing large

**Symptom:** `orcy.db` is very large

**Fix:**

- The `task_events` table accumulates audit log entries
- To clear old events: `DELETE FROM task_events WHERE timestamp < datetime('now', '-30 days')`
- Consider periodic archiving in production

### Database startup issues

**Symptom:** Errors on API startup related to database

**Fix:**

1. Check `packages/api/drizzle/` for schema files
2. Restart the API — database is created automatically
3. For hard resets: `rm orcy.db` then restart (data will be lost, fresh DB created)

---

## SSE / Real-Time Issues

### SSE events not appearing in UI

**Symptom:** Board doesn't update in real-time

**Debugging steps:**

1. Open browser DevTools → Network tab
2. Look for the EventSource connection to `/sse/habitats/:id/stream`
3. If the connection is pending with no data, check:
   - Is the API running? (`GET /health`)
   - Is the board ID correct?
   - Is a proxy stripping SSE headers? (see [DEPLOYMENT.md](./DEPLOYMENT.md) for proxy config)

### SSE connection drops repeatedly

**Symptom:** Board flickers or shows stale data

**Fix:**

- The UI auto-reconnects with exponential backoff (1s → 30s max)
- Check network stability
- If behind a proxy, ensure:
  - `proxy_buffering off` is set (Nginx)
  - Read timeout is high enough (`proxy_read_timeout 86400s`)
  - No middleware is buffering responses

### SSE events appear out of order

**Symptom:** Task appears in wrong column briefly

**Explanation:** SSE events are delivered in order per connection but the UI processes them as they arrive. The `task.updated` event supersedes intermediate events — the board converges to the correct state within one event cycle.

---

## MCP Server Issues

### MCP server exits immediately

**Symptom:** Process exits with code 1

**Cause:** Missing required environment variables

**Fix:**

```bash
# Verify all required env vars are set
echo $ORCY_API_URL   # e.g., http://localhost:3000
echo $ORCY_AGENT_ID   # UUID from POST /api/agents
echo $ORCY_API_KEY    # Plain API key from agent registration
```

All three must be set. If `ORCY_API_KEY` or `ORCY_AGENT_ID` is empty, the server exits.

### MCP tool returns "Invalid API key"

**Symptom:** `{"error":"Invalid API key","status":401}`

**Fix:**

- API keys are shown only once during agent creation (`POST /api/agents`)
- If you lost the key, delete the agent and create a new one
- Verify `ORCY_API_KEY` matches the plain-text key (not the hash)

### MCP tool returns "Agent not found"

**Symptom:** `{"error":"Agent not found","status":404}`

**Fix:**

- Verify `ORCY_AGENT_ID` matches the agent's UUID
- The agent may have been deleted — recreate it

### MCP tool returns "Domain mismatch"

**Symptom:** `{"error":"Domain mismatch","status":403}` when claiming a task

**Fix:**

- Tasks with `requiredDomain` set can only be claimed by agents with a matching domain
- Check the agent's domain: `GET /api/agents/:id`
- Check the task's domain: `GET /api/tasks/:id`
- Either update the agent's domain or reassign the task's domain

### MCP connection works but tools timeout

**Symptom:** Tools hang without returning

**Fix:**

1. Check if the API is responsive: `curl http://localhost:3000/health`
2. Check if the API URL is correct and reachable from the MCP server's environment
3. If using Docker networking, ensure the MCP server can reach the API host

---

## UI Issues

### Blank page after building

**Symptom:** UI shows blank white page

**Fix:**

1. Check browser console for errors
2. Ensure the API is running at the expected URL
3. If deploying behind a proxy, verify the `/api` proxy is configured
4. Check that `base` in Vite config matches your deployment path

### "Failed to fetch" errors in UI

**Symptom:** Board shows error state, network tab shows failed requests

**Fix:**

1. Verify the API is running: `curl http://localhost:3000/health`
2. Check Vite dev server proxy configuration
3. In production, verify Nginx/Caddy is proxying `/api/*` to the API

### Drag and drop not working

**Symptom:** Can't drag task cards between columns

**Fix:**

- Ensure `@dnd-kit/core` is installed: `pnpm install`
- Check browser console for React errors
- Verify the task status allows the move (check state machine transitions)

---

## Agent Issues

### Agent marked offline unexpectedly

**Symptom:** Agent status shows `offline` even though it's running

**Cause:** Agent hasn't sent a heartbeat in 30+ minutes

**Fix:**

- Agents must call `board_agent({ action: 'heartbeat' })` every 5 minutes while working
- The stale detection runs every 60 seconds and releases tasks idle > 30 minutes
- If the agent was genuinely offline, its claimed tasks are auto-released

### Agent can't claim any tasks

**Symptom:** `board_feature({ action: 'list' })` returns empty, or all claims fail

**Debugging steps:**

1. Verify the agent's domain matches available tasks:

   ```bash
   curl http://localhost:3000/api/agents/<id>
   curl http://localhost:3000/api/habitats/<habitatId>/missions
   ```

2. Tasks with `requiredDomain` set only appear for matching agents
3. Tasks with unmet `dependsOn` are filtered out
4. An agent can only hold one task at a time

### Task auto-released while agent was working

**Symptom:** Agent loses its task assignment unexpectedly

**Cause:** The stale detection timer expired (> 30 min without heartbeat)

**Fix:**

- Send heartbeats every 5 minutes: `board_agent({ action: 'heartbeat' })`
- Include `taskId` in heartbeat to confirm active work
- The stale timeout (30 min) is hardcoded in `packages/api/src/index.ts` (`releaseStaleTasks(30)`) — there is no environment variable to change it

---

## Pulse / Mission Signals

### Pulse signals not appearing in get-context

**Symptom:** `mission_get_context()` returns a response without a `pulse` field.

**Check:**
1. The migration must have run — verify `pulses` and `pulse_cursors` tables exist: `sqlite3 ~/.orcy/orcy.db ".tables" | grep pulse`
2. If you upgraded from an older version, run the pending migration via drizzle-kit: `pnpm --filter @orcy/api drizzle-kit migrate`
3. No signals posted yet? That's expected — the `pulse` field is `undefined` when there are zero signals, not an empty object

### Blocker auto-task not created

**Symptom:** Posted a BLOCKER signal but no `"Clear Blocker: ..."` task appeared.

**Check:**
1. Archived missions do not auto-create clearance tasks — check if the mission is archived via `orcy_habitat_mission({action: "list", isArchived: true})`
2. The block is wrapped in a try/catch — check the API server logs for errors during task creation: `grep "blocker" ~/.orcy/logs/*.log`
3. If the task service was unavailable (e.g., transient DB error), the BLOCKER signal was still created — you can manually create the clearance task

### `orcy pulse` command not found

**Symptom:** `orcy pulse post ...` returns "unknown command".

**Check:**
1. Update the CLI: `npm install -g @orcy/cli@latest` or re-run the installer
2. The pulse CLI commands were added in a recent version — older CLI builds don't have them

---

## Security & Startup

### API exits with code 1 on startup in production

**Problem:** API process exits with code 1 immediately on startup when deployed to a server or run with `NODE_ENV=production`.

**Cause:** `assertSecurityConfigOrExit()` in `packages/api/src/config/security.ts` calls `process.exit(1)` if the security validation finds errors. In "remote" posture (any non-localhost host or `NODE_ENV=production`), a weak or missing `JWT_SECRET` or a missing `ORCY_REGISTRATION_TOKEN` is fatal.

**Fix:**

- Set a strong `JWT_SECRET` and an `ORCY_REGISTRATION_TOKEN` before starting the API
- For non-localhost dev, set `ORCY_DEV_ALLOW_OPEN_REGISTRATION=true` to bypass the registration token requirement

---

## Remote Pods & Shared Habitat

### Remote pod requests fail with 401 MISSING_REMOTE_KEY / INVALID_REMOTE_KEY

**Problem:** Remote pod REST requests fail with 401 `MISSING_REMOTE_KEY` or `INVALID_REMOTE_KEY`.

**Cause:** The `remoteParticipantAuth` middleware requires an `X-Orcy-Remote-Key` header with the plaintext `orcy_remote_`-prefixed credential on every request. A wrong/empty header or the hashed form fails verification.

**Fix:**

- Pass the participant's full plaintext credential in the `X-Orcy-Remote-Key` header
- If the key was lost, mint a new remote credential — the stored value is hashed and cannot be recovered

### Authenticated remote participant gets 403 with no reason (GRANT_SCOPE_DENIED)

**Problem:** An authenticated remote participant gets 403 "Remote action not permitted" with a short code like `GRANT_SCOPE_DENIED` and cannot tell why from the response.

**Cause:** The middleware deliberately returns a generic error message and logs the detailed grant reason server-side to prevent probing attacks.

**Fix:**

- Check the API server logs for the "remote action denied" entry, which includes participantId, podId, action, and internalReason
- Adjust the participant's grants or standing accordingly

### Remote pod requests fail with 403 REMOTE_PARTICIPANT_INACTIVE / REMOTE_POD_INACTIVE

**Problem:** Remote pod requests fail with 403 `REMOTE_PARTICIPANT_INACTIVE` or `REMOTE_POD_INACTIVE` despite a valid credential key.

**Cause:** After credential verification, the middleware requires both `participant.status === "active"` and `pod.status === "active"`. A suspended/disabled participant or pod is rejected before scope checks run.

**Fix:**

- Re-activate the participant and pod via the admin routes
- If activation was never completed after invite acceptance, complete the activation step in the pod bridge onboarding flow

### Remote pod requests fail with 403 HABITAT_MISMATCH

**Problem:** Remote pod requests fail with 403 `HABITAT_MISMATCH`.

**Cause:** The middleware cross-checks that `participant.habitatId`, `pod.habitatId`, and `credential.habitatId` all match. A credential issued for habitat A used against a participant in habitat B is rejected.

**Fix:**

- Re-issue the remote credential against the correct habitat
- Credentials are habitat-scoped and cannot be reused across habitats

---

## Notifications

### Subscribing/posting a notification throws INVALID_NOTIFICATION_EVENT_TYPE

**Problem:** Subscribing to a notification event or posting one throws `INVALID_NOTIFICATION_EVENT_TYPE`.

**Cause:** The V2 notification system only accepts 8 canonical event types: `task.blocked`, `task.review_requested`, `task.assigned`, `mission.risk_marked`, `automation.rule_matched`, `automation.action_failed`, `digest.ready`, and `pulse.signal_posted`. Legacy names like `taskAssigned` are rejected.

**Fix:**

- Use one of the 8 canonical event types
- Legacy preference names are migrated automatically (`taskAssigned` → `task.assigned`, `taskReviewAssigned` → `task.review_requested`)

### Webhook delivery fails with "No webhook URL configured"

**Problem:** A notification delivery to the "webhook" channel fails with "No webhook URL configured".

**Cause:** The notification delivery service has no stored webhook URL for a habitat and reads ad-hoc from `delivery.channels[].webhookUrl` or `event.payload.webhookUrl`. If neither is present, the delivery fails.

**Fix:**

- Until habitat-level webhook subscription is wired, supply the webhook URL in the event payload (`payload.webhookUrl`)
- For reliable delivery, prefer Slack/Discord/in-app channels

---

## Daemon Engine

### Starting an in-process daemon fails after API restart

**Problem:** Starting an in-process daemon that was registered in a previous API session throws "In-process daemon credentials are only available immediately after UI registration".

**Cause:** In-process daemon agent API keys are held only in memory (`inMemoryAgentCredentials` Map) and are lost on API restart. The `start()` function rejects agents whose apiKey resolves to empty string.

**Fix:**

- Register a fresh UI daemon after every API restart (credentials are returned once and held in memory only)
- Or use the standalone CLI daemon, which persists credentials to disk

---

## Workflow Orchestration

### Workflow gate not firing?

**Problem:** A task completed or was approved, but the downstream workflow gate's `satisfied` flag stays `false`.

**Check:**

1. **Event subscription channel.** The `workflowService` subscribes to `onTransition` (fires for all actions), NOT `onTaskEvent` (fires for only 4 lifecycle-completing actions). If you've added a new transition action, verify it goes through `emitTransition()` which calls `notifyTransition()`.
2. **Task is in an active workflow.** The service does a single indexed lookup: `SELECT 1 FROM task_workflow_gates WHERE upstream_task_id = ? AND workflow_id IN (SELECT id FROM workflows WHERE status = 'active')`. Check that the workflow's `status` is `active`, not `detached`.
3. **Action → gate type mapping.** The service maps `completed → on_complete`, `approved → on_approve`, `failed/rejected/released → on_fail`. Other actions (`started`, `submitted`, `claimed`, `created`) do NOT fire gates. Verify the action you expect is in the mapping.
4. **Conditional predicate.** If the gate has a `condition` column, the match config AND the condition must both be true. Check the API server logs for `workflow_evaluation_error` audit events — predicate evaluation failures are caught and logged, not thrown.

### Downstream task not claimable after redemption?

**Problem:** A recovery task was approved/completed (redemption fired), but the downstream task still can't be claimed.

**Check:**

1. **Recovery-spawned gates excluded.** The claim-time check `areAllWorkflowGatesSatisfied` excludes gates with `recoveryDepth > 0` from the blocking check. Verify the query includes the depth filter: `WHERE satisfied = 0 AND recovery_depth = 0`.
2. **Redemption actually fired.** Check `failure_contexts.resolved_at` for the recovery task's context — it should be non-null with `resolution_kind = 'redeemed'`. If null, the redemption hook didn't find the context (check `recovery_task_id` linkage).
3. **Gate type.** Redemption only satisfies `on_complete` and `on_approve` gates on the original failed task. `on_signal` and `on_manual` gates are NOT redeemed — they still need their own trigger.

### Recovery task not spawning?

**Problem:** A task failed within a workflow, but no recovery task was created.

**Check:**

1. **Failure handler configured.** Check `workflows.failure_handler` on the workflow row. If null and the gate's `matchConfig.failureHandlerOverride` is also absent, no recovery spawns. The handler must have a `recoveryTaskTemplate`.
2. **Per-task override.** Check `gate.matchConfig.failureHandlerOverride`. If the key is present and set to `null`, recovery is explicitly disabled for that task (even if the workflow has a default handler).
3. **Depth cap.** Check `gate.recovery_depth`. If it's >= 2, the spawn is skipped (two recovery attempts maximum). The `workflow.recovery_unrecoverable` notification should have fired.
4. **Idempotency marker.** Check `gate.recovery_task_id`. If non-null, a recovery was already spawned for this gate. Repeated failure events do not spawn additional recoveries.
5. **Failure action.** Only `failed`, `rejected`, and `released` (heartbeat-lost) trigger `on_fail` gates. A task that's `pending` or `claimed` doesn't trigger failure recovery.

### Experience signals not appearing in skill?

**Problem:** Agents are posting `signalType: "experience"` pulses, but they don't show up in the habitat skill document.

**Check:**

1. **Signal type consolidation.** Verify `signalType: "experience"` is in the consolidated `SIGNAL_TYPES` const at `packages/shared/src/types/signal.ts`. All consumers (API schema, MCP tool, UI config) import from shared.
2. **Skill ingestion branch.** Check `habitatSkillService.initSkillHooks()` — the `onPulseCreated` subscriber should branch on `signalType === "experience"` and call `ingestExperienceSignal` before the existing `ingestFromPulse` path.
3. **Category extraction.** The category lives in `pulse.metadata.experience`. If the metadata is missing or the category isn't one of the 7 valid values, the signal is defensively skipped.
4. **Category mapping.** `stuck`/`confused`/`backtrack → pitfall`, `surprised`/`ambiguous → domain_knowledge`, `smooth → pattern`, `sidetracked → pitfall` (stopgap). If the skill document doesn't have a "Pitfalls" or "Patterns" section, signals won't appear visibly.

### Template workflow not instantiating?

**Problem:** A template with a `workflowTemplate` is applied, but no workflow or gates are created.

**Check:**

1. **Column exists.** Verify `workflow_template` column exists on `mission_templates` (migration `0033_add_workflow_template_column.sql`). Check via `sqlite3 orcy.db ".schema mission_templates"`.
2. **`applyTemplate` extension.** The function should call `instantiateWorkflow()` when `template.workflowTemplate` is non-null. Check the API server logs for `TemplateValidationError` — duplicate keys, missing required variables, bad gate references, and bad join-spec references all surface as validation errors (400 response, not 500).
3. **Variable validation.** Required variables (those with `required: true` in `workflowTemplate.variables`) must be provided in the `variables` argument to `applyTemplate`. Missing required variables throw `TemplateValidationError`.
4. **Task key references.** Gate `upstreamTaskKey` and `downstreamTaskKey` must match a `key` on a `TaskTemplateEntry` in `tasksTemplate`. If keys are absent, they auto-generate as `task_1`, `task_2`, etc. Check that references match.

---

## Triage (v0.23)

### Triage missions not being created

1. **No automation rules configured.** The `signal_pattern_clustered` scan creates missions directly (even with zero rules), but only if clusters cross threshold. Check: `GET /api/triage/clusters/top?habitatId=X` — if empty, no clusters are detected.
2. **Threshold not met.** Default is 3+ signals sharing the same normalized subject within 7 days. Fewer signals = no cluster. Adjust by posting more signals or waiting for accumulation.
3. **Active-triage suppression.** If a triage mission already exists for the clusterKey (status `open` in `triage_cluster_missions`), new clusters for the same key are suppressed. Resolve or close the existing triage mission first.
4. **All signals are triage-generated.** Signals with `metadata.triageGenerated: true` are excluded from clustering (loop prevention). Verify the pulses don't carry this flag.

### Triage investigation task not getting claimed

The investigation task is a normal task that requires a **configured daemon agent** (v0.14). Without a daemon + agent (Claude/Codex/etc.) registered in the habitat, the task sits unclaimed. Check daemon status via `GET /api/daemon/status`.

### Finding triage record not created

Finding triage records are created when a finding **enters triage** (either via critical-single event trigger or via cluster detection). Posting a finding via `orcy_pulse` alone does NOT create a `finding_triage` record — the finding must trigger triage first. Check: `GET /api/triage/findings?habitatId=X` to see existing records.

### Agent quality triggers not firing

1. **Sample size too small.** Default minimum is 5 tasks. Agents with fewer completed tasks are skipped.
2. **Score above threshold.** Default threshold is 40/100. Healthy agents (score ≥ 40) are not flagged.
3. **No rules configured.** The scan evaluates quality but only fires actions if automation rules with trigger `agent_quality_degraded` exist.

---

## Error Code Reference

All API errors follow this format:

```json
{
  "error": "Human-readable message",
  "code": "MACHINE_READABLE_CODE",
  "details": {}
}
```

> **Note:** Many route handlers perform manual Zod validation and return `{ error, details }` without the `code` field. The `code` field is only guaranteed when errors pass through the global Fastify error handler plugin.

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 400 | `VALIDATION_ERROR` | Request body or query params failed Zod validation |
| 401 | `UNAUTHORIZED` | Missing or invalid API key / JWT token |
| 403 | `FORBIDDEN` | Authenticated but not authorized (domain mismatch) |
| 404 | `NOT_FOUND` | Resource not found |
| 409 | `CONFLICT` | State conflict (task already claimed, version mismatch) |
| 429 | `RATE_LIMITED` | Rate limit exceeded |
| 500 | `INTERNAL_ERROR` | Unexpected server error |
| 503 | — | Service unavailable |

### Validation Error Details

When `code` is `VALIDATION_ERROR`, the `details` field contains Zod validation errors:

```json
{
  "error": "Validation failed",
  "code": "VALIDATION_ERROR",
  "details": {
    "fieldErrors": {
      "title": ["String must contain at least 1 character(s)"]
    }
  }
}
```

---

## FAQ

### How do I reset everything?

```bash
# Stop all services
docker compose down

# Delete database
rm orcy.db

# Delete Docker volumes (PostgreSQL + Redis data)
docker compose down -v

# Reinstall dependencies
rm -rf node_modules packages/*/node_modules
pnpm install

# Start fresh
pnpm dev:api    # in one terminal
pnpm db:seed    # in another
pnpm dev:ui     # in another
```

### How do I create a new agent?

```bash
curl -X POST http://localhost:3000/api/agents \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "type": "claude-code", "domain": "backend", "capabilities": ["typescript"]}'
```

Save the returned `apiKey` — it's shown only once.

### How do I change an agent's domain?

```bash
curl -X PATCH http://localhost:3000/api/agents/<agent-id> \
  -H "Content-Type: application/json" \
  -d '{"domain": "frontend"}'
```

### How do I view the audit log for a task?

```bash
curl http://localhost:3000/api/tasks/<task-id>/events?limit=50
```

### Can multiple agents work on the same board?

Yes. Each agent sees only tasks matching its domain. Use `requiredDomain` on tasks to route work to specific agent types.

### Can a human also move tasks?

Yes. The UI allows drag-and-drop between columns. Human actions use `optionalAuth` — the reviewer ID comes from the JWT token or is passed in the request body.

### How does the system handle failures?

The API handles task failures natively. If an agent cannot complete a task, it can mark the task as failed using `POST /tasks/:id/fail`. Failed tasks return to the pending pool for re-claiming.

### How do I run E2E tests?

```bash
# Ensure API and UI are built
pnpm build:api
pnpm build:ui

# Run Playwright tests
node run-e2e.js
# or
cd packages/ui && npx playwright test
```
