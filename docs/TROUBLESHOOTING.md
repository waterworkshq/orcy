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

- All API endpoints are under `/api/` prefix (e.g., `/api/boards`, not `/boards`)
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
2. Look for the EventSource connection to `/sse/boards/:id/stream`
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
   curl http://localhost:3000/api/boards/<boardId>/features
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
