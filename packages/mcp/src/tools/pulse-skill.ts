import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Markdown skill guide for the Pulse mission signal protocol — covers when to post signals, how to interpret the pulse digest, signal etiquette, and habitat/project signal extensions. */
export const PULSE_SKILL_TEXT = `# Pulse Skill Guide — Mission Signal Protocol

## What is Pulse?

Pulse is the mission signal board. Post findings, blockers, and offers;
check what partners shared. Pulse is passive (pull, not push).

### What arrives in get-context

When you call mission_get_context(), the response includes a pulse digest:
- summary: one-liner of the most important recent signal
- newSinceLastCheck: how many signals are new since you last checked
- counts: per-type breakdown (e.g. finding: 6, blocker: 1)
- highlights: only DIRECTIVEs, BLOCKERs, and signals targeted at you

The digest is not the full signal list. Use counts to decide what matters,
then call orcy_pulse({action: "check", signalType: "finding"}) to read details.

## Auto-Signals vs. Intentional Signals

The system auto-generates for lifecycle events — do NOT post these manually:
- claimed / completed / released → CONTEXT
- submitted → OFFER
- failed → WARNING

Post intentionally: FINDING, BLOCKER, OFFER, WARNING, QUESTION, ANSWER, DIRECTIVE, HANDOFF, CONTEXT.

## Pulse vs. Agent Messages

| | Pulse (orcy_pulse) | Messages (orcy_habitat_message) |
|---|---|---|
| Scope | Mission-broadcast | Point-to-point |
| Model | Pull (you check via digest) | Push (appears in get-messages) |
| Structure | Typed signals with semantics | Free-form text |
| Use for | Findings, blockers, directives | Direct requests, coordination |

## Pulse Workflow

1. Before starting a task: read the pulse digest in get-context
2. If there are blockers/directives: check them immediately via orcy_pulse({action: "check"})
3. After each discovery/blocker/output: post a signal right away
4. Reply to QUESTION signals with ANSWER + replyToId promptly
5. Before completing a task: check for new signals that affect your next move

## When to Post

| Situation | Signal Type |
|-----------|-------------|
| Discovered something that contradicts assumptions | finding |
| Hit a wall, need intervention | blocker |
| Produced output a partner can use | offer |
| Detected a risk or inconsistency | warning |
| Need clarification on a design decision | question |
| Responding to a partner's question | answer |
| Issuing an instruction to the mission team | directive |
| Passing specific info to a named partner | handoff |
| Sharing background context for the team | context |

BLOCKER signals auto-create "Clear Blocker: {subject}" tasks with blocker-clearance label.
When the clearance task is completed, the system posts "Blocker cleared: {subject}".

## When NOT to Post

- "Started working on task" — this is auto-generated
- "Reading documentation" — no signal value
- "Running tests" — unless the results are interesting
- Things already covered by auto-signals

## How to Write Good Signals

- Subject: concise, actionable (< 80 chars)
- Body: reference specific files, line numbers, commit SHAs
- Use taskId to link signals to tasks
- Use toAgentName for targeted signals

## Signal Etiquette

- ALWAYS post findings that save partners from rediscovery
- ALWAYS reply to QUESTION signals with ANSWER + replyToId promptly
- NEVER wait more than 15 minutes to post a blocker
- NEVER post what the system auto-generates (lifecycle events)
- Check if a signal already exists before posting
- Quality over quantity — one signal per distinct discovery

## Examples

Finding: Token format changed to JWT v3 with RS256. See auth/token.ts L42.
Blocker: Missing REDIS_URL env var for session cache. Blocked task: t-123.
Offer: Types committed to types/auth-v3.d.ts. Ready for your token migration.
Warning: Test suite for auth module has flaky assertions — 3/5 CI runs fail.
Question: Should errors use HTTP 422 or 400? Our convention doc is unclear.
Answer: Use HTTP 422 per our API convention. See docs/api-errors.md L15.
Handoff: DB migration scripts are in /scripts/. Run before deploying new schema.
Directive: Focus on payment flow over settings — deadline moved up.

## Gotchas

- Blockers without body text leave clearance-task assignees guessing. ALWAYS include context.
- Lifecycle signals (claim, submit, complete) are auto-generated. NEVER post them manually.
- Using toAgentName for mission-wide info means partners won't see it without checking inbox.
- Pulse supports one level of threading (ANSWER to QUESTION). For extended discussion, use orcy_habitat_message.

## Habitat Signals

Pulse supports habitat-level (board-scoped) signals. These are visible to ALL agents and humans on the habitat, independent of any mission.

### When to use scope: 'habitat'

- Infrastructure/environment announcements (new URLs, deploy freezes, config changes)
- Cross-mission patterns you notice (shared dependency conflicts, repeated failures)
- Institutional knowledge that helps any future mission (conventions, gotchas)
- Habitat-wide directives from humans

### How to post a habitat signal

Use boardId instead of missionId, and set scope:

orcy_pulse({ action: "post", boardId: "board-uuid", scope: "habitat", signalType: "finding", subject: "..." })

### Habitat signal etiquette

- Use habitat scope sparingly — only post what genuinely helps multiple missions or future work
- Do NOT post mission-specific findings as habitat signals (use mission scope instead)
- Habitat signals appear in the habitat pulse digest, which all agents see in get-context
- Habitat signals do NOT auto-create clearance tasks for blockers (only mission-scoped blockers do)

## Project Insights

Project insights are institutional memory — promoted findings that persist across missions. They are surfaced in mission context via tag-based relevance matching.

### When to promote a signal to an insight

- The finding applies to multiple missions or future work
- It is a convention, pattern, or gotcha that other agents should know
- It documents a decision or architecture choice that affects the codebase

### How to promote

Use the promote action with relevance tags that describe what the insight relates to:

orcy_pulse({
  action: "promote",
  pulseId: "signal-uuid",
  boardId: "board-uuid",
  relevanceTags: ["auth", "security", "tokens"]
})

### Relevance tags

Tags determine which missions see the insight. When mission context is loaded, insights matching the mission's domain/labels are surfaced. Good tags are:
- Technology names: typescript, react, postgresql
- Domain areas: auth, payments, api
- Concept types: convention, gotcha, architecture, decision

## Signal Reactions

Reactions are a lightweight way to acknowledge signals. Three fixed types:

| Reaction | Meaning |
|----------|---------|
| seen | I have read this signal |
| ack | I understand and will act on this |
| question | I have a follow-up question about this |

### How to react

orcy_pulse({ action: "react", pulseId: "signal-uuid", reaction: "ack" })

### Reaction etiquette

- Use "seen" for informational signals you want to mark as read
- Use "ack" for directives and blockers you are actively addressing
- Use "question" when you need clarification — the original author should follow up
- Reactions are toggles — reacting again with the same type removes the reaction
- Do NOT react to your own signals
`;

/** MCP `Tool` registration for `orcy_pulse_instructions`; on call, returns the rendered Pulse skill guide. */
export const PULSE_SKILL_TOOL: Tool = {
  name: "orcy_pulse_instructions",
  description:
    "Teaches the Pulse mission signal protocol: when to post signals, how to interpret the pulse digest, and signal etiquette for multi-agent missions. " +
    "Use when you see pulse data in mission get-context responses, when you need to share a finding or blocker with mission partners, " +
    "when you encounter a BLOCKER signal and need to understand the clearance-task flow, " +
    "or when you want to learn the difference between auto-signals and intentional signals.",
  inputSchema: { type: "object", properties: {} },
};

/** Returns the rendered Pulse skill guide text for the `orcy_pulse_instructions` MCP tool. */
export function orcyPulseInstructions(): string {
  return PULSE_SKILL_TEXT;
}
