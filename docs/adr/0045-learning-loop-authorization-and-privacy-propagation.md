# ADR-0045: Learning Loop Authorization and Privacy Propagation

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-12 |
| **Supersedes** | — |
| **Related** | [ADR-0044](./0044-learning-loop-ledger-citations-and-lineage.md) (ledger, citations, lineage) |

## Context

The Learning Loop converts Orcy history into immutable, cited findings that agents
may read through a bounded task-bound query. The review and authorization API
(ticket 5) exposes human decisions and agent accepted-finding reads, making the
authorization boundary the most security-critical surface in the feature.

The adversarial review (finding 1) established that `requireHabitatAccess` is not
a Learning Loop isolation boundary — it accepts any authenticated local agent
without relating the agent to the requested Habitat. A safe agent read requires
a stricter contract: an active-Task predicate bound into the finding query itself.

## Decision

### 1. Derived-knowledge-never-wider-than-sources invariant

Every accepted finding inherits the **most restrictive** visibility class among
its cited observations and the extractor policy. Captured visibility is audit
evidence, not a permanent grant; current authorization is rechecked on every read
and promotion attempt.

| Class | Readers |
|---|---|
| `habitat_member` | Local humans with `requireHabitatAccess`; local agents only through the active-Task predicate. |
| `human_reviewer` | Local humans with Habitat access; never agent context. |
| `aggregate_only` | Only the aggregate observation may be displayed; no drill-down to contributing records. |

### 2. Actor-bound active-Task predicate (NOT a middleware precheck)

Agent `list_accepted` and `get` execute ONE joined SQL statement returning an
accepted finding only when ALL hold:

1. The supplied `taskId` exists, `task.assigned_agent_id === agent`, and status
   is `claimed | in_progress | submitted`.
2. The task's Mission belongs to the requested Habitat and `finding.habitat_id`
   matches.
3. The finding is readable: `accepted`, not `stale`/`withdrawn`, visibility
   allows agent use (`habitat_member` only).
4. ≥1 server-derived scope ref matches exactly:
   - `task:<taskId>`; or
   - `mission:<task.missionId>`; or
   - `domain:<task.requiredDomain>` when `requiredDomain` is non-null.

Because all four conditions participate in the final SELECT, reassignment or
terminalization before the query executes removes access — there is no separate
precheck whose result can go stale.

**Why not middleware:** A middleware precheck followed by an unrelated finding
read creates a TOCTOU race: the task could be reassigned or terminalized between
the precheck and the read. The repository predicate eliminates this window
because the task's assignment, status, and scope match are evaluated in the same
statement that returns the finding.

### 3. No Habitat-wide fallback

A finding with no server-derived scope refs is **human-only**. Client-supplied
filters (type, domain, age, limit, maxChars) may only **narrow** the authorized
result. Labels, search terms, finding prose, and extractor payloads cannot
broaden the result. Default limit 10, hard limit 25.

### 4. Collapsed denial

Denials collapse not-found/forbidden into one response with no count or existence
oracle. A caller cannot distinguish "finding does not exist," "finding exists but
agent lacks scope," "wrong Habitat," or "stale/withdrawn" — all return the same
404 with no detail.

### 5. Citation degradation fail-closed

| Condition | Agent read | Promotion |
|---|---|---|
| Available + unchanged | Show citation summary. | Allowed if other gates pass. |
| Dangling | Hide source details. | **Block.** |
| Changed digest | Mark stale. | **Block.** |
| Unauthorized | Hide finding if ceiling disallows. | **Block.** |
| Aggregate-only | Bands/caveats only; no drill-down. | Human may accept; destination policy may block. |

Privacy or authorization invalidation fails closed: withdraw from agent reads
immediately and queue human review. Review and promotion history remains.

### 6. CAS review concurrency

Every human decision uses `expectedDecisionVersion` compare-and-set. Two
concurrent decisions with the same expected version yield one success and one
409. Accept and reject require a reason. Review history is append-only.

### 7. Human-only decisions and promotion

Acceptance, rejection, revision requests, withdrawal, and promotion are
**human-only** (`humanAuth + requireHabitatAccess`). Agents can read accepted
`habitat_member` findings through the active-Task predicate but cannot decide,
promote, or alter review state.

### 8. Audit/SSE privacy

Audit events and SSE payloads carry finding IDs, finding type, confidence, and
bounded decision state — **never** raw source bodies, Experience contributor
data, exact timestamps, or citation drill-down links. The SSE registry parity
test enforces that every declared event type has a registered handler.

## Consequences

- Agent reads require a caller-supplied `taskId` — no Habitat-wide agent access.
- The repository predicate is the sole authorization boundary for agent reads;
  there is no redundant middleware check to maintain or race.
- Ticket 8's MCP dispatch reuses the same repository methods — the MCP handler
  passes `(agentId, taskId, habitatId, filters)` and the predicate enforces
  authorization identically.
- Adding new agent-visible finding types requires persisting server-derived scope
  refs at extraction time; unscoped findings remain human-only.
- The collapsed denial means monitoring tools cannot distinguish authorization
  failures from missing findings — this is intentional.
