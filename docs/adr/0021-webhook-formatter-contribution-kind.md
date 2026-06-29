# ADR-0021: Webhook Formatter Contribution Kind

**Status:** Accepted  
**Date:** 2026-06-30  

## Context

Webhook payload formatting was hardcoded as a 3-entry `FORMATTER_REGISTRY` Map in `webhook-dispatch.ts` (standard, slack, discord). Each formatter is a pure function `(enrichment, eventType, deliveryId) => object` that transforms enriched event data into a provider-specific payload shape.

The v0.22.8 plugin foundation established the pattern for adding new contribution kinds. This is the first extraction using that foundation — proving the data-driven capability matrix, formatter registry, and gradual migration pattern work end-to-end.

## Decision

Add `webhookFormatter` as the 6th contribution kind (system-scoped). Plugins can register format handlers that the webhook dispatcher checks before falling through to the in-tree `FORMATTER_REGISTRY`.

### Contribution Shape

```typescript
interface WebhookFormatterContribution {
  kind: "webhookFormatter";
  scope: "system";
  formatId: string;
  label: string;
  timeoutMs?: number;
  requires: [];  // No capabilities — formatters are pure functions
}
```

### Handler Shape

```typescript
type FormatterHandler = (
  enrichment: unknown,
  eventType: string,
  deliveryId: string,
) => object;
```

No `PluginContext` — formatters are pure data transformations with no side effects, no capabilities, and no need for logging or audit. This mirrors the `McpToolHandler` pattern (no context).

### Dispatch Pattern

Plugin-first lookup with in-tree fallback (gradual migration, same as notification channels):
1. `getFormatterHandler(formatId)` checks the plugin registry
2. If hit, invoke the plugin formatter
3. If miss, fall through to `FORMATATTER_REGISTRY` in-tree Map
4. If still miss, default to "standard"

### Reference Plugins

3 plugins created as thin wrappers around the existing in-tree formatter functions:
- `formatter-standard` — wraps `formatStandardPayload`
- `formatter-slack` — wraps `formatSlackPayload`
- `formatter-discord` — wraps `formatDiscordPayload`

## Consequences

- Users can add custom webhook formats (e.g., Microsoft Teams, Mattermost, custom JSON schema) by dropping a plugin in `plugins/` with a `webhookFormatter` contribution.
- The in-tree `FORMATTER_REGISTRY` remains as backward-compat fallback (identical to the notification channel pattern from v0.22.6).
- No new capabilities needed.
- First proof-of-concept for the v0.22.8 foundation: validates the data-driven matrix, registry pattern, and gradual migration approach.

## Alternatives Considered

- **Reuse `customHttpRoute` kind**: Rejected — HTTP routes are mounted on Fastify at boot; formatters are per-dispatch pure functions. Different lifecycle, different handler signature.
- **Give formatters a PluginContext**: Rejected — formatters are pure data transformations. Adding a context would imply they can log, audit, or access capabilities, which they cannot and should not.
