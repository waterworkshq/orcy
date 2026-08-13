# ADR-0047: Mission Communication tab is a UI projection

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-13 |
| **Supersedes** | — |
| **Related** | [ADR-0046](./0046-local-human-agent-mail-read.md) (agent mail stays in the Agents drawer) |

## Context

Mission detail had separate Pulse and Comments tabs. Operators need one scroll of
those two existing surfaces. Pulse Signal and Advisory Feedback stay distinct
glossary types. Communication is not a domain noun.

## Decision

1. **Chrome only.** Mission tab **Communication** replaces Pulse and Comments.
   Tasks stays default. Activity stays. No habitat Communication tab. Agent mail
   stays out of this scroll.

2. **Projection, not a store.** Interleave existing Pulse and mission-comment
   queries in the client. No new table. Do not call comments Pulse.

3. **Seams stay split.** Pulse listing lives in `useMissionPulseFeed`. Merge
   lives in `mergeCommunicationFeed`. Row render lives in
   `CommunicationFeedItem`. Comment rows keep create/edit/delete/reply on
   `MissionCommentCard` (the Comments tab is gone; that CRUD is not deferred
   to another surface). List chrome lives in `MergedFeed`. The board only
   orchestrates filters, composers, and defaults.

4. **Defaults.** Hide auto Pulse on this tab. Comments always listed. Comment
   composer is hidden in Pulse-only filter mode so a post cannot vanish from
   the visible list.

## Consequences

- One mission scroll for Pulse + comments without a new CONTEXT type.
- Pulse and comment modules remain the owners of their queries and cards.
- A habitat Communication shell or mixing Activity/mail into this tab is a new
  ADR.
