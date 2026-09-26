# Deployment Guide

This guide covers deploying Orcy to production environments.

---

## Architecture Overview

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  Nginx/Caddy│────▶│  Kanban API  │────▶│  Drizzle ORM │
│  (TLS/Proxy)│     │  (Fastify)   │     │ better-sqlite3│
└──────┬──────┘     └──────┬───────┘     │  orcy.db)  │
       │                   │             └──────────────┘
       │
┌──────▼──────┐
│  React SPA  │
│  (Static)   │
└─────────────┘
```

---

## Prerequisites

- Bun or Node.js
- A domain name with DNS configured (for production)
- TLS certificates (Let's Encrypt recommended, for production)

### API Server

```bash
# Install dependencies
pnpm install --frozen-lockfile

# Build
pnpm build:api

# Start the API server
NODE_ENV=production PORT=3000 HOST=0.0.0.0 node packages/api/dist/index.js
```

### Process Management

Use PM2 or systemd to manage the API process:

**PM2:**

```bash
npm install -g pm2
pm2 start packages/api/dist/index.js --name orcy-api
pm2 save
pm2 startup
```

**systemd** (`/etc/systemd/system/orcy-api.service`):

```ini
[Unit]
Description=Orcy API
After=network.target

[Service]
Type=simple
User=orcy
WorkingDirectory=/opt/orcy
ExecStart=/usr/bin/node packages/api/dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOST=0.0.0.0
EnvironmentFile=/opt/orcy/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable orcy-api
sudo systemctl start orcy-api
```

---

## TLS / HTTPS Setup

### Nginx Reverse Proxy

```nginx
server {
    listen 443 ssl http2;
    server_name orcy.example.com;

    ssl_certificate /etc/letsencrypt/live/orcy.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/orcy.example.com/privkey.pem;

    # React SPA
    location / {
        root /opt/orcy/packages/ui/dist;
        try_files $uri $uri/ /index.html;
    }

    # API proxy
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Health check proxy
    location /health {
        proxy_pass http://127.0.0.1:3000;
    }

    # SSE proxy (requires no buffering)
    location /sse/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Connection '';
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        chunked_transfer_encoding off;
    }
}

server {
    listen 80;
    server_name orcy.example.com;
    return 301 https://$server_name$request_uri;
}
```

### Caddy (simpler alternative)

```
orcy.example.com {
    root * /opt/orcy/packages/ui/dist
    try_files {path} /index.html
    file_server

    reverse_proxy /api/* localhost:3000
    reverse_proxy /health localhost:3000

    reverse_proxy /sse/* localhost:3000 {
        flush_interval -1
        transport http {
            read_timeout 86400s
        }
    }
}
```

---

## Database

The app uses **Drizzle ORM with better-sqlite3** for production. Tests use `sql.js` (SQLite via WASM). Data is stored in `orcy.db` in the working directory. No external database server needed.

---

## Backup and Recovery

The database runs in **WAL mode** (`PRAGMA journal_mode = WAL` in `packages/api/src/db/index.ts:283`). Committed transactions may still live in the `orcy.db-wal` file and are merged into the main database only at checkpoint time — so a plain `cp orcy.db` of a running API can produce a **torn or stale snapshot** that misses committed writes.

A consistent backup uses one of:

1. **SQLite-consistent backup (works while the database is live).** The SQLite CLI's online backup writes a point-in-time-consistent single file even with connections open. This requires the `sqlite3` CLI on the host — a host-side tool that is **not** an Orcy dependency (Orcy uses better-sqlite3 in-process); no shipped script installs or checks for it:

   ```bash
   sqlite3 orcy.db ".backup 'orcy.db.backup-$(date +%Y%m%d)'"
   ```

   (`VACUUM INTO '…'` is equivalent on SQLite ≥ 3.27; neither command is wired into any shipped Orcy script.)

2. **Truly offline copy.** Stop **every** process that uses this database — the API, the daemon, and any other client, however they are named and managed on this host — and **wait for them to exit** (verify nothing still holds the file open, e.g. `lsof orcy.db` returns nothing). Only then copy the WAL-aware database set, and restart afterward:

   ```bash
   # NOT a runnable recipe: every Orcy process using orcy.db must already be
   # stopped AND fully exited before these copies run. Stopping one service
   # (e.g. `systemctl stop orcy-api`) is NOT enough — daemons and other
   # clients can keep the database open and commit to the WAL after the copy starts.
   backup="orcy.db.backup-$(date +%Y%m%d)"
   cp orcy.db "$backup"
   [ -f orcy.db-wal ] && cp orcy.db-wal "${backup}-wal"
   [ -f orcy.db-shm ] && cp orcy.db-shm "${backup}-shm"
   ```

   If you copy only the main database file, ensure a completed checkpoint or a clean close first — a `cp orcy.db` taken while any connection is open can be torn or miss committed WAL writes.

**Do not** checkpoint-then-copy while the API runs and treat the result as a backup: a `wal_checkpoint(TRUNCATE)` merges the WAL into the main file at checkpoint time, but commits landing between the checkpoint and the end of the copy go to a fresh WAL and can be missing from — or tear across — the copied files. The snapshot is neither point-in-time nor guaranteed consistent. Use one of the consistent methods above; a bare file copy of a live WAL database is equally unsafe.

---

## Monitoring

### Health Endpoints

```bash
# Kanban API
curl http://localhost:3000/health
```

### Logging

The API uses pino-pretty for all logging (human-readable format). `NODE_ENV=production` does not switch to JSON logging — the pino-pretty transport is hardcoded in `packages/api/src/index.ts`.

To enable JSON logging, modify the logger configuration in `src/index.ts` to remove the `transport` block.

### Key Metrics to Monitor

| Metric | Source | Alert Threshold |
|--------|--------|----------------|
| API response time | API logs / pino | > 500ms p99 |
| Error rate | API logs | > 1% of requests |
| Stale tasks released | API logs | Spike indicates agent issues |

---

## Scaling Considerations

### Vertical Scaling

- **API**: Increase Node.js memory with `--max-old-space-size`

### Horizontal Scaling

**Known limitation — single control plane.** A multi-instance deployment is not established end-to-end: the operational recommendation is a single API process per database (the daemon may also connect; SQLite allows multiple writers but Orcy's coordination is process-local), and each API process starts its own background loops and holds process-local SSE state. Running multiple API instances against one shared database is not a supported topology today — the per-process loops and SSE fan-out below would require explicit coordination that Orcy does not ship. Scale vertically (larger instance, `--max-old-space-size`) in the meantime.

Some background operations are individually fenced against multi-process contention — examples:

| Worker | Safety mechanism | Status |
|--------|------------------|--------|
| Creation-dispatch worker (`startCreationDispatchWorker`, booted in `packages/api/src/index.ts:52`) | Unique-per-process worker ID + lease-fenced CAS per attempt (`creationDispatchWorker.ts:32-36`) | Fenced for its operation |
| Occurrence lease-recovery worker (`startOccurrenceLeaseRecoveryWorker`, booted in `packages/api/src/index.ts:51`) | Fenced lease reclaim + reclaim-count circuit breaker (`scheduledOccurrenceRecovery.ts`) | Fenced for its operation |
| Scheduled-occurrence reservation (`reserveScheduledOccurrence`, `packages/api/src/repositories/scheduledOccurrenceReservation.ts:611`) | Manual `BEGIN IMMEDIATE` transaction; concurrent reservations serialize to a typed `already_exists`/`lost_race` outcome (`scheduledOccurrenceReservation.ts:566-600`) | Fenced for its operation |

This is a list of examples, not an exhaustive census: absence from the table is not proof that a worker is unfenced, and presence is not a guarantee against every contention outcome (e.g. `SQLITE_BUSY` beyond the busy timeout).

Other process-local coordination considerations:

- **All other background schedulers** (`startAllSchedulers`, `packages/api/src/services/scheduler.ts:79-260` — stale-task release, overdue checks, anomaly scans, prioritization, digest generation, notification digests, automation scans, sprint auto-complete, etc.) are plain per-process `setInterval` loops, so under multiple instances each loop runs once per process. Individual work inside these loops may still carry durable dedup or fencing — do not assume duplicated work, and do not assume exactly-once work, without proving each worker's lease/idempotency behavior.
- **SSE fan-out is in-process.** Connections live in the API process's memory (`packages/api/src/routes/sse.ts`), and event broadcasting walks that in-process registry. Sticky sessions or routing `/sse/*` to a single instance would only **fragment events across instances** — it does not coordinate schedulers or provide cross-instance fan-out.

### Rate Limiting

The API ships a **custom in-process rate-limit middleware** (`packages/api/src/middleware/rateLimit.ts`), not `@fastify/rate-limit`. There is no single global `max` to adjust, and the hook is installed on selected route groups (`packages/api/src/httpApp.ts`) — not a blanket guarantee on every route. Limits are per principal class over a sliding 60-second window:

| Principal class | Key | Default limit | Override |
|-----------------|-----|---------------|----------|
| Agent | `X-Agent-API-Key` header — a presented agent key takes this classification even when authentication itself fails | 60 requests/min | Per-agent DB column `rateLimitPerMinute`, looked up per request |
| Human | `Authorization` header | 500 requests/min | — |
| Unauthenticated fallback | IP | 60 requests/min | — |

Storage is an in-memory `Map` — **process-local**: counters are not shared across processes or restarts. Responses that reach the limiter carry `X-RateLimit-Limit` and `X-RateLimit-Remaining`; a 429 additionally adds `Retry-After` (no `X-RateLimit-Reset` header is sent).

---

## Security Posture

The server classifies its environment as either **local-dev** or **remote** at startup (see [SECURITY.md](./SECURITY.md) for full details). Remote posture enforces stricter defaults and crashes if critical secrets are missing.

| Posture | Trigger | Key Behavior |
|---------|---------|--------------|
| **local-dev** | `HOST=127.0.0.1` and `NODE_ENV !== 'production'` | Open agent registration, relaxed integration checks |
| **remote** | `NODE_ENV=production` or non-localhost `HOST` | Requires `JWT_SECRET` and `ORCY_REGISTRATION_TOKEN`, fail-closed integrations |

### Required Secrets (Remote Posture)

The server will **refuse to start** in remote posture without these:

| Variable | Purpose |
|----------|---------|
| `JWT_SECRET` | HS256 signing key for JWTs. Must not be a known weak value (e.g., `changeme`, `dev-secret-change-in-production`). Minimum 32 characters recommended. |
| `ORCY_REGISTRATION_TOKEN` | Token required for agent registration via `POST /api/agents`. Agents must send this in the `X-Registration-Token` header. |

### Optional Dev Overrides

| Variable | Purpose |
|----------|---------|
| `ORCY_DEV_ALLOW_OPEN_REGISTRATION=true` | Allow agent registration without token in remote posture. Use only in development/staging. |
| `ORCY_SSRF_ALLOWLIST` | Comma-separated internal hostnames allowed for outbound webhook delivery despite SSRF protections. |

### Inbound Integration Secrets

These are configured per-board via the API (not environment variables):

| Setting | Routes Affected |
|---------|----------------|
| `githubSecret` / `gitlabToken` (HMAC) | CI/CD and code review webhook verification |
| `slackSigningSecret` | Slack slash command verification |
| `discordPublicKey` | Discord interaction verification |

The non-secret fields on each board are persisted via `PATCH /habitats/:habitatId`
using the corresponding Zod subset (`codeReviewSettingsSchema` exposes
`taskPattern` and `autoApproveOnMerge`; `ciCdSettingsSchema` exposes
`taskPattern` only). HMAC secrets are write-only: `PUT /habitats/:habitatId/webhook-secrets`
takes a `provider` (`code_review` or `ci_cd`) plus optional `githubSecret` /
`gitlabSecret` (omit = no change, string = set, `null` = clear) and merges them
into the existing settings JSON. The response carries `hasGithubSecret` /
`hasGitlabSecret` presence booleans only — the raw secret never leaves the
handler.

In remote posture, unsigned inbound requests are **rejected** when secrets are configured but no signature matches.

---

## Production Checklist

- [ ] Configure TLS via Nginx/Caddy
- [ ] Set `NODE_ENV=production`
- [ ] Set `HOST=0.0.0.0` (or specific interface)
- [ ] Set `JWT_SECRET` to a strong random value (min 32 chars)
- [ ] Set `ORCY_REGISTRATION_TOKEN` to a random value
- [ ] Configure `ORCY_API_URL` to public URL
- [ ] Set up automated database backups (copy `orcy.db`)
- [ ] Configure log aggregation
- [ ] Set up health check monitoring
- [ ] Review and update rate limit thresholds
- [ ] Configure webhook secrets for inbound integrations (set HMAC secrets per board via `PUT /api/habitats/:habitatId/webhook-secrets`; configure non-secret fields like `taskPattern` and `autoApproveOnMerge` via `PATCH /api/habitats/:habitatId`)
- [ ] Run `bun typecheck && bun test` before deploying
- [ ] Verify `bun audit` reports no high vulnerabilities
