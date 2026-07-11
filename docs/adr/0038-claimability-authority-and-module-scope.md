# Claimability authority at the mutation; deep module scope is task-intrinsic

Status: accepted · 2026-07-11

## Context

The codebase has several "is this task claimable?" surfaces: the read path (`getAvailableTasksForAgent`), the claim mutation (`claimTask` / `claimTaskByRemoteParticipant`), batch assign, suggestions, and daemon nudges. ADR-0001 established derived claim constraints checked at claim time, and the v0.29.3–v0.29.6 work closed the bypass so the mutation enforces all four task-intrinsic guards. What remained unstated is *where the authority lives* and *what the consolidating claimability module owns* — leaving the door open to re-introducing a read-path-authority assumption or bloating the module with agent-relative concerns.

## Decision

1. **Claimable is authoritative at the claim mutation.** Read, suggestion, and nudge paths are *advisory projections* — they surface tasks that look claimable, but they do not govern claimability. Two surfaces agreeing on claimable is a goal to minimize, not a guarantee the read path enforces.
2. **The claimability module owns only the four task-intrinsic guards** — Task dependencies, Workflow Gates, Release Gate, and Mission dependencies — plus their ordered reason vocabulary (`dependencies_unmet → mission_dependencies_unmet → release_gate_unmet → workflow_gates_unmet`), first-error-only. `checkClaimability(taskId)` is that module.
3. **Agent-relative fitness (domain, required-capabilities) is resolved at the transport seam**, not by the module, because the local-agent model (`domain` + `capabilities`) and the remote-participant model (grant scopes + Host-Approved Capability) differ.

## Rationale

- The ADR-0032 lapse was precisely a read/mutation authority disagreement: the read path excluded release-gated tasks while the mutation did not. Making the mutation authoritative is the premise of the fix, not a new invention — this ADR records it so the next change does not re-introduce a read-path-authority assumption.
- The four task-intrinsic guards are *universal* — the same answer for every claimer, local or remote. Agent-relative checks depend on *who* is claiming, and the models differ by transport (CONTEXT.md defines Host-Approved Capability as a remote mechanism). Forcing agent-relatives into one predicate leaks transport specifics into a core that should be transport-agnostic.
- First-error-only matches the current contract (callers, the MCP reason union, and route error mapping all expect a single reason). The ordered blocker-set is a clean, additive future enhancement, not a prerequisite.

## Alternatives considered

- **Read path as co-equal authority.** The deep module would have to serve both a set-based SQL form and a per-task form with no derivation gap, forcing a declarative-spec dual-render. Heavier engineering; rejected because the mutation is the natural authority and the read path is performance-shaped (set-based).
- **Module owns agent fitness too** (`checkClaimability(taskId, agentCtx)`). True one-stop claimability, but the module would have to understand both the local agent model and the remote participant model, leaking transport specifics into the core. Rejected.
- **Full ordered blocker-set instead of first-error.** Richer diagnostics, but a contract change that mixes error-API redesign with authority consolidation. Deferred (additive, low-risk to add later since the order is already deterministic).

## Consequences

- The deep module *is* `checkClaimability`; `claimTask` and `claimTaskByRemoteParticipant` should call it rather than duplicating the four predicate calls inline (the duplication is the drift surface that caused the original lapse).
- The advisory read path is *allowed* to drift from the mutation, but drift should be minimized: the read-path Workflow Gate projection gap should be closed so it projects all four constraints consistently, even though it remains advisory.
- CONTEXT.md gains **Claimable** (authoritative, task-intrinsic) and **Eligible** (agent-relative, seam-resolved) as distinct terms; "available" is informal, read-path-only shorthand.
- Agent-relative consolidation (unifying how local vs remote resolve domain/capability fitness) is a separate, seam-level concern, explicitly out of scope for this module.
- Occupancy (`already_claimed`) and `not_found` are mutation-state, not blocking constraints, and remain outside the module's vocabulary.
