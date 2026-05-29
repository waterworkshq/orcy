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

```bash
# Copy the database file (stop API first for consistent snapshot)
cp orcy.db orcy.db.backup-$(date +%Y%m%d)
```

For automated backups, use cron to copy the file periodically.

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

- **API**: Run multiple instances behind a load balancer. SSE connections are stateful — use sticky sessions or route `/sse/*` to a single instance.

### Rate Limiting

The API has built-in rate limiting (100 requests/minute per key). Adjust in `packages/api/src/index.ts`:

```typescript
await fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});
```

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
| `githubSecret` / `gitlabToken` | CI/CD and code review webhook verification |
| `slackSigningSecret` | Slack slash command verification |
| `discordPublicKey` | Discord interaction verification |

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
- [ ] Configure webhook secrets for inbound integrations
- [ ] Run `bun typecheck && bun test` before deploying
- [ ] Verify `bun audit` reports no high vulnerabilities
