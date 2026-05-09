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
- Seeded automatically if `users` table is empty

**For production:**

- Set a strong `JWT_SECRET` (minimum 32 characters, not a known weak value)
- The server will refuse to start in remote posture without a strong secret

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

---

## Authorization Model

### Route-Level Auth Summary

All non-public routes require authentication. Public allowlist:

| Route | Reason |
|-------|--------|
| `GET /health` | Health check |
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
| No API key rotation mechanism | Medium | Implement key rotation endpoint |
| No audit log retention policy | Low | Add TTL or archival for old events |
| Secrets stored plaintext in SQLite | Medium | Encrypt at filesystem level for production |
| Plugin system allows arbitrary code execution | High | Only load trusted plugins from `PLUGINS_DIR` |
| File uploads not virus-scanned | Medium | Add malware scanning in production |
| No agent board-scoping (agents access all boards) | Medium | Add board allowlist if multi-user |
| Attachment filename not RFC 5987 encoded | Low | Use safe ASCII fallback with `filename*=`

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
