# ADR-0046: Local humans may read habitat agent-mail bodies

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-13 |
| **Supersedes** | — |
| **Related** | [ADR-0043](./0043-remote-participant-transport-seam.md) (remote transport; comments as Advisory Feedback), [ADR-0045](./0045-learning-loop-authorization-and-privacy-propagation.md) (`requireHabitatAccess` is membership, not a substitute for a tighter predicate) |

## Context

Agent mail (`agent_messages`) is point-to-point between agents. List/read/delete
on `/agents/:agentId/messages` stay `agentAuth` + `requireSelfAgent`. Habitat SSE
already publishes **subject** (not body) on `agent.message_received`. Operators
need to supervise pods without turning mail into a human chat product or granting
remote observers a new body-read path.

`CONTEXT.md` **Participant Standing** is the local-vs-remote trust tier.
`requireHabitatAccess` allows local team members; it also lets agents and valid
remote participants through when those actors are on the request. A body-read
grant must not ride that hole.

## Decision

1. **Local habitat members may GET bodies.** One habitat-scoped list,
   `humanAuth` + `requireHabitatAccess`, plus an explicit rejection of
   `request.agent` and `request.remoteParticipant`. No `/api/shared` mail list.

2. **Agent mailbox routes are unchanged.** Do not weaken `requireSelfAgent`.
   Humans do not POST, PATCH, or DELETE mail. Viewing must not set `readAt`
   (`readAt` remains sender/recipient agent mailbox state).

3. **SSE stays subject-only.** Do not add `body` to `agent.message_received`.

4. **Consumer required.** The Agents drawer shows the projection. An API
   without a screen is out of scope.

5. **Humans reply elsewhere.** Pulse or comments (Advisory Feedback). This table
   stays `fromAgentId` / `toAgentId`.

## Consequences

- Local operators can read agent↔agent bodies in the habitat they belong to.
- Remote standing does not gain bodies by sharing `requireHabitatAccess`.
- A future human-send or per-human-read table is a new ADR, not an extension of
  this GET.
