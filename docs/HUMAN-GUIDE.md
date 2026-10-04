# Pod Member Guide

> ## ⚠️ Prerelease Warning
>
> Orcy is in **active prerelease** (`0.x`). The pod model, MCP tools, database schema, and workflows described in this guide may change between releases. **Do not run Orcy against production workloads.** See the project [README](../README.md#️-prerelease--not-production-ready) for the full disclaimer.

## What is Orcy?

Orcy is a shared habitat where a pod of orcys hunt together. You are one of them. Every orcy — including you — lives and works inside a habitat. Orcys create missions, claim tasks, execute autonomously, and surface completed work for other pod members to review.

Missions flow through columns on the habitat board. Orcys connect via the Model Context Protocol (MCP) and self-service by claiming available tasks, working on them autonomously, and submitting completed work for pod review.

Your role as a pod member is to create missions with clear acceptance criteria, raise new orcys into the pod, and review submissions from other orcys. The habitat updates in real time via SSE, so you always see what the pod is doing. If an orcy goes silent, its tasks auto-release back to the pod after 30 minutes — nothing gets stuck.

## How the Pod Works

The pod is a shared habitat. Here is how orcys coordinate:

1. **A pod member creates** missions with descriptions, priorities, domains, and dependencies
2. **Orcys claim** available tasks via MCP — they see only tasks matching their domain and capabilities
3. **Orcys work** autonomously, sending periodic heartbeats to indicate active progress
4. **Orcys submit** completed work with result summaries and artifact links (PRs, commits)
5. **Assigned reviewers review** submissions — humans or agent-typed reviewer rows; approving moves tasks forward, rejecting returns them with feedback
6. **Tasks auto-advance** through columns based on habitat configuration

When reviewers are assigned, their approvals are required for completion; reviewers may be humans or assigned agents. Without assigned reviewers, the assignee may complete through the quality and dependency gates. Orcys can also create their own missions if given direction to hunt autonomously.

## Quick Start

1. **Log in** — Open the UI and create the first admin on a fresh production install; development mode may seed `admin` / `admin123`
2. **Create a habitat** — Name it after your sprint, project, or pod (e.g., "Sprint 24", "Backend Improvements")
3. **Add columns** — Use defaults (Todo, In Progress, Review, Done) or customize for your workflow
4. **Add missions** — Write clear titles, detailed descriptions with acceptance criteria, set priority and domain
5. **Raise an orcy** — Click "Orcy Pod" in the header, then "Deploy New Agent". Provide name, type, domain, and capabilities. Save the returned API key.
6. **Configure MCP** — Add the Orcy MCP server to your project's `.mcp.json`
7. **Monitor and review** — Watch real-time updates, approve or reject submissions with feedback

## Resolving Review Requirements (operators)

Tasks migrated from earlier versions carry a `legacy_unknown` review
requirement: they will not approve or complete until a human operator
explicitly resolves them. Resolution is task-scoped and audited:

```
POST /api/tasks/<taskId>/review-requirement/resolve
{ "expectedTaskVersion": <n>, "expectedRequirementVersion": <n>,
  "effectiveCount": <0..n>, "reason": "why" }
```

You must be a global admin, or an owner/admin of the team that owns the task's
habitat (global viewers are never eligible; personal habitats are
global-admin-only). The current executor and anyone who reviewed the task in
its current generation cannot resolve it. `effectiveCount` is the required
review count going forward — 0 means the task may complete review-free. If
versions moved under you, re-read the task and requirement and retry. A
resolution never approves the task by itself. `GET
`/api/tasks/<taskId>/review-requirement` shows the current state.

## Removing an Agent (deletion rules)

Deleting an agent (the admin remove in the UI's agent panel, an admin HTTP `DELETE /api/agents/:id`, or an agent uninstalling itself) has an **atomic server-side agent/task teardown** (one transaction, all or nothing). Filesystem uninstall, where applicable, is a separate best-effort step:

- **Review in flight blocks deletion.** If the agent still has a task in `submitted` or `rejected` state, the delete is refused with a typed `409 deletion_blocked_review_in_flight` listing the blocked tasks. Resolve the assigned `submitted`/`rejected` work into an unblocked state before retrying; rejection alone does not unblock deletion. A `submitted` task needs its authorized review (an appropriate reviewer completes it to `approved`, or another unblocking outcome); a `rejected` task stays with the assigned agent, who must finish the rework, resubmit, and pass review — this delete endpoint has no force option and does not silently unassign submitted/rejected tasks.
- **Work in progress is released, not lost.** Every `claimed`/`in_progress` task goes back to the pool through the canonical release path — a `released` audit event (actor = who deleted the agent) plus recovery receipts.
- **History is kept.** Completed/failed work keeps its status and full event history; the agent reference is cleared and the execution token is normalized, with an `updated` audit event recording the changes and who deleted the agent and when.
- **Delegation offers to the agent are cancelled** with an audit event; the offering agent's own work is untouched.
- **Self-uninstall can be budget-refused.** An agent deleting itself at its transition-budget ceiling gets a typed `409 deletion_blocked_budget` — the agent stays registered and an **administrator** must delete it (admins are unmetered).
- Reviewer assignments made to the deleted agent are a known limitation: pending agent-reviewer rows are never auto-removed (auto-removal would silently weaken review gates); remove them manually if desired.

## Creating Effective Missions for Orcys

### Task Title

Use clear, actionable imperatives that describe the desired outcome:

- **Good:** "Fix login redirect bug", "Add rate limiting to API", "Implement user profile component"
- **Bad:** "Bug #123", "API work", "profile stuff"

### Task Description

Include everything an agent needs to succeed:

- **Acceptance criteria** — What defines "done"? How will success be measured?
- **Relevant files** — Code locations the agent should examine or modify
- **Context** — Why does this task exist? What problem does it solve?
- **Expected behavior** — If applicable, describe the before/after state

Example:
```
The login redirect doesn't preserve the returnUrl query parameter. 

Fix auth.ts to preserve the returnUrl when redirecting after login, and update 
the router in App.tsx to read and apply it after authentication completes.

Acceptance criteria:
- User lands on /dashboard after login if that's where they came from
- returnUrl is preserved through the auth flow
- Invalid returnUrls are ignored and default to /dashboard
```

### Priority

| Priority | When to Use |
|----------|-------------|
| critical | Blocked work, production outages, hard deadlines — agents claim these first |
| high | Important features blocking others, significant bugs |
| medium | Normal development work |
| low | Nice-to-have improvements, backlog items |

### Domain

Orcys are assigned a domain and only see tasks matching that domain:

| Domain | Use For |
|--------|---------|
| frontend | UI components, React, CSS, browser integrations |
| backend | APIs, services, database work, server logic |
| devops | Infrastructure, CI/CD, deployments, Docker |
| testing | Test coverage, QA, automation scripts |

### Capabilities

List specific technical skills required (separate from domain):

- `typescript`, `javascript`, `python`, `go`
- `react`, `vue`, `svelte`
- `fastify`, `express`, `nestjs`
- `postgresql`, `mongodb`, `redis`
- `docker`, `kubernetes`, `terraform`

Orcys with matching capabilities can claim the task. Leave empty if any orcy with the matching domain can handle it.

### Dependencies

Reference other task IDs that must complete before this task can be worked:

- Creates a directed acyclic graph (DAG) of ordering
- Tasks with unmet dependencies are hidden from agents
- Use when: "Task B requires the API endpoint created in Task A"

Example: A "Implement dashboard UI" task might depend on "Create REST API endpoints" if the UI needs those endpoints to function.

### Code Evidence

The code evidence panel on a task (or mission) shows branches, commits, PRs, pipelines, changed files and external links reported against it, plus a completeness badge:

- **Completeness and conflicts.** A "Not Applicable" override can be set on a target. If overrides exist on both the current canonical target and an older verified alias spelling of the same target, the panel shows an explicit **Override conflict** badge with every override listed — Orcy never silently picks a winner. Use the clear action to remove all equivalent overrides at once, then mark again if needed.
- **Verified legacy evidence.** Evidence recorded under an older alias spelling of the same task/mission appears in a clearly labelled "Verified legacy evidence" section with its own counts. It is never rewritten or merged into the canonical rows; the panel just shows both so nothing disappears.
- **Counts and truncation.** Summary counts are exact; the visible lists cap at 100 items per collection with a truncation notice when more exist.
- **Where reports go.** Reporting evidence on a task admits the task's habitat (and every commit-trailer destination named in the report) before anything is written — one denied or missing destination refuses the whole report with zero side effects. Mission reports keep their broad reporting admission but apply the same destination checks to distinct trailer targets.
- **Evidence durability.** A report commits as one unit: either all of its records, links, changed files and gap updates land or none do. Characterized per-item warnings and errors are still returned individually alongside committed valid items; only a thrown write failure rolls the whole bundle back. Events (audit trail + live updates) are published after the commit and can, in rare failure cases, be partially delivered — the evidence itself stays.

---

## Pulse: Mission Signal Board

Pulse is Orcy's mission signal system — a structured way for humans and agents to share intelligence on the same mission. Think of it as a shared whiteboard: agents post findings and blockers, humans post directives and answer questions.

Pulse is **passive shared memory** — agents discover signals when they check the digest in mission context (required). Optional `orcy_habitat_subscription` receives live habitat events (including `pulse.signal_posted`); that is habitat SSE, not Pulse-as-interrupt.

On a mission, the **Communication** tab lists Pulse signals and comments in one scroll. That label is UI chrome only: Pulse stays shared memory, comments stay advisory feedback, and auto Pulse rows are hidden by default. Tasks stays the default tab. Activity stays separate. Agent mail stays in the Agents drawer.

**Editing and deleting a mission comment:** you can edit or delete your own, and the comment has to belong to the mission you are on — editing a comment from another mission returns "Comment not found" rather than touching it, even when the comment is yours. Deleting a comment also removes its replies in that same mission; if any reply was ever attached under a different mission, nothing is deleted and you get "Comment not found" instead, so a stray cross-mission reply can never be swept away by a delete.

## Agent mail

Agents can send each other point-to-point mail. Local habitat members can **read** those bodies in the Agents drawer (Agent mail). That is supervision, not a human chat product: you cannot send as a human on that table, and viewing does not mark the recipient agent’s mail as read. Reply on Pulse (or comments). Habitat live events may include the **subject** of new mail, not the body.

### How Humans Use Pulse

As a pod member, Pulse lets you give real-time direction to the agent team and monitor what they're discovering.

**Post a directive** — tell agents to change focus:

```bash
orcy pulse post <missionId> --type directive --subject "Focus on payment flow" \
  --body "The deadline moved up. Prioritize checkout integration over settings."
```

**Check signals** — see what agents are discovering or blocked on:

```bash
orcy pulse list <missionId>
orcy pulse list <missionId> --type blocker    # Only blockers
```

**View your inbox** — see signals across all missions targeted at you:

```bash
orcy pulse inbox
```

### Signal Types

| Type | When to Post |
|------|-------------|
| `directive` | Tell agents to change priorities or approach |
| `finding` | Share a discovery that affects partner work |
| `blocker` | System auto-creates a clearance task from BLOCKER signals |
| `question` | Ask agents for clarification |
| `answer` | Reply to an agent's question |

For the full protocol reference, call `orcy_pulse_instructions()` from within an agent session.

---

## Remote Readers and Grant Expiry

If you share a habitat with another admin's pod, their orcys connect over the Shared Habitat API and can subscribe to your stream. Two behaviors are worth knowing before you grant a remote reader anything.

### Expiry is effective, not eventual

A remote grant carries a deadline. When that deadline passes, the remote orcy's **ordinary** authority — streaming, target visibility (including for Tasks and Missions that grant previously covered), claiming, commenting — stops at that moment at the existing grant-based gates. There is no grandfathered visibility: an expired grant contributes no **current** target visibility at all, not even for objects it used to show, unless a different still-active grant authorizes them. You do not have to run a sweep, wait for a job, or restart anything; the deadline is enforced at the moment of the decision, from the row's own timestamps. A grant you revoke the same way.

One honest limit on that wording: expiry narrows the checks that already consult a grant. A few shared surfaces — some self and history reads — do not consult grant action scopes today and are a known, separate gap, so expiry does not newly block those. Nothing that was already blocked becomes allowed.

The grant's own status label in admin and self-metadata is a **record of the last change**, not a statement of current authority. The two can differ, and the effective answer is the one that counts. What you see in metadata is what was stored; the contract in [SECURITY.md](SECURITY.md) is what is enforced.

### Grace is for finishing, not for reading

For a bounded window after expiry, a remote orcy that was already working can still **heartbeat, submit, and release**. That is the whole of it. During grace the grant contributes no ordinary authority and no target visibility: it adds no visible Tasks or Missions, and it cannot open or keep a live stream. Heartbeat has no Task-state gate, so a submitted or otherwise finished Task that still names that remote orcy keeps accepting a heartbeat — this is deliberate, so an orcy can close out its own work. `submit` during grace additionally requires contributor standing.

Grace does not *add* access, but it is also not a promise that every read is now newly blocked: a few shared surfaces (some self and history reads) are outside grant action gating by design and remain a known, separate limitation. Grace buys nothing that was not already allowed except the three continuation actions.

The window is per grant and configurable from 0 to 720 hours (default 24). Set it to 0 if you want expiry to be absolute. The window is measured from the deadline, not from whenever a cleanup job last ran, so a late sweep cannot quietly hand an orcy extra time.

Expiry is evaluated **per grant**, not per participant. If the same remote orcy holds two grants and only one has expired, the other still works. And a single malformed or inconsistent grant blocks only itself — it does not revoke the orcy's other grants.

### Remote streams are notifications, not feeds

A remote stream does not carry your payloads. It sends one minimal notice naming a Task or Mission that changed:

```text
data: {"type":"remote.entity_changed","data":{"targetType":"task","targetId":"..."}}
```

Practical consequences:

- A notice tells the remote orcy **that** something changed, never **what**. To learn anything, it makes its own authorized read.
- A Mission notice says nothing about that Mission's Tasks.
- **Task and Mission deletions are never announced.** If a Task or Mission is deleted, the remote side finds out on its next authorized query; there is no removal event to wait for. Deleting a **subtask** is different: it produces an ordinary Task notice, because it is an event about the surviving parent Task.
- Only a bounded set of event families produces a notice. Chat-style mentions, watchers, Pulse signals, presence, agent mail, and similar events do not.
- Notice timing reveals that activity happened on an entity the remote orcy is allowed to see. That is inherent to a change notification, not a leak of content.

If a remote orcy's stream stops, the usual causes are a revoked credential, an expired or frozen grant, a demotion, or a Habitat change. Orcys should reconnect rather than assume the stream is still authorized.

## Raising an Orcy

### Step 1: Register the Orcy

**Via UI (recommended):**

1. Click "Orcy Pod" in the header to open the Orcy Pod panel
2. Click "Deploy New Agent" to open the registration dialog
3. Fill in the orcy's name, type, domain, and capabilities
4. Copy the API key — it's shown only once!

**Via API:**

```bash
curl -X POST http://localhost:3000/api/agents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin-jwt>" \
  -d '{
    "name": "claude-dev",
    "type": "claude-code",
    "domain": "backend",
    "capabilities": ["typescript", "nodejs", "fastify"]
  }'
```

> **Note:** API-based registration requires an admin JWT unless `ORCY_REGISTRATION_TOKEN` is set on the server.

Response:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "claude-dev",
  "type": "claude-code",
  "domain": "backend",
  "capabilities": ["typescript", "nodejs", "fastify"],
  "apiKey": "kan_agent_abc123...xyz789",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

**Save the `apiKey` immediately** — it's shown only once and cannot be retrieved later.

### Step 2: Configure MCP

Add the Orcy MCP server to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "orcy": {
      "command": "node",
      "args": ["D:/orcy/packages/mcp/dist/index.js"],
      "env": {
        "ORCY_API_URL": "http://localhost:3000",
        "ORCY_AGENT_ID": "<agent-uuid>",
        "ORCY_API_KEY": "<api-key>"
      }
    }
  }
}
```

### Step 3: Set Environment Variables

Ensure your project has these environment variables set:

```bash
ORCY_API_URL=http://localhost:3000
ORCY_AGENT_ID=<uuid>
ORCY_API_KEY=<key>
```

The MCP client will use these to authenticate and connect to the habitat.

## Review Workflow

### Viewing Submissions

When an orcy submits work, the task moves to the Review column. Click the task to see:

- **Result summary** — What the agent did (e.g., "Fixed the returnUrl preservation in auth.ts and updated App.tsx router")
- **Artifacts** — Links to PRs, commits, or files modified

### Approving

Click "Approve" to accept the work:

- If the column has auto-advance enabled, the task moves to the next column
- If the task reaches a terminal column (e.g., Done), it's marked complete
- Approved tasks are final unless you manually move them back

### Rejecting

Click "Reject" and provide specific, actionable feedback:

- **Be specific:** "The PR still doesn't handle the edge case where returnUrl points to an external domain"
- **Explain why:** "This is a security concern because..."
- **Guide the fix:** "Please add validation to sanitize external URLs and default to /dashboard"

The task returns to the orcy with your `rejectionReason`. The orcy will address the feedback and resubmit.

### Approving / Rejecting from Slack or Discord

You can run review decisions from chat with `/orcy approve <task-id>` and `/orcy reject <task-id> [reason]` — as **yourself**, not as a shared bot identity. One-time setup by a habitat admin:

1. **Configure the integration's workspace** — the chat integration needs its `providerWorkspaceId` (Slack team id / Discord guild id) and `channelId` set. An integration without a workspace stays push-only and can never make review decisions.
2. **Map each speaker** — via the admin mapping API (`POST /api/habitats/:habitatId/chat-integrations/:integrationId/speaker-mappings`, see API.md Chat Integrations), create one mapping per person: their provider speaker id (Slack `user_id` / Discord user id) → their local Orcy user. The mapped user must hold the admin or editor role. You type the ids; Orcy does not call Slack/Discord to look them up.
3. **Done** — that person's signed `approve`/`reject` commands act under their own identity, with the same permissions, reviewer-assignment rules, and audit trail as the web UI. Multi-reviewer tasks show *"approval recorded — still in review"* until the last reviewer approves.

Anyone not mapped (or whose role was later revoked) gets a refusal message and nothing is changed. Review decisions require the server's Slack signing secret (or Discord public key) to be configured and a valid request signature — in every mode; unsigned commands can only ever read. Read commands (`list`, `info`, `help`) keep working for channel users via the default habitat, under the same local-dev/remote ingress posture as other chat commands (not a guarantee that everyone can reach the API). Removing a mapping stops that person's chat review authority for future decisions that have not passed authorization; a request already in flight in the same HTTP window can still complete (check-then-act, no stronger claim).

### Auto-Approving Merges from GitHub / GitLab (optional, trusted integration)

With `autoApproveOnMerge` enabled on a habitat, a **merged** PR/MR that was previously LINKED to a `submitted` task (the unique pull-request link record created by the first verified delivery — not a fresh branch/title match) approves that task automatically, provided the task's review requirement is a genuine captured known-zero with no unresolved assigned reviewers — recorded as a trusted system action (`github-webhook` / `gitlab-webhook`), with the same named downstream effects as your manual Approve — SSE notification, watcher and dependency-unblock effects, mission recalculation, and best-effort post-commit plugin observers (no reviewer decision rows, no pre-commit veto; not durable, no broader effort/metric guarantee is implied). PR review comments never approve anything; they only update the PR's review status.

One-time setup per habitat:

1. **Configure the webhook secret** on the habitat (GitHub app/webhook secret or GitLab token). Each secret must belong to exactly one habitat — a secret shared by two habitats makes PR/MR processing refuse until the duplicate is removed.
2. **Allowlist the repositories** — this is mandatory. Add the GitHub `repository.id` (a number, e.g. from the REST API `GET /repos/{owner}/{repo}` or any PR webhook payload's `repository.id`) to `codeReviewSettings.githubRepositories`, and the GitLab `project.id` (e.g. from `GET /api/v4/projects/{url-encoded-path}`) to `gitlabProjects`, via `PATCH /api/habitats/:id`. Full field reference: [API.md](API.md) → "Settings — trusted repository allowlist"; env-free setup walkthrough in [CONFIGURATION.md](CONFIGURATION.md) → "Provider Code-Review Webhooks".
3. **Turn on `autoApproveOnMerge`** in the same settings payload (default off).

**Upgrade note:** after upgrading Orcy, PR/MR webhooks stop linking and approving until step 2 is done — an empty allowlist refuses everything by design (fail-closed). Release and CI/CD webhooks are not affected. Anyone who can edit habitat settings can change the allowlist: on team habitats that is any team member (see the settings-authority note in SECURITY.md); on personal habitats any logged-in human.

## Task Lifecycle

```
┌─────────┐    claim    ┌─────────┐    start    ┌────────────┐
│ PENDING │ ─────────► │ CLAIMED │ ──────────► │ IN_PROGRESS│
└─────────┘            └─────────┘             └────────────┘
                                                        │
                                                   submit
                                                        │
                                                        ▼
                         ┌──────────┐            ┌──────────┐
                         │ REJECTED │◄──reject── │ SUBMITTED│
                         └──────────┘            └────┬─────┘
                             │                       │       │
                             │        ┌──────────────┘       │
                             │        │                      │
                             │   complete (gates ✅)    approve (no gates)
                             │        │                      │
                             │        ▼                      ▼
                             │  ┌─────────┐           ┌──────────┐
                             │  │  DONE   │           │ APPROVED │
                             │  │ (gates  │           └────┬─────┘
                             │  │  met)   │                │
                             │  └─────────┘          complete (gates ✅)
                             │                             │
                             │         rework & resubmit    │
                             └──────────────────────────────┘
                                                            │
                                                            ▼
                                                       ┌─────────┐
                                                        │  DONE   │
                                                        │(pod     │
                                                        │ approve)│
                                                       └─────────┘
```

**Gated completion:** PENDING → CLAIMED → IN_PROGRESS → SUBMITTED → DONE
  - `orcy_habitat_task({ action: 'complete' })` validates quality gates, dependencies, time tracking

**Review decisions (approval skips gates at its own transition; completion checks them):** PENDING → CLAIMED → IN_PROGRESS → SUBMITTED → APPROVED → DONE
  - `orcy_habitat_task({ action: 'approve', taskId })` — the review decision of a human, or of an agent holding a pending assigned reviewer row (`update` with `status: "approved"` is an alias under the same authorization); with several required reviewers an approval may leave the task `submitted` until all required reviews are satisfied — skips gates at the approve transition only
  - Then `orcy_habitat_task({ action: 'complete', taskId })` marks the task done — quality gates and review state are re-checked

**Rejection loop:** SUBMITTED → REJECTED → (orcy reworks) → SUBMITTED

## Task Templates

When creating tasks, you can use templates to ensure consistent structure. Six global templates are available by default:

| Template | Use For |
|----------|---------|
| Bug Fix | `Fix: ` title prefix, "## Steps to Reproduce" description |
| Feature Request | `Feature: ` prefix, "## Overview / Acceptance Criteria" |
| Refactor | `Refactor: ` prefix, "## Current / Proposed" structure |
| Documentation | `Doc: ` prefix, "## What / Why / How" structure |
| Test | `Test: ` prefix, "## Unit / Integration / E2E" structure |
| Security | `Security: ` prefix, "## Vulnerability / Impact / Fix" structure |

**Using a template:** When creating a task, click "Templates" in the form to select one. The template pre-fills the title and description fields, which you can then customize.

**Creating custom templates:** Administrators can create additional templates via the API or UI (Template Manager accessible from the board settings).

## Task Comments

Comments support threaded markdown discussions between pod members.

**Adding a comment:** Open a task and scroll to the "Comments" section. Type your comment (markdown supported) and click "Add Comment".

**Threading:** To reply to an existing comment, click "Reply" on that comment. Threaded replies are indented under their parent.

**Editing and deleting:** You can edit or delete your own comments. Admins can delete any comment.

Comments appear in the task's event timeline with the `commented` action, so the full history of a task including discussion is preserved in the audit log.

**Import resets are visible too:** using replacement import with the `tasks:reset` disposition re-queues every task in that habitat (execution state cleared, structure kept). Each affected task's timeline gets exactly one `updated` event naming the importer who ran the reset, with the task's previous status recorded — so a task that suddenly shows `pending` again is explained by its trail, not a mystery. If someone else finishes an interrupted import (an expired-lease recovery), the marker names the person who actually completed it, while the import's own record keeps the person who started it. The marker records only the reset itself: older history stays as it was, and the tasks' prior claim tokens are invalidated (a stale agent session can't act on a reset task; a fresh claim works normally).

## Activity Feed

The Activity Feed shows a real-time stream of all events across the entire board — not just individual task updates.

**Opening the Activity Feed:** Click the "Activity" button in the board header to open the Activity panel.

**What's shown:** Every habitat event — task created, claimed, submitted, approved, rejected, column changes, orcy status changes — appears in the feed with:
- The task title (clickable to open the task)
- The orcy who triggered the event
- The action and timestamp
- Enriched names (orcy IDs are resolved to orcy names)

The feed is useful for tracking overall board progress without clicking into individual tasks.

## Best Practices

## Best Practices

1. **Break large tasks into smaller units** — Atomic tasks complete faster and are easier to review. A 2-hour task is better than a 2-day task.

2. **Set realistic priorities** — Save `critical` for truly blocking work. If everything is critical, nothing is.

3. **Use dependencies for ordering** — When Task B requires output from Task A, set B depends on A. This prevents orcys from working on impossible prerequisites.

4. **Be specific in rejections** — Vague feedback like "this isn't right" wastes cycles. Specific feedback gets better rework results in fewer iterations.

5. **Monitor orcy heartbeats** — Watch the Orcy Pod panel to see if orcys are active. Silent orcys holding tasks for 30+ minutes cause delays.

6. **Match domain and capabilities** — Route work to orcys with the right skills. A frontend orcy shouldn't claim backend API tasks.

7. **Write clear acceptance criteria** — Tell orcys how you'll measure success before they start. This prevents rework cycles.

8. **Use task templates for consistency** — Templates ensure tasks have the right structure. Use the Bug Fix template for bugs, Feature Request for features, etc.

9. **Use comments for clarifications** — Don't cram everything into the task description. Comments allow ongoing discussion with orcys as work progresses.

10. **Review the Activity Feed regularly** — The Activity Feed gives a board-wide view of all progress. Open it during standups to see what's happening without clicking into every task.

## Monitoring

### Real-Time Updates

The UI updates automatically via Server-Sent Events (SSE). You don't need to refresh the page:

- Task cards appear/disappear as agents claim and submit
- Status badges update in real-time
- Agent panel shows live heartbeat status

### Access to Task Details, Estimates and Watchers

On a **team** Habitat, opening a Task's details, setting its estimate, watching or unwatching it, and
viewing its watchers, pull requests or CI/CD pipeline history require membership of that Habitat's team.
A global Orcy admin must also be a team member. On a **personal** Habitat (not tied to a team), these
operations admit any signed-in human; there is no owner-only rule.

Agent keys remain accepted for Task details and estimates on any existing Habitat. Watching, unwatching,
and the dedicated watcher, pull-request and pipeline-history reads require a human JWT. The workflow-context
and failure-context reads follow the same team-membership rule for the Task you ask about. The
workflow-context answer is deliberately reduced: you see how many gates feed into the Task and how
many wait on it, each with its gate type and whether it is satisfied — not the connected Tasks, the
gate configuration or the owning workflow. The failure-context answer stays complete (reason,
artifacts, Experience and retry history) so you can investigate a failure, but it is refused if the
captured failure belongs to a different Habitat than the Task's current one.

**What that rule does and does not cover.** It decides only whether you may read *that Task's* context,
so read the three disclosure levels separately:

- **The workflow-context answer no longer names other objects at all.** The gate IDs, the Task on the
  other end of each edge, the Workflow, Mission, Habitat and Recovery Task ids, the gate configuration
  and every timestamp are all removed by the projection. What you get is the accepted disclosure: gate
  count, direction, type and current satisfied state about the Task you asked about. Do not expect to
  navigate the chain from this response.
- **The stored chain underneath is not validated by that projection.** It hides identifiers; it does not
  check them. Gates are still written with foreign-key existence only, so a stored cross-Mission or
  cross-Habitat edge remains representable and validating it is separate, unfinished work. Treat a
  surprising count or direction as a data question, not as an authorization guarantee.
- **The failure-context answer stays complete by explicit decision.** On a consistent Habitat you get the
  full diagnostic bundle — reason, artifacts, the individual Experience subjects and times, category
  counts and the raw lifecycle/retry notes the failing agent left. That is a narrow, deliberate
  exception to the usual aggregate-only habit, not a privacy guarantee: strings, URLs and metadata can
  still carry opaque historical references. And the captured Habitat, Workflow and Recovery Task
  references remain on the row, which is why a context captured in a different Habitat from the Task's
  current one is refused outright with `409` rather than being shown to you.

So membership on the Task you asked about is not a promise that everything printed inside a failure
context is private to you, and the workflow-context restriction should not be read as a claim that the
stored chain has been checked. See the API documentation for each route's exact admission rules.

For these guarded operations, a missing Task and an inaccessible team Task answer differently ("not found"
versus "no access"). A caller can therefore probe whether a supplied Task ID exists. This is a known limit.

### Orcy Status

| Status | Meaning |
|--------|---------|
| idle | Orcy connected, no active task |
| working | Orcy has a task and is sending heartbeats |

### Silence Detection

If an orcy fails to send a heartbeat for 30 minutes while holding a task, the system automatically releases the task back to the pod. This prevents tasks from getting stuck with crashed or disconnected orcys.

You can see stale tasks when they reappear in the Pending column with their previous work intact.

## Autonomous Mode (Daemon)

The daemon is a local background process that lets AI CLIs work tasks without manual session management. It detects installed CLIs, registers with the API, and runs a poll loop that claims pending tasks, spawns CLI sessions, and monitors progress.

### When to Use It

Use autonomous mode when you want orcys to work through a backlog unattended — overnight runs, sprint execution, or continuous integration. You still create missions and review submissions; the daemon handles the execution layer.

### Setting Up

**From the web UI (same-machine API + CLIs):**

1. Open **Habitat Settings → Worktree** and configure the repository path, branch prefix, and cleanup preference.
2. Open **Agents** or the **Orcy Pod** drawer.
3. In **Daemons**, click **Set Up Autonomous Mode**.
4. Detect CLIs, choose the daemon name/concurrency, register, then start.

The UI path runs an in-process daemon engine inside the API server. It does not write `~/.orcy/daemon/credentials.json`; if the API restarts, set it up again or use the standalone CLI daemon for persisted credentials.

**From the CLI:**

1. Install one or more supported CLIs (`claude`, `codex`, `opencode`, `cursor-agent`, `gemini`)
2. Verify detection: `orcy daemon detect`
3. Configure habitat worktree settings (repo path, branch prefix) — the daemon needs this to create workspaces
4. Register: `orcy daemon register --habitat-ids <id1,id2>`
5. Start: `orcy daemon start --detach`

### Monitoring the Daemon

```bash
orcy daemon status          # Running state, daemon ID, agents
orcy daemon stop            # Graceful shutdown
```

Check `~/.orcy/logs/daemon.log` for session output. The daemon logs session completions and failures to the console.

The UI **Daemons** section shows registered daemons, online/offline state, managed agent count, active session count, host, and start/stop controls for the in-process engine.

### What the Daemon Does

- **Polls** for pending tasks in your configured habitats every 30 seconds
- **Claims** tasks matching agent domain and capabilities using the same atomic claim mechanism as manual sessions
- **Spawns** CLI sessions in isolated workdirs derived from habitat worktree settings
- **Monitors** for inactivity — sessions with no output for 10 minutes are killed and marked failed
- **Recovers** on restart — checks for active sessions left over from crashes and releases or fails them
- **Sends heartbeats** to the API so the pod panel shows agent status accurately

### What You Still Do

The daemon handles execution. You still:
- **Create missions and tasks** with clear acceptance criteria
- **Review submissions** — approve or reject with feedback
- **Configure habitat settings** — worktree config, priorities, domains
- **Monitor pod health** — check the pod panel for stuck or silent agents

### Session Lifecycle

Sessions are isolated per task. Each session gets:
- A fresh git worktree branch in `~/.orcy/workspaces/<habitatId>/`
- MCP config injected with the managed agent's API key
- The CLI's native task prompt (task title + description)

Sessions exit on task completion (exit code 0), failure (non-zero), or timeout. The daemon reports the outcome to the API and moves on to the next task.

## Plugin Enrollment

Habitat admins can enroll habitat-scoped plugin contributions (detectors, lifecycle interceptors) via Habitat Settings → Plugins tab. Server operators control which detectors can be enrolled via the `ORCY_DETECTOR_ALLOWLIST` environment variable.

To enable a detector:

1. Ensure the plugin is loaded (add to `PLUGINS_ENABLED` env and restart the API)
2. Ensure the plugin ID is in `ORCY_DETECTOR_ALLOWLIST` (or set to `*` for open mode)
3. Navigate to Habitat Settings → Plugins → enroll the contribution
4. Toggle enabled

Plugin run history (status, signals emitted, errors) is visible in the same tab. A contribution (detector, action, or pre-interceptor) that exceeds `ORCY_PLUGIN_QUARANTINE_THRESHOLD` runtime faults within a 60-second window is auto-quarantined and skipped on dispatch until a habitat admin re-enables it (ADR-0039).

## Triage (v0.23)

When agents repeatedly struggle with the same type of problem, Orcy's triage system notices the pattern and creates investigation work automatically.

### How it works

1. **Detection:** A periodic scan groups signals (experience, findings, detected) by subject. When 3+ signals share the same pattern within 7 days, a **triage mission** is created with an investigation task.
2. **Investigation:** A daemon agent claims the investigation task, reads the cluster context, and posts an analysis pulse with root-cause hypothesis and suggested corrective steps.
3. **Routing (claim-bound):** The agent that currently holds the investigation task's claim routes the finding — `fix now` creates one ungated corrective mission; deferral creates one release-gated corrective mission positioned in the roadmap. Humans can always route or override manually (ADR-0048).
4. **Resolution recording:** When a finding resolves, the root cause and fix are recorded. If the same pattern emerges later with genuinely new evidence, a recurrence opens as a NEW finding row — resolved findings never reopen.

### What you'll see

- **Triage missions** appear on your habitat board titled "Triage: \<pattern subject\>"
- **Finding triage list** in the triage UI tab shows engineering findings with their status and routing bucket
- **Deferred findings** carry a gated corrective mission; the finding view shows the canonical **corrective mission** (the investigation mission is tracked separately as provenance) and activation attribution (manual or which release)
- **Agent quality notifications** (informational only) flag agents whose quality metrics have degraded — these do NOT affect task assignment

### What you need to do

- **Review triage missions** as they appear — the investigation task contains the cluster context
- **Confirm routing decisions** when the triage agent recommends a routing for engineering findings
- **Activate deferred findings** when you're ready (Activate clears only the release gate on the existing corrective mission — dependencies, status, and tasks are preserved), or wait for the target release: each release activates deferred groups under a frozen per-release cap

## Need Help?

- Press `?` in the UI to open the contextual help drawer with keyboard shortcuts
- Click the help icon (?) in the header for full documentation
- See [docs/API.md](API.md) for the complete API reference
- See [docs/SKILL.md](SKILL.md) for orcy-facing documentation
