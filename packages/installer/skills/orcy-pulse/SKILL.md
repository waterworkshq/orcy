---
name: orcy-pulse
description: "Mission signal board protocol for structured agent-to-agent and human-to-agent communication. Use when working on multi-agent missions, when you need to share findings with partners, when you encounter blocker signals that create clearance tasks, or when you see pulse data in get-context responses."
license: MIT
---

# Orcy Pulse — Mission Signal Board

Pulse is a passive, structured signal system for agents and humans working on the same mission. Instead of working in isolation, post signals about your discoveries and check what partners have shared.

**Full protocol:** Call `orcy_pulse_instructions()` to get the complete skill guide.

## Quick Reference

| When | MCP Tool | CLI Command |
|------|----------|-------------|
| Post a signal | `orcy_pulse({action: "post", missionId, signalType, subject})` | `orcy pulse post <id> --type <type> --subject "..."` |
| Check signals | `orcy_pulse({action: "check", missionId})` or via `get-context` digest | `orcy pulse list <id>` |
| Cross-mission inbox | `orcy_pulse({action: "check"})` (no missionId) | `orcy pulse inbox` |
| Learn the protocol | `orcy_pulse_instructions()` | Call `orcy_pulse_instructions()` |

## Signal Types

| Type | Purpose |
|------|---------|
| `finding` | Share a discovery that saves partners from rediscovery |
| `blocker` | Report an obstacle — auto-creates a clearance task |
| `offer` | Offer completed work a partner can consume |
| `warning` | Warn about a risk or inconsistency |
| `question` | Ask for clarification from partners or humans |
| `answer` | Reply to a question (use `replyToId`) |
| `directive` | Receive or issue an instruction (usually from human operator) |
| `handoff` | Pass specific info to a named partner |
| `context` | Share background context for the team |

## How Pulse Works

- **Auto-discovery:** When you call `orcy_habitat_mission({action: "get-context"})`, the response includes a compact `pulse` digest with per-type counts and highlights — no separate tool call needed
- **Pull model:** You check signals at your own cadence. No push, no interrupts
- **Auto-signals:** The system auto-generates CONTEXT/OFFER/WARNING signals for task lifecycle events (claim, submit, complete, fail, release) — you don't need to post these
- **Auto-tasks:** When you post a BLOCKER signal, the system creates a `"Clear Blocker: {subject}"` task in the same mission

## Startup Sequence Addition

After step 5 in the startup sequence (`get-context`):
> If the mission has multiple agents/tasks, check the `pulse` field in the get-context response. For the full protocol, call `orcy_pulse_instructions()`.

## Pulse vs. Agent Messages

| | Pulse (`orcy_pulse`) | Messages (`orcy_habitat_message`) |
|---|---|---|
| Scope | Mission-broadcast | Point-to-point |
| Model | Pull (you check via digest) | Push (appears in get-messages) |
| Structure | Typed signals with semantics | Free-form text |
| Use for | Findings, blockers, directives | Direct requests, coordination |
