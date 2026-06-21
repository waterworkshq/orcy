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

## Self-Reporting (Experience Signals)

Experience signals (signalType='experience') let you report your own internal state during
autonomous work. They are skill inputs — they shape habitat knowledge and failure context —
not performance reviews. The system auto-tags them with metadata.implicit=true.

### When to post

Post an experience signal when something significant happens that future agents (or recovery
agents picking up after a failure) would benefit from knowing about:

- Mid-task: hit a wall after several retries, surprised by API or data behavior, requirements
  are ambiguous, you had to backtrack and restart, you got sidetracked by something unrelated.
- At completion: post one 'smooth' (or final category) summary signal when the task is submitted,
  describing the overall shape of the work.

### The seven categories

Pick the single best fit. Each signal takes one category via the 'experience' param.

| Category | Use for | Example subject |
|----------|---------|-----------------|
| stuck | Hit a wall, no progress after real effort | "Hit unexpected API rate limit after 5 retries, switched approach" |
| confused | Requirements or environment don't add up | "Requirements mention 'deploy' but no deploy environment is configured" |
| backtrack | Started down a path that turned out wrong | "Started with REST approach, discovered GraphQL is required, restarted" |
| surprised | Reality contradicted expectations (but you recovered) | "Test suite passed locally but failed in CI due to env variable" |
| ambiguous | Task is underspecified, you made an interpretation call | "Task says 'improve performance' but no metric specified" |
| sidetracked | Found something unrelated, refocused on the task | "Found unrelated bug while investigating; recorded it as separate task and refocused" |
| smooth | Work proceeded cleanly, nothing notable went wrong | "Feature implemented in one pass, all tests green" |

### How to post

orcy_pulse({
  action: "post",
  missionId: "mission-uuid",
  taskId: "task-uuid",
  signalType: "experience",
  experience: "stuck",
  subject: "Hit unexpected API rate limit after 5 retries, switched approach"
})

The tool auto-stamps metadata.implicit=true, metadata.experience=<category>, and
metadata.timing ("mid_task" while the task is in_progress, "completion" once submitted).
You do not need to pass these metadata fields yourself.

### What NOT to post as experience signals

- Lifecycle events that auto-emit (claimed, submitted, completed, etc.) — already covered.
- Hard blocks requiring intervention — use signalType='blocker' instead (it auto-creates a
  clearance task). 'stuck' is for "I worked through it" or "I noticed I was stuck";
  'blocker' is for "I cannot proceed without help."
- Routine progress updates ("halfway done", "tests running") — no signal value.
- Quality judgments about other agents — experience signals are self-reports only.

### Etiquette

- One signal per distinct experience. Don't post five 'stuck' signals for the same wall.
- Always link via taskId so signals attach to the right context.
- If an experience evolves (e.g. 'stuck' → 'backtrack'), update the existing signal's body
  rather than posting duplicates.
- Quality over quantity. A handful of high-signal experience posts per task beats a firehose.
`;

/** MCP `Tool` registration for `orcy_pulse_instructions`; on call, returns the rendered Pulse skill guide. */
export const PULSE_SKILL_TOOL: Tool = {
  name: "orcy_pulse_instructions",
  description:
    "Teaches the Pulse mission signal protocol: when to post signals, how to interpret the pulse digest, and signal etiquette for multi-agent missions. " +
    "Use when you see pulse data in mission get-context responses, when you need to share a finding or blocker with mission partners, " +
    "when you encounter a BLOCKER signal and need to understand the clearance-task flow, " +
    "when you want to learn the difference between auto-signals and intentional signals, " +
    "or when you want to self-report your internal state (stuck, confused, surprised, etc.) via experience signals.",
  inputSchema: { type: "object", properties: {} },
};

/** Returns the rendered Pulse skill guide text for the `orcy_pulse_instructions` MCP tool. */
export function orcyPulseInstructions(): string {
  return PULSE_SKILL_TEXT;
}
