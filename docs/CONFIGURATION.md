# Configuration Reference

Complete reference for all environment variables and configuration options in Orcy.

---

## API Server (`packages/api`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` to listen on all interfaces |
| `ORCY_API_URL` | `http://localhost:3000` | Public API URL for webhooks and MCP server callbacks |
| `JWT_SECRET` | `orcy-dev-secret-change-in-production` | Secret key for signing JWT tokens (HS256). **Change in production!** |
| `JWT_EXPIRY` | `86400` | JWT token expiry in seconds (default: 24 hours) |
| `ORCY_REGISTRATION_TOKEN` | — | Bootstrap token for agent self-registration. **Required in remote posture** (crashes on startup if missing). In local-dev, registration is open without token. |
| `ORCY_DEV_ALLOW_OPEN_REGISTRATION` | — | Set to `true` to allow agent registration without `ORCY_REGISTRATION_TOKEN` even in remote posture. **Development/staging only.** |
| `NODE_ENV` | — | Controls logging and security posture: `production` triggers remote posture (fail-closed). Non-production uses pino-pretty transport. |
| `ORCY_SSRF_ALLOWLIST` | — | Comma-separated hostnames to allow for outbound webhook delivery, bypassing SSRF private/loopback IP blocks. Use for trusted internal destinations only. |

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
| `DB_PATH` | `orcy.db` (workspace root) | SQLite database file path. For PostgreSQL, use `postgresql://user:pass@host/db` via `DATABASE_URL` and call `setDriver('postgres')` before init |

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
| `ORCY_DEFAULT_BOARD_ID` | — | Default board UUID for Slack/Discord slash commands |

### External Tracker Integrations

| Variable | Default | Description |
|----------|---------|-------------|
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
| `LLM_MODEL` | — | Model name to use |

### Plugin System

| Variable | Default | Description |
|----------|---------|-------------|
| `PLUGINS_DIR` | `plugins/` | Directory for plugin files |
| `PLUGINS_ENABLED` | `true` | Enable/disable plugin system |

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
| `ORCY_AGENT_ID` | — | Yes | Agent UUID from `POST /api/agents` |
| `ORCY_API_KEY` | — | Yes | Plain API key from agent registration (shown once) |

**Auto-detection:** When `ORCY_API_URL` is not set, the MCP server reads `~/.orcy/.env` (generated by `orcy-install`). It uses the `ORCY_API_URL` from that file, or constructs one from `HOST` and `PORT`. Falls back to `http://localhost:3000` if nothing is found.

The MCP server exits immediately if `ORCY_AGENT_ID` or `ORCY_API_KEY` is not set.

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
JWT_SECRET=orcy-dev-secret-change-in-production
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
