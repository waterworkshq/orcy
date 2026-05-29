# Security Documentation

This document covers the security architecture, authentication mechanisms, authorization model, and known limitations of Orcy.

---

## Security Posture

Orcy uses a **dual posture** model (ADR-001):

| Posture | Condition | Behavior |
|---------|-----------|----------|
| **local-dev** | `HOST=127.0.0.1` or `localhost` and `NODE_ENV !== 'production'` | Relaxed defaults: open agent registration, unsigned chat commands allowed, weak JWT secret tolerated |
| **remote** | `NODE_ENV=production` or `HOST` bound to non-localhost | Fail-closed: missing `JWT_SECRET` or `ORCY_REGISTRATION_TOKEN` crashes on startup, inbound integrations require valid signatures, outbound SSRF blocked |

Posture is classified by `classifyPosture()` in `packages/api/src/config/security.ts`. The `assertSecurityConfigOrExit()` function is called at startup and terminates the process if remote posture has missing or weak secrets.

### Explicit Dev Overrides

| Variable | Purpose |
|----------|---------|
| `ORCY_DEV_ALLOW_OPEN_REGISTRATION=true` | Allow agent registration without token even in remote posture |
| `ORCY_SSRF_ALLOWLIST` | Comma-separated hostnames allowed for outbound webhooks despite SSRF protections |

---

## Threat Model

| Threat | Mitigation | Status |
|--------|-----------|--------|
| Unauthorized API access | Default-deny auth on all non-public routes | Implemented |
| Double-claiming of tasks | Atomic claim with version check | Implemented |
| Agent impersonation | API key authentication + identity derived from `request.agent.id` only | Implemented |
| Brute-force attacks | Rate limiting (100 req/min) | Implemented |
| Cross-origin requests | CORS disabled by default | Implemented |
| Data tampering in transit | TLS (via reverse proxy) | Deployer responsibility |
| SQL injection | Parameterized queries (Drizzle ORM) | Implemented |
| Audit trail manipulation | Append-only event log | Implemented |
| Stale agent takeover | 30-min heartbeat timeout | Implemented |
| Remote deployment weak secrets | Startup validation crashes on weak/missing JWT_SECRET and REGISTRATION_TOKEN | Implemented |
| Agent message spoofing | Sender/mailbox identity from `request.agent.id`, no body/path fallback | Implemented |
| Task lifecycle abuse | Owner-only actions (start/submit/complete), reviewer-only (approve/reject) | Implemented |
| Webhook signature bypass | Fail-closed when secrets configured but no match; raw body verification | Implemented |
| Outbound SSRF | URL validation blocks private/loopback/link-local IPs and unsafe schemes | Implemented |
| Git worktree injection | `execFileSync` with argv arrays, branch prefix validation, path containment | Implemented |
| Daemon token theft | Daemon tokens are hashed in DB; standalone credentials file uses restrictive permissions; UI in-process daemon avoids credential files | Implemented |

---

## Authentication Architecture

### Principal Types

The system uses a `Principal` concept for all authenticated requests:

```typescript
type Principal =
  | { type: 'human'; id: string; role: string }
  | { type: 'agent'; id: string; domain: string; capabilities: string[] };
```

### 1. Agent Authentication (API Key)

AI agents authenticate via the `X-Agent-API-Key` header.

**Flow:**

```
Agent Registration (POST /api/agents)
    → Server generates UUID + random API key
    → Server stores SHA-256 hash of the key
    → Server returns the key ONCE in response

Agent Request (any endpoint)
    → Agent sends X-Agent-API-Key: <plain-key>
    → Server hashes the key and compares against stored hash
    → If valid, request.agent is populated with { id, domain, capabilities }
```

**Key characteristics:**

- Keys are generated using `crypto.randomUUID()` + a random 32-byte hex string
- Server stores only the SHA-256 hash — the plain key is never stored
- Keys are shown only once during agent creation
- If a key is lost, the agent must be deleted and recreated

**Using agent auth:**

```bash
curl -H "X-Agent-API-Key: <uuid>-<32-hex-chars>" http://localhost:3000/api/boards/board-id/tasks
```

### 2. Human Authentication (JWT)

Human users authenticate via username/password and receive a signed JWT token.

**Flow:**

```
POST /api/auth/login { username, password }
    → Server verifies password against bcrypt hash
    → Server creates JWT with { sub, username, role }
    → Server signs with HS256 using JWT_SECRET
    → Returns { token, user }
```

**Token validation on each request:**

1. Extract `Authorization: Bearer <token>` header
2. Verify signature using `JWT_SECRET`
3. Check `exp` claim — reject if expired
4. Attach decoded payload to `request.user`

**Default admin user (development only):**

- Username: `admin`, Password: `admin123`
- Seeded automatically only outside production if `users` table is empty

**For production:**

- Set a strong `JWT_SECRET` (minimum 32 characters, not a known weak value)
- The server will refuse to start in remote posture without a strong secret
- Create the first admin through the setup form; `POST /api/auth/register` is accepted only while no users exist

### 3. Agent or Human Auth (`agentOrHumanAuth`)

Accepts either authentication method, rejects anonymous requests:

1. If `X-Agent-API-Key` header present → authenticate as agent
2. If `Authorization: Bearer <token>` header present → authenticate as human
3. Neither → **401 Unauthorized**

### 4. Realtime Authentication

SSE and WebSocket channels use dedicated realtime auth middleware:

- **Agents:** Authenticated via API key in headers
- **Humans:** Authenticated via Bearer JWT in headers, or short-lived query token (`?token=`) obtained from `GET /api/auth/stream-token`
- Stream tokens expire after 30 seconds to prevent leakage through logs/referrer headers
- Both auth types also require board access authorization via `authorizeBoardAccess`

### 5. Agent Registration Auth

`POST /api/agents` uses `registrationAuth` middleware:

- **local-dev posture:** Open registration (no token required)
- **remote posture:** Requires valid `ORCY_REGISTRATION_TOKEN` in `X-Registration-Token` header
- **Explicit override:** `ORCY_DEV_ALLOW_OPEN_REGISTRATION=true` allows open registration in any posture

### 6. Daemon Authentication

Standalone daemon routes use a separate daemon token model:

1. Registration creates a daemon token with a `daemon-` prefix.
2. The API stores only `hashDaemonToken(token)` in `daemon_instances.token_hash`.
3. Standalone daemons send the plain token as `X-Daemon-Token` to `/daemon/*` routes.
4. The token authorizes only the owning daemon's sessions and daemon-owned agents.

Human/UI daemon controls (`/daemons/*`) use normal human JWT auth and run the daemon engine inside the API process. The UI path does not write local credential files; generated managed-agent API keys are retained only in API process memory for immediate start.

---

## Authorization Model

### Route-Level Auth Summary

All non-public routes require authentication. Public allowlist:

| Route | Reason |
|-------|--------|
| `GET /health` | Health check |
| `GET /api/auth/setup-status` | First-run setup discovery |
| `POST /api/auth/register` | First admin bootstrap; forbidden after a user exists |
| `POST /api/auth/login` | Login endpoint |
| Inbound webhook routes (`/api/webhooks/*`, `/api/cicd/*`, `/api/code-review/*`) | Verified by provider signatures |

### Auth Middleware by Route Group

| Route Group | Middleware | Notes |
|-------------|-----------|-------|
| **Board reads** (`GET /boards/:id`, stats, events, anomalies, etc.) | `agentOrHumanAuth` + `requireBoardAccess` | Board existence + team membership for humans; agents pass through |
| **Board writes** (create, update, delete) | `humanAuth` (delete requires `adminOnly`) | — |
| **Feature CRUD** | `agentOrHumanAuth` | Feature reads/writes available to both |
| **Feature decompose** | `humanAuth` | AI decomposition restricted to humans |
| **Task lifecycle** (claim, start, submit, complete, fail, release) | `agentAuth` | Agent identity derived from `request.agent.id` |
| **Task approve/reject** | `humanAuth` | Only humans can approve or reject |
| **Task details, events, time report** | `agentAuth` or `agentOrHumanAuth` | Varies by endpoint |
| **Task comments** | `agentAuth` | Agents must be comment author for edit/delete |
| **Agent CRUD** | `agentOrHumanAuth` (read), `humanAuth + adminOnly` (write) | — |
| **Daemon machine routes** (`/daemon/*`) | `registrationAuth` or `daemonAuth` | Standalone daemon registration, heartbeat, claim-next, session updates |
| **Daemon UI routes** (`/daemons/*`) | `humanAuth` | Same-machine in-process daemon setup, start/stop, status, CLI detection |
| **Agent messages** | `agentAuth` | Sender and mailbox identity derived from `request.agent.id` only |
| **Attachments** | `agentOrHumanAuth` | Object-level authorization enforced |
| **Webhook management** | `humanAuth + adminOnly` | — |
| **Chat integration admin** | `humanAuth + adminOnly` | — |
| **SSE/WebSocket** | `authenticateRealtime + authorizeBoardAccess` | Short-lived stream tokens for browser EventSource |
| **Organizations/teams** | `humanAuth` (+ team role checks) | — |
| **Templates** | `humanAuth` | — |
| **Quality gates** | `agentOrHumanAuth` | — |

### Agent Identity Binding

Agent identity is **always** derived from the authenticated API key (`request.agent.id`). Route handlers **never** accept agent IDs from:

- URL path parameters (e.g., `:agentId`)
- Request body fields (e.g., `agentId`)
- Query parameters

This prevents one agent from impersonating another by modifying request parameters.

### Task Lifecycle Authorization

Task actions are classified by authorization level (enforced by `packages/api/src/middleware/taskAuth.ts`):

| Action | Who Can Perform |
|--------|----------------|
| Claim, Start, Submit, Complete | Assigned agent only |
| Release, Fail | Assigned agent only |
| Approve, Reject | Human reviewers only |
| Delete | Agent or human (owner/admin) |

### Board Access Control

Board-scoped routes use `requireBoardAccess` middleware:

- Returns **404** if the board does not exist (prevents enumeration)
- Returns **403** if a human user is not a team member
- Agent principals bypass the team check (agents access boards they have tasks on)

---

## Integration Security

### Inbound Webhooks

GitHub, GitLab, CI/CD, and code review webhooks use **fail-closed** verification:

- Raw request body is verified (not `JSON.stringify` of parsed body)
- Constant-time HMAC/token comparison prevents timing attacks
- If any secret is configured for the board and none matches the request, the request is rejected with **401**
- Missing repository/project metadata no longer bypasses verification

### Chat Commands

Slack slash commands verify `v0=${timestamp}:${rawBody}` signatures. Discord interactions verify Ed25519 signatures.

- **local-dev:** Unsigned commands allowed when secrets are not configured
- **remote posture:** Commands rejected with **401** when secrets/public keys are missing

### Outbound Webhooks and SSRF Protection

Outbound webhook delivery and chat message sending use URL validation:

- Blocks `http`, `file`, `ftp`, and other unsafe schemes (HTTPS only in remote posture)
- Blocks loopback (`127.0.0.1`, `::1`, `localhost`), private (`10.x`, `172.16-31.x`, `192.168.x`), link-local (`169.254.x`), and multicast IPs
- Filters unsafe request headers (`authorization`, `cookie`, `proxy-*`, etc.)
- `ORCY_SSRF_ALLOWLIST` allows specific trusted internal destinations

---

## Secret Management

### Secrets at Rest

Webhook signing secrets, chat bot tokens, and integration secrets are stored in plaintext in SQLite. This is a known accepted risk for a personal-use local application. For production deployments:

- Encrypt the database file at the filesystem level
- Restrict file access to the API process user
- Backups should be encrypted

### Secret Redaction

Secrets are redacted from:

- Board export data (webhooks excluded by default; `includeSecrets` requires admin auth)
- API list responses (webhook lists omit actual secret values)
- Logs (security config logs posture without printing secrets)
- MCP tool output

---

## Git Worktree Security

Git worktree operations use safe process execution:

- `execFileSync` with argv arrays (no shell string interpolation)
- Branch prefixes validated against `^[a-zA-Z0-9._\/-]+$` regex
- Repository paths validated for directory containment
- `rm -rf` shell fallback replaced with `fs.rmSync` after containment check

---

## Rate Limiting

| Dimension | Value |
|-----------|-------|
| Window | 1 minute |
| Max requests | 100 per window |
| Key strategy | API key for agents, IP for humans |
| Response headers | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` |
| Exceeded response | 429 with `Retry-After` header |

---

## CORS Policy

CORS is disabled by default (`origin: false`). For production with a separate frontend domain, configure in `packages/api/src/index.ts`:

```typescript
await fastify.register(cors, {
  origin: 'https://orcy.example.com',
  credentials: true,
});
```

---

## Input Validation

All user input is validated using Zod schemas:

- String length limits enforced (title max 200, description max 5000)
- UUID validation for all ID parameters
- Enum validation for status, priority, agent type
- Array size limits for labels, capabilities, artifacts

SQL injection is prevented through parameterized queries via Drizzle ORM.

---

## Audit Trail

Every task state change creates an immutable event in the `task_events` table. Events are append-only — no update or delete operations are provided.

---

## Security Headers

The API uses `@fastify/helmet` for security headers. `Content-Security-Policy` is disabled (required for SSE). Other Helmet defaults are active: `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, etc.

---

## Known Security Limitations

| Limitation | Severity | Recommendation |
|-----------|----------|---------------|
| No HTTPS enforcement | High | Configure TLS via reverse proxy |
| UI in-process daemon credentials are memory-only | Medium | Use standalone CLI daemon for persisted autonomous operation across API restarts |
| No API key rotation mechanism | Medium | Implement key rotation endpoint |
| No audit log retention policy | Low | Add TTL or archival for old events |
| Secrets stored plaintext in SQLite | Medium | Encrypt at filesystem level for production |
| Plugin system allows arbitrary code execution | High | Only load trusted plugins from `PLUGINS_DIR` |
| File uploads not virus-scanned | Medium | Add malware scanning in production |
| No agent board-scoping (agents access all boards) | Medium | Add board allowlist if multi-user |
| Attachment filename not RFC 5987 encoded | Low | Use safe ASCII fallback with `filename*=`

---

## External Integrations Security (v0.12)

### Token Storage

OAuth access tokens and PATs are stored in the local SQLite database (`integration_connections.access_token`). Orcy runs as a local-first tool — SQLite file permissions are the primary security boundary. API responses never expose stored tokens: the `toView()` masking function replaces `access_token`, `refresh_token`, and `webhook_secret` with boolean presence indicators (`hasAccessToken` / `hasRefreshToken` / `hasWebhookSecret`). Tokens are redacted from logs.

Deployers are responsible for database file protection. Future hardening may add OS keychain integration or encrypted-at-rest token storage.

### API Response Masking

All integration connection endpoints return `IntegrationConnectionView`, a DTO that excludes sensitive fields:
- `accessToken` → `hasAccessToken: boolean`
- `refreshToken` → `hasRefreshToken: boolean`  
- `webhookSecret` → `hasWebhookSecret: boolean`

Connection listing, creation responses, and update responses all use this mask. The raw token values are never transmitted after the initial creation request.

### Webhook HMAC Verification

GitHub issue webhooks are received at `POST /webhooks/github/issues`. Verification uses constant-time HMAC-SHA256 comparison:

1. Raw request body is preserved for signature computation
2. `X-Hub-Signature-256` header is compared against `sha256=<hmac(secret, rawBody)>`
3. Secret lookup matches against enabled GitHub connections for the repository owner/name in the payload
4. Invalid signatures are rejected (fail-closed)
5. Connections without a webhook secret are skipped silently (no-op)

Implementation: `verifyGitHubHmac()` in `packages/api/src/config/integrationSecurity.ts`.

### OAuth and PAT Scope Expectations

**Device flow (primary):** Uses GitHub OAuth device authorization grant. Requested scopes: `repo` (issues read/write + webhook management) and `read:user` (account name display). Only the embedded `client_id` is needed — no `client_secret` is required for device flow. The `client_id` can be overridden via `ORCY_GITHUB_OAUTH_CLIENT_ID` environment variable for self-hosted deployments.

**Linear OAuth:** Uses authorization code with PKCE as a public-client flow. Orcy ships a public Linear `client_id` default and sends `code_challenge` / `code_verifier` for token exchange and refresh. No Linear `client_secret` is embedded, required, or accepted for this PKCE path. Self-hosted deployments may override the public client ID via `ORCY_LINEAR_OAUTH_CLIENT_ID`.

**Jira OAuth:** Atlassian 3LO requires a confidential client secret. Self-hosted Orcy deployments must provide their own `ORCY_JIRA_OAUTH_CLIENT_ID` and `ORCY_JIRA_OAUTH_CLIENT_SECRET` via environment variables. Real Jira secrets must never be committed to the MIT repository or packaged CLI/frontend artifacts.

**Jira API token:** This is the recommended Jira path for local/self-hosted Orcy. Users provide their Atlassian account email, an Atlassian API token, Jira site URL, and project key. Orcy uses Basic authentication against the site-local Jira REST API (`https://<site>.atlassian.net/rest/api/3`) and stores the token locally with API-response masking.

**PAT fallback:** Users provide a Personal Access Token with `repo` scope. The token is entered once and never displayed again. PATs created via GitHub's token settings page (`github.com/settings/tokens`) can be revoked at any time.

### Recoverable Webhook-Permission Failure

Webhook creation is attempted during connection setup via `githubAdapter.createGitHubWebhook()`. If the PAT lacks `admin:repo_hook` permission, GitHub returns 403. Orcy treats this as a recoverable setup warning — the connection remains usable for manual sync. The user can add webhook permissions and re-try webhook configuration later.

### SSRF Posture

v0.12 uses a fixed GitHub API base URL (`https://api.github.com`). No user-supplied provider URLs are accepted for outbound requests. Future support for self-hosted GitHub Enterprise or custom Jira/Linear instances will reuse the existing SSRF validation in `integrationSecurity.ts` (`validateOutboundUrl()`) which blocks private/loopback/link-local IPs and unsafe schemes.

### Threat Model Additions

| Threat | Mitigation | Status |
|--------|-----------|--------|
| Token exposure in API responses | `toView()` DTO masking | Implemented |
| Webhook signature spoofing | Constant-time HMAC-SHA256 verification | Implemented |
| OAuth client ID extraction | GitHub device flow and Linear PKCE need only public `client_id` values; Jira secrets are env-only | Accepted |
| SQLite token theft | Local filesystem permissions; documented as deployer responsibility | Documented |
| Outbound SSRF via provider URLs | Fixed GitHub API base; future URLs validated via existing SSRF checks | Implemented |

---

## Production Security Checklist

- [x] Signed JWT authentication with HS256
- [x] Password hashing with bcrypt
- [x] Default-deny route authentication
- [x] Agent identity binding to API keys
- [x] Task lifecycle ownership enforcement
- [x] Realtime channel authentication and authorization
- [x] Inbound webhook fail-closed signature verification
- [x] Outbound SSRF protection
- [x] Git worktree safe execution
- [x] Secret redaction in exports and logs
- [x] Startup validation for remote posture secrets
- [ ] Configure TLS via Nginx/Caddy reverse proxy
- [ ] Set a strong `JWT_SECRET` environment variable
- [ ] Set `ORCY_REGISTRATION_TOKEN` for agent registration
- [ ] Restrict API binding to `127.0.0.1` (behind proxy)
- [ ] Enable CORS only for your frontend domain
- [ ] Set up log monitoring for security events
- [ ] Implement API key rotation mechanism for agents
- [ ] Consider adding IP allowlisting for agent endpoints
