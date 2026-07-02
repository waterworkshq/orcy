# Configuration Reference

Complete reference for all environment variables and configuration options in Orcy.

---

## API Server (`packages/api`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` to listen on all interfaces |
| `ORCY_API_URL` | `http://localhost:3000` | Public API URL for webhooks and MCP server callbacks |
| `JWT_SECRET` | `dev-secret-change-in-production` | Secret key for signing JWT tokens (HS256). **Change in production!** Also used as the AES-256-GCM key for encrypting stored secrets. |
| `ORCY_REGISTRATION_TOKEN` | — | Bootstrap token for agent self-registration. **Required in remote posture** (crashes on startup if missing). In local-dev, registration is open without token. |
| `ORCY_DEV_ALLOW_OPEN_REGISTRATION` | — | Set to `true` to allow agent registration without `ORCY_REGISTRATION_TOKEN` even in remote posture. **Development/staging only.** |
| `NODE_ENV` | — | Controls logging and security posture: `production` triggers remote posture (fail-closed). Non-production uses pino-pretty transport. |
| `ORCY_SSRF_ALLOWLIST` | — | Comma-separated hostnames to allow for outbound webhook delivery, bypassing SSRF private/loopback IP blocks. Use for trusted internal destinations only. |
| `ORCY_BASE_URL` | — | Legacy fallback for `ORCY_PUBLIC_URL`. Optional. |
| `ORCY_PUBLIC_URL` | — | Public base URL for shared-habitat reachability checks and webhook dispatch. Falls back to `ORCY_BASE_URL`. Read by `packages/api`. Optional for local-only deployments. |
| `ORCY_TRANSITION_RECALC_DEBOUNCE` | unset | When set to `"true"`, debounces habitat-health recalculation after task transitions. Optional. |
| `ORCY_UI_PATH` | `~/.orcy/ui` | Directory containing built UI static assets, served at `/app/` when present. Optional. |

### Security Posture

The server classifies its posture at startup based on `NODE_ENV` and `HOST`:

| Posture | Condition |
|---------|-----------|
| **local-dev** | `NODE_ENV !== 'production'` **and** `HOST` is localhost/127.0.0.1/::1 |
| **remote** | `NODE_ENV=production` **or** `HOST` is non-localhost |

Remote posture requires `JWT_SECRET` (strong, not a known weak value) and `ORCY_REGISTRATION_TOKEN`. The server exits immediately if these checks fail. See [SECURITY.md](./SECURITY.md) for full details.

### Database

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PATH` | `orcy.db` (workspace root) | SQLite database file path. PostgreSQL selection is code-level via `setDriver('postgres')`, not env-driven |

### File Storage & Uploads

| Variable | Default | Description |
|----------|---------|-------------|
| `UPLOAD_DIR` | `uploads/` | Directory for file attachments |
| `MAX_UPLOAD_SIZE_MB` | `50` | Maximum upload size in megabytes |
| `ARCHIVES_DIR` | `archives/` | Directory for audit log archives |

### Email (SMTP)

| Variable | Default | Description |
|----------|---------|-------------|
| `SMTP_HOST` | — | SMTP server host |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_USER` | — | SMTP username |
| `SMTP_PASS` | — | SMTP password |
| `SMTP_FROM` | `noreply@orcy.local` | From address for outgoing emails |

### Chat Integrations

| Variable | Default | Description |
|----------|---------|-------------|
| `SLACK_SIGNING_SECRET` | — | Slack signing secret for verifying slash command requests |
| `DISCORD_PUBLIC_KEY` | — | Discord public key for verifying interaction requests |
| `ORCY_DEFAULT_HABITAT_ID` | — | Default habitat UUID for Slack/Discord slash commands |

### External Tracker Integrations

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCY_GITHUB_OAUTH_CLIENT_ID` | `Ov23liwIyGIgEaZetUN7` | OAuth client ID for GitHub integration. Optional. |
| `ORCY_LINEAR_OAUTH_CLIENT_ID` | Orcy public Linear app client ID | Optional override for Linear OAuth PKCE. No Linear client secret is required for the public PKCE flow. |
| `ORCY_JIRA_OAUTH_CLIENT_ID` | — | Atlassian OAuth app client ID for advanced Jira OAuth self-hosting. Not needed for recommended Jira API-token setup. |
| `ORCY_JIRA_OAUTH_CLIENT_SECRET` | — | Atlassian OAuth app client secret for advanced Jira OAuth self-hosting. Never commit this value. |

Recommended setup paths:

| Provider | Recommended setup | User-provided values |
|----------|-------------------|----------------------|
| Jira Cloud | UI API-token form | Atlassian email, Atlassian API token, Jira site URL, project key |
| Linear | CLI OAuth PKCE | No secret; run `orcy integrations connect <habitat-id> linear` |

For Jira API tokens, users can create a token at <https://id.atlassian.com/manage-profile/security/api-tokens>. For Linear OAuth apps, register `http://127.0.0.1:17530/callback` as the callback URL if using a custom app.

### LLM Integration

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_API_KEY` | — | API key for LLM provider |
| `LLM_PROVIDER` | `openai` | LLM provider (`openai` or `anthropic`) |
| `LLM_MODEL` | `gpt-4o` | Model name to use |

### Plugin System

| Variable | Default | Description |
|----------|---------|-------------|
| `PLUGINS_DIR` | `plugins/` | Directory for plugin files |
| `PLUGINS_ENABLED` | — | Comma-separated plugin names to load. When unset, all discovered plugins load. When set, only listed plugins load. |
| `ORCY_DETECTOR_ALLOWLIST` | — | Comma-separated plugin IDs allowed for detector enrollment. Unset = fail-closed (all detector enrollments return 403). `*` = open. |
| `ORCY_PLUGIN_QUARANTINE_THRESHOLD` | `10` | Error count threshold for auto-quarantine. A plugin reaching this many errors is flagged `quarantined` and skipped on dispatch until re-enabled. |
| `ORCY_DETECTOR_MAX_CONCURRENT` | `8` | Max concurrent detector invocations per habitat. Excess triggers queue. |
| `ORCY_DETECTOR_QUEUE_MAX` | `256` | Max queued detector triggers per habitat before overflow drop. Oldest trigger is dropped + `detector.queue_overflow` audit event emitted. |

### Release Activation

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCY_RELEASE_AUTO_PROMOTE` | `true` (enabled) | Global kill switch for the release auto-promotion loop (ADR-0031). Set to `false`, `0`, `off`, or `no` to disable. When disabled, releases are still detected, recorded, and emit a retrospective pulse + `release.shipped` automation event — only the matched-finding promotion loop is skipped. Per-habitat override via `releaseSettings.autoPromote` (`PATCH /habitats/:id`); both must be `true` for promotion to run. |

### Realtime (SSE / WebSocket)

| Variable | Default | Description |
|----------|---------|-------------|
| Stream token max age | 30 seconds | Short-lived JWT for browser EventSource/WebSocket query-string auth (hardcoded in `authenticateRealtime` middleware). Obtain via `GET /api/auth/stream-token` with human JWT auth. |

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` (dev), `warn` (production) | Pino log level (`debug`, `info`, `warn`, `error`). Default depends on `NODE_ENV` |
| `CORS_ORIGIN` | — | CORS allowed origin (e.g., `https://orcy.example.com`) |

### Derived Values

| Setting | Value | Source |
|---------|-------|--------|
| Rate limit window | 1 minute | Hardcoded in `src/index.ts` |
| Rate limit max | 100 requests | Hardcoded in `src/index.ts` |
| Stale task threshold | 30 minutes | Hardcoded in `src/index.ts` (`releaseStaleTasks(30)`) |
| Stale check interval | 60 seconds | Hardcoded in `src/index.ts` (`setInterval(..., 60_000)`) |
| Database file | `orcy.db` | Workspace root, via `DB_PATH` env var |
| Database driver | `better-sqlite3` | Use `setDriver('postgres')` for PostgreSQL |
| bcrypt rounds | 10 | Hardcoded in `src/routes/auth.ts` |
| JWT algorithm | HS256 | Hardcoded in `src/middleware/auth.ts` |
| First admin user | Setup form in production | Development may seed `admin / admin123` outside production |

---

## MCP Server (`packages/mcp`)

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `ORCY_API_URL` | Auto-detected from `~/.orcy/.env`, falls back to `http://localhost:3000` | No | Kanban API base URL |
| `ORCY_AGENT_ID` | — | Conditional | Required for agent-scoped tool calls. Missing value surfaces as a per-tool error, not a startup crash. |
| `ORCY_API_KEY` | — | Conditional | Required for agent-scoped tool calls. Missing value surfaces as a per-tool error, not a startup crash. |

**Auto-detection:** When `ORCY_API_URL` is not set, the MCP server reads `~/.orcy/.env` (generated by `orcy-install`). It uses the `ORCY_API_URL` from that file, or constructs one from `HOST` and `PORT`. Falls back to `http://localhost:3000` if nothing is found.

Missing `ORCY_AGENT_ID` or `ORCY_API_KEY` surfaces as a per-tool error rather than crashing at startup.

### Registering Agents

Agents can be registered via the UI or API:

**Via UI:** Open the Agents panel and click "Add" to register a new agent. Credentials are shown once.

**Via API:**

```bash
curl -X POST http://localhost:3000/api/agents \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "type": "opencode", "domain": "backend"}'
```

The API returns `{ "agent": {...}, "apiKey": "id-randomhex" }`. Save the `apiKey` — it won't be shown again.

---

## Daemon

Daemon process configuration for standalone agent execution.

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCY_DAEMON_DIR` | `~/.orcy/daemon` | Data directory for daemon credentials and state. Optional. |
| `ORCY_DAEMON_NAME` | `os.hostname()` | Display name for this daemon. Optional. |
| `ORCY_HABITAT_IDS` | — | Comma-separated habitat UUIDs the daemon serves. Required for standalone daemon. |
| `ORCY_HEARTBEAT_INTERVAL` | `30` | Heartbeat interval in seconds. Optional. |
| `ORCY_MAX_CONCURRENT` | `4` | Maximum concurrent agent sessions. Optional. |
| `ORCY_POLL_INTERVAL` | `30` | Poll interval in seconds. Optional. |
| `ORCY_SESSION_TIMEOUT` | `600` | Session inactivity timeout in seconds. Optional. |

---

## Remote Participant

Remote-participant (remote MCP) configuration. Presence of `ORCY_REMOTE_KEY` switches MCP into remote mode using `X-Orcy-Remote-Key` auth.

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCY_REMOTE_API_URL` | — | API URL override for remote-participant mode. Falls back to `ORCY_API_URL`. Optional. |
| `ORCY_REMOTE_KEY` | — | Per-remote-participant credential. When set, switches MCP into remote mode using `X-Orcy-Remote-Key` auth. Optional (presence triggers remote mode). |
| `ORCY_REMOTE_PARTICIPANT_ID` | — | Participant identifier for remote dispatch payloads. Optional. |
| `ORCY_REMOTE_POD_ID` | — | Pod identifier for remote dispatch payloads. Optional. |

---

## UI (`packages/ui`)

The UI has no environment variables. It connects to the API via:

- **Development:** Vite dev server proxies `/api` and `/sse` to `http://localhost:3000`
- **Production:** Configure reverse proxy (Nginx/Caddy) to proxy these paths

### Vite Configuration

The proxy is configured in the Vite setup (not shown in source). Ensure:

- `/api/*` → proxied to API server
- `/sse/*` → proxied to API server with SSE-compatible settings (no buffering)

---

## Configuration by Environment

### Local Development

```env
# .env (optional — defaults work out of the box for local-dev posture)
PORT=3000
HOST=127.0.0.1
JWT_SECRET=dev-secret-change-in-production
# ORCY_REGISTRATION_TOKEN=dev-bootstrap-token  # Optional: restrict agent registration
```

Local-dev posture is automatic when `HOST=127.0.0.1` and `NODE_ENV !== 'production'`. Agent registration is open, integration signature verification is relaxed, and weak JWT secrets are tolerated.

### Production

```env
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
ORCY_API_URL=https://orcy.example.com
JWT_SECRET=your-very-strong-random-secret-min-32-chars
ORCY_REGISTRATION_TOKEN=your-registration-token
# ORCY_SSRF_ALLOWLIST=internal-service.local,metrics.internal  # Optional: trusted outbound destinations
```

---

## Rate Limiting Configuration

Rate limiting is configured in `packages/api/src/index.ts`:

```typescript
await fastify.register(rateLimit, {
  max: 100,              // Maximum requests per window
  timeWindow: '1 minute', // Time window
  keyGenerator: (request) => {
    const agentKey = request.headers['x-agent-api-key'] as string | undefined;
    if (agentKey) return `agent:${agentKey}`;  // Per API key
    return `ip:${request.ip}`;                  // Per IP
  },
});
```

To change rate limits, modify these values and restart the API.

---

## CORS Configuration

CORS is configured in `packages/api/src/index.ts`:

```typescript
await fastify.register(cors, { origin: false }); // Disabled by default
```

For cross-origin access, change to:

```typescript
await fastify.register(cors, {
  origin: ['https://orcy.example.com'],
  credentials: true,
});
```

---

## Logging Configuration

The API uses pino for logging. The configuration is environment-aware (`packages/api/src/index.ts`):

```typescript
const isDev = process.env.NODE_ENV !== 'production';
const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? (isDev ? 'info' : 'warn'),
    ...(isDev ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  },
});
```

- **Development** (`NODE_ENV` not set or not `production`): pino-pretty transport with colored output, default level `info`
- **Production** (`NODE_ENV=production`): Standard JSON log output (no pretty-printing), default level `warn`

Set `LOG_LEVEL` environment variable to override (e.g., `LOG_LEVEL=debug` for more verbose output).

---

## See Also

- [DEPLOYMENT.md](./DEPLOYMENT.md) — Production deployment guide
- [SECURITY.md](./SECURITY.md) — Security configuration
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — Debugging configuration issues
