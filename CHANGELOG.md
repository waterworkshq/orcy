# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.29.6 — 2026-07-11

### Bug Fixes

#### make batch assign admin-only and claimability-respecting with coherent claimed state ([`2513a22`](https://github.com/waterworkshq/orcy/commit/2513a22beb26bb7152358d3439719b068cf2d50d))

1. Batch assign (POST /habitats/:id/tasks/batch operation=assign) was the
2. second pre-existing claimability bypass: agent-accessible via
3. agentOrHumanAuth, with no claimability checks, producing stranded
4. pending+assignedAgentId state.

6. Three changes close the bypass:

8. 1. checkClaimability helper (taskQueries.ts) — thin shared predicate
9. aggregating deps/mission-deps/release-gate/workflow-gates. Seed of
10. future deep claimability module (Arch Review Candidate 1).

12. 2. Route handler (batch.ts) — assign operation gated to admin-only;
13. agents get 403 pointing to POST /tasks/:id/claim. Priority and
14. delete retain agent access.

16. 3. batchOperateTasks assign branch (task-batch.ts) — replaced
17. updateTask({ assignedAgentId }) with checkClaimability pre-check +
18. claimTask from taskStateMachine. Produces coherent claimed state
19. atomically. Per-task isolation preserved.



## 0.29.5 — 2026-07-10

### Bug Fixes

#### narrow updateTaskSchema to metadata-only, closing PATCH lifecycle bypass ([`05da846`](https://github.com/waterworkshq/orcy/commit/05da846c744a271be270ba3a144d5ff68281b14d))



## 0.29.4 — 2026-07-10

### Bug Fixes

#### add release-gate and mission-dependency guards to canonical claim path ([`708f041`](https://github.com/waterworkshq/orcy/commit/708f041b73c986f5bfa87a21be26ddc80a737d40))


#### widen claim failure-reason union to include all derived-gate reasons ([`964f11f`](https://github.com/waterworkshq/orcy/commit/964f11f8dd1bc38a79df531e881dd7a0db123cb2))
