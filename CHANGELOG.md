# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.22.5 — 2026-06-29

### Bug Fixes

#### reader scope, veto timing, auth, dead hook bus, boot order ([`fc2f74c`](https://github.com/waterworkshq/orcy/commit/fc2f74c5c501ae615c063c7a5ab7b84c6f163ed7))

1. v0.22.5 Plugin Review Fixes: Security & Wiring:



## 0.22.4 — 2026-06-29

### Bug Fixes

#### quarantine key mismatch, pre-interceptor run leak, detected signal pipeline ([`33ee6c7`](https://github.com/waterworkshq/orcy/commit/33ee6c7c392f66d916b2f45eee811f47f1ea5db5))

1. v0.22.4 Plugin Review Fixes: Runtime & Pipeline:



## 0.22.3 — 2026-06-29

### Features

#### add timeoutMs watchdog, catch-up scan, and persistent quarantine ([`3a2784d`](https://github.com/waterworkshq/orcy/commit/3a2784dafcf3f6940e22eb0b4fc38446e83d5f2c))

1. v0.22.3 Detection Hardening:

3. timeoutMs watchdog: optional manifest field on all contribution kinds;
4. Promise.race wrapper in runDetector/dispatchToChannelPlugin/dispatchInterceptorRun;
5. default 5000ms detectors, 0 (disabled) channels/post-interceptors
6. Catch-up scan: detectorScanService with setInterval at boot;
7. lastScannedAt watermark on plugin_enrollments (migration 0040);
8. dedup via plugin_runs existsForTriggerEvent check;
9. ORCY_DETECTOR_SCAN_INTERVAL_SECONDS env (default 300s)
10. Persistent quarantine: plugin_quarantines table (migration 0041);
11. loadQuarantinesFromDb at boot; incrementError persists to DB;
12. admin DELETE /habitats/:id/plugins/:pluginKey/quarantine endpoint

14. 10 new tests (3 timeout + 3 scan + 4 quarantine). API 3617 pass.
