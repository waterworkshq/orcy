# Plugin Capability Whitelist — Vetted Menu, No Open Repository Access

Status: accepted · 2026-06-29

Depends on: ADR-0011 (Plugin Manifest V1, discriminated contributions + manifest/module split)

## Context

Constraint #4 locks "guarded `PluginContext` wrapping repositories" — no raw `getDb()`, no full repo DI. Grilling Q3 surfaced the question of *what* the context contains. A flat "give every plugin every repo method" violates the guardrail and the v0.18.1 "no getDb in services" discipline, and lets a malfunctioning or naive external detector delete tasks, forge agent self-reports via `signalType:"experience"` pulses, or wipe audit history. Prerelease phase means Orcy will eventually absorb community plugins; the v0.22 surface sets precedent for what they can reach.

Adding `delete/update` methods to capability surfaces later is trivially backward-compat plugin authors will demand them — but the inverse (removing mutation authority after plugins shipped against it) is breaking. So the v0.22 surface must start narrow and grow deliberately.

## Decision

`PluginContext` (per-handler-invocation object constructed by the loader, scoped to pluginId + contributionId + habitatId + runId) exposes only a **vetted capability whitelist** declared in `@orcy/shared`. Plugins cannot reach repository methods by other means; every data-in / data-out operation goes through a purpose-built capability method.

The v0.22 whitelist has exactly five capabilities:

| Capability | Methods | Bounds |
|---|---|---|
| `pulseReader` | `listByHabitatSince(habitatId, since)`, `listByHabitatBetween(habitatId, from, to)`, `getPulse(pulseId)` | Habitat-pinned where-clause. No mutation. |
| `pulseWriter` | `createDetectedSignal(input)` | Server injects `metadata.detected:true`, `metadata.detector:<pluginId>`, `metadata.detectorRunId:<runId>`. Rejects `signalType:"experience"` (agent self-report) and any future sacred signal types. No update, no delete. |
| `commentReader` | `listByHabitatSince(habitatId, since)` (union over task_comments + mission_comments) | No mutation. |
| `taskReader` | `getTask(taskId)`, `listTasksByHabitat(habitatId, filter)` | Auth fields (`apiKeyHash`, etc.) stripped. No mutation. |
| `habitatReader` | `getHabitat(habitatId)` | No mutation. Auth fields stripped. |

Universal context fields (always present, not capability-gated):
- `logger` — wraps `@orcy/api/lib/logger` with `{ pluginId, runId, contributionId }` context tags.
- `audit` — `audit.log(payload: AuditPayload)` writes an `AuditEvent` row with `auditSource: "plugin"`, `source: "plugin:<pluginId>"`, `runId`. Write-only: plugins cannot read the audit history (the audit object has no read methods).

Contribution-kind-specific fields (not capabilities, present because the contribution kind implies them):
- `notificationPayload` on `notificationChannel` contribution context — the parsed notification envelope (recipient, template, data) + delivery metadata. NO DB access beyond this; channel plugins are pure formatters, not readers.
- `transition` on `lifecycleInterceptor` contribution context — `TransitionRef`: `{ taskId, action, from, to, claimedAgentId, byAgentId, task }`. Inspect-only; no method on `TransitionRef` causes mutation. The interceptor signals intent (allow/block + signals to emit) through its return value, not through writer capability methods.

Capabilities are declared per contribution on the manifest:

```ts
{
  kind: "signalDetector",
  scope: "habitat",
  requires: ["pulseReader", "pulseWriter", "commentReader", "taskReader"],
  ...
}
```

The loader refuses to load a manifest whose `requires` references a capability not in the whitelist, or not allowed for that contribution kind (e.g. detectors cannot `requires: ["notificationPayload"]`; channels cannot `requires: ["pulseWriter"]`). The TS type of an undeclared capability method is `undefined` on the context object — so plugin code attempting an undeclared call does not typecheck.

**Adding a new capability requires a code change to `@orcy/shared` plus a release.** Plugin authors cannot invent, fork, or request capabilities Orcy core hasn't vetted. Adding the 6th capability in v0.23+ is a deliberate extension of the whitated menu, not a per-plugin negotiation.

## Rationale

- **The whitelist is the contractual boundary between Orcy core and plugin authors.** The residual risk (plugin author's own code can still touch `process.env`, `fs`, `network` per Constraint #3 in-process) is operator trust — the same trust as `pnpm add`. README/SECURITY docs gate this explicitly: "treat plugins like code dependencies; audit before installing." The whitelist closes the Orcy-data-mutation surface; the OS-side stays operator trust.

- **Detectors cannot forge self-reports.** `pulseWriter.createDetectedSignal` is the only way to emit a signal from a plugin. The server injects provenance (`metadata.detected:true`, `metadata.detector:<pluginId>`, `metadata.detectorRunId:<runId>`), rejects `signalType:"experience"` (which per ADR-0004 is agent self-report only), and forbids update/delete. A naive or hostile detector cannot flood the experience pipeline with fakes — it can only write its own detected signals, which the wiki UI surfaces distinctly ("detected by plugin X" attribution in the Signal Surface) and which v0.23 triage treats with separate weighting.

- **Detectors cannot mutate signals, tasks, or audit history.** No `pulseWriter.update`, no `delete`, no `taskWriter`. The pipeline is append-only by construction.

- **Channels cannot read Orcy data.** `notificationPayload` is the only data they see — which means a hostile channel plugin can only exfiltrate notification content (already low-sensitivity in the Orcy model — subjects/bodies of task transitions are not secrets). They cannot read pulse payloads, audit history, or task bodies beyond what's in the notification envelope.

- **Interceptors cannot approve/reject transitions by writing to the task row.** They return `{ allow: false }` for pre-phase blocks. The transition service owns the row mutation. This is the Q5 lifecycle interceptor contract; the whitelist enforces its physical impossibility-by-API-shape.

- **Adding a new capability is deliberate.** The v0.22 menu will not be enough forever. Detectors may eventually need `missionReader`, `effortReader`, `codeEvidenceReader`. Channels may eventually need `templateRenderer`. New capability addition = code change to `@orcy/shared`, audit-event keyed to "capability added in vX.Y", and a release note. Operators can plan around it. This is the inverse of "every repo method is a capability" which would silently expand the attack surface every time any repo got a new method.

## Alternatives considered

- **Full repository object via DI (reject).** Breaks Constraint #4 directly. Lets detectors reach `repo.delete`, `repo.update`, raw SQL via `getDb()`. Zero guardrail. A single plugin bug could wipe a habitat's tasks.

- **Flat PluginContext, every capability present (reject).** The TS-introduced "narrow doesn't matter" — you call `ctx.pulseWriter.delete` and it works because `pulseWriter` exists as a method stereotype on the flat context. This is the same as "full repo" with extra vocabulary.

- **Worker-thread isolation with serialized context (reject).** Real FS/network isolation. But breaks Constraint #3 (in-process). Adds message-passing infra — every repo call becomes an async postMessage HTTP — latency goes ~100x, sync timing invariants break. Planner cost is orders of magnitude more than the v0.22 prerelease phase needs.

- **Env sandbox + worker isolation (reject).** Same as above plus stripping `process.env`. Rejected for the same reason; the residual risk in v0.22 is operator trust and that's called out in README.

- **Per-plugin capability negotiation instead of vetted whitelist (reject).** Manifest declares what it wants; loader computes a context with exactly those methods. But this allows `requires: ["taskWriter.delete"]` — plugin authors can invent capability names if Orcy core doesn't gate them. Closing this means maintaining the whitelist as the source of truth anyway — so do that from day one (this decision).

## Consequences

- `packages/shared/src/types/plugin.ts` (already added by ADR-0011 for `PluginManifest` + `Contribution`) also owns the `PluginCapability` type, the per-capability method signatures (`PulseReader`, `PulseWriter`, `CommentReader`, `TaskReader`, `HabitatReader`), and the `kind → allowed capabilities` map (the loader consults this to refuse mismatches).

- `packages/api/src/plugins/context.ts` (new) constructs the `PluginContext` per handler invocation by composing the declared capability surfaces. Each capability surface wraps the underlying repository and applies the bounds (habitat filter, auth field stripping, detected-signal injection).

- `pulseWriter.createDetectedSignal` writes via `pulseRepo.create` but ONLY with `metadata.detected:true` + `metadata.detector` fields pre-set. The repo's generic `create` method is NOT exposed to plugins.

- The `taskReader.getTask` capability strips `apiKeyHash`, `createdBy.secret`, and any other auth-bearing field from the `Task` shape before returning. This is a projection, not a passthrough — new auth fields added to future `Task` shapes are stripped by default and must be explicitly allowlisted for reader capability.

- `habitatReader.getHabitat` strips `apiKeyHash`, `wiki_settings` (private to admin), and similar. Habitats are NOT leaked wholesale to plugins.

- The audit `audit.log(payload)` method writes an `AuditEvent` to the canonical projection (consistent with webhook/integration/scheduler sources). The audit row carries `source: "plugin:<pluginId>"`, `runId`, `contributionId`, `kind`, `scope`. Plugins cannot forge source strings — the loader constructs the row from the plugin identity, not from the payload.

- Adding new capabilities in v0.23+ is a deliberate `@orcy/shared` change. The README/CHANGELOG notes "plugin capability added: <name>". Operators upgrading across a release where a new capability shipped see the menu grow; existing plugins don't automatically get it (their `requires` field must list the new capability explicitly).

- Test coverage at the loader layer must hit: every whitelist capability callable when declared, every capability `undefined` when not declared (TS narrowing + runtime check), every kind-vs-capability mismatch refused at load, and the auth-field-stripping projection on `taskReader.getTask` / `habitatReader.getHabitat`.

## Risk

- **Whitelist too small for real-world detectors in v0.22.0.** The 5-capability menu assumes detectors only need pulse/comment/task context. A detector that correlates with code evidence (e.g. "long commit messages correlate with surprise") would need `codeEvidenceReader`, not on the menu. Mitigation: the reference detectors shipped in v0.22 (regex frustration, short-submission, rejection-loop — per the seed) all fit in the 5-capability menu. New capabilities land in v0.22.1+ deepening or v0.23 triage as concrete detector requirements emerge, not speculatively.

- **Plugin author friction.** A plugin author hits "I need this method but it's not on the whitelist." This is the boundary working as intended — they file an issue proposing a new capability, we vet it, add it in a future release. The friction is the price of the safety boundary; README documents this explicitly.

- **Capability method surface drift.** If `pulseReader.listByHabitatSince` changes signature in v0.23 (e.g. adds a filter arg), plugins compiled against v0.22 break. Mitigation: capability method signatures are versioned with the manifest `version` field; the loader checks compatibility and refuses to load plugins whose manifest targets an incompatible capability version. Concrete mechanic deferred to PRD.

- **Plugin authors writing their own raw-SQL via importing `@orcy/api/db` directly.** TS-wise, plugins import from `@orcy/api/src/plugins/types.ts` (the `PluginModule` + handler interfaces) and `@orcy/shared/types/plugin.ts` (the manifest). They cannot cleanly import `@orcy/api/src/db` because there's no public re-export; in-process same-event-loop means they're physically able to `import { getDb } from '../../db'` but this is the operator-trust boundary (README "audit before installing"). We don't ship ESM import enforcement; the whitelist is the contractual boundary, not a runtime sandbox.