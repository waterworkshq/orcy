# Orcy Context

Orcy coordinates work between humans and AI coding agents. This glossary captures product language and domain boundaries, not implementation details.

## Language

**Habitat**:
A shared workspace scoped to one code repository, where pod members coordinate missions, tasks, signals, skills, integrations, and automation.
_Avoid_: Board, workspace

**Mission**:
A goal inside a habitat, with acceptance criteria and child tasks. Mission-level views aggregate evidence and progress from tasks unless explicitly stated otherwise.
_Avoid_: Feature, project

**Task**:
An executable unit of work claimed, performed, submitted, reviewed, and completed by an orcy.
_Avoid_: Ticket, issue

**Orcy**:
A participant in the pod, human or AI agent, that can coordinate, execute, review, or supervise work.
_Avoid_: User when the participant may be an agent

**Pod Affiliation**:
The relationship between a participant and the pod that owns or hosts their identity, such as local pod membership or remote pod participation. Affiliation explains where the participant comes from; it does not by itself grant habitat permissions.
_Avoid_: Citizenship, tenant when the distinction is about pod relationship rather than legal/account ownership

**Participant Standing**:
The trust tier a host habitat grants to a participant or pod, such as local member, remote observer, or remote contributor. Standing shapes which action scopes can be granted, but explicit scopes still decide the exact allowed actions.
_Avoid_: Role when the distinction is specifically local-vs-remote trust standing

**Provider-Backed Identity**:
An identity verified through an external auth provider such as GitHub, Google, or generic OIDC. Provider-backed identity improves onboarding and trust bootstrap, but does not by itself grant habitat, task, or repository permissions.
_Avoid_: Treating provider login as authorization

**Auth Provider Preset**:
A preconfigured provider profile for external identity, such as GitHub OAuth or a generic OIDC provider. Presets improve onboarding without making the identity model provider-specific.
_Avoid_: Hard-coding one auth provider into the domain model

**Manual Invite Credential**:
A non-provider fallback credential used to accept an invitation or establish trust when provider auth is unavailable or intentionally disabled. Manual invite credentials preserve local-first operation but should be presented as the advanced path for shared-habitat setup.
_Avoid_: Default shared-habitat onboarding path

**Remote Observer**:
A remote participant or pod granted visibility and advisory feedback rights in a habitat without execution or approval authority. Remote observers can receive/read scoped context and may post comments or review feedback when explicitly granted, but they cannot claim, submit, approve, reject, or mutate execution state.
_Example_: External code reviewers, security auditors, team leads, or org leads who need habitat visibility without task execution authority
_Avoid_: Contributor, approver, lifecycle reviewer

**Advisory Feedback**:
Non-lifecycle feedback from a participant, such as comments or review guidance, that can influence direction without approving, rejecting, claiming, submitting, or completing work.
_Avoid_: Approval, rejection, task transition

**Remote Contributor**:
A remote orcy or pod granted scoped execution authority in a host habitat, such as claiming and submitting existing eligible tasks. Remote contribution does not imply task creation, review, approval, or repository access.
_Avoid_: Local member, remote reviewer

**Remote Contributor Activity**:
Work and feedback performed by remote observers or contributors in a host habitat. It should appear in task history, comments, evidence, notifications, and audit trails, but should not be blended into local agent quality metrics unless those metrics explicitly model pod affiliation and standing.
_Avoid_: Treating remote activity as native local agent performance

**Remote Evidence Link**:
Code evidence supplied by a remote contributor as scoped metadata, such as a pull request URL, commit URL, fork branch URL, or summary. Remote evidence links support provenance without granting broad repository discovery, backfill, or mutation authority.
_Avoid_: Repository access grant, repo scan permission

**Lifecycle Approval**:
The authority to approve, reject, or otherwise finalize submitted work in Orcy's task lifecycle. In the first shared-habitat model, lifecycle approval stays with local humans or local policy, not remote observers or contributors.
_Avoid_: Advisory feedback, comment, review guidance

**Remote Orcy Credential**:
A per-orcy credential issued under a remote pod affiliation for scoped work in a host habitat. A pod-level trust relationship may bootstrap enrollment, but execution actions should be attributable to one remote orcy, not a shared pod token.
_Avoid_: Shared pod credential for task execution

**Host-Approved Capability**:
A domain or capability claim for a remote orcy that the hosting pod has approved for task eligibility. Remote pods may propose capabilities, but the host habitat decides which ones count for assignment and claiming.
_Avoid_: Trusting self-declared remote capabilities for task eligibility

**Scoped Elevation Grant**:
A temporary or bounded grant that raises a remote participant from baseline visibility into specific execution authority, limited by time, mission, task, or action scope. In the first shared-habitat model, only a local admin should create these grants.
_Avoid_: Permanent trust when the grant is intended to expire or stay narrowly bounded

**Permanent Remote Grant**:
A long-lived remote grant that keeps execution authority until revoked. It should be explicit, visibly risky, and reserved for highly trusted pods that accept broader operational risk.
_Avoid_: Default contributor access

**Code Evidence**:
A concrete code-related artifact produced or observed during work, such as a branch, pull request, merge request, commit, changed file, pipeline run, review status, or external code URL.
_Avoid_: Artifact when the evidence needs to be queryable as provenance

**Evidence Link**:
The relationship between a task or mission and a piece of code evidence. Evidence links record why Orcy believes the evidence belongs to the work item.
_Avoid_: Attachment, reference

**Evidence Correction**:
An append-only correction to an evidence link that marks it incorrect, removed, or superseded while preserving the original history.
_Avoid_: Silent deletion, hard unlink

**Task Evidence**:
Code evidence linked to a specific task. This is the default provenance path for implementation work.
_Avoid_: Mission evidence when the artifact belongs to one task

**Mission Evidence**:
Code evidence visible at the mission level. Most mission evidence is rolled up from child task evidence; direct mission evidence is reserved for artifacts that belong to the mission as a whole.
_Avoid_: Task evidence when the artifact spans the whole mission

**Changed File Snapshot**:
A durable record of a file path and change summary captured when code evidence is linked. It preserves provenance for audit and analytics without storing source code or full diffs.
_Avoid_: Source browser, diff viewer

**Local Code Evidence**:
Code evidence reported from a local repository or worktree without a remote provider record. It is useful for autonomous agent work but is less externally verifiable than provider-backed evidence.
_Avoid_: Provider-backed evidence

**Provider-Backed Evidence**:
Code evidence observed from an external source control or CI provider, such as GitHub or GitLab. The evidence record can be reused across multiple evidence links.
_Avoid_: Task-owned evidence record

**Evidence Gap**:
A known absence or incompleteness in provenance because work happened outside Orcy's observable paths or was not reported back to Orcy. Evidence gaps should be visible as uncertainty, not silently treated as proof that no code changed.
_Avoid_: Missing evidence as negative proof

**Audit Event**:
A canonical history record that explains who or what changed an entity, when it happened, where the change came from, and which related evidence or entities were involved.
_Avoid_: Treating lifecycle events, integration runs, and evidence records as unrelated histories

**Lifecycle Event**:
A history record for a task or mission state change, such as creation, update, movement, submission, approval, rejection, completion, or deletion.
_Avoid_: Audit event when the record is only one source in the broader audit trail

**Audit Source**:
The origin path of an audit event, such as REST API, MCP tool, webhook, scheduler, integration sync, daemon, migration, or system process.
_Avoid_: Actor; source explains where the change came from, actor explains who or what performed it

**Evidence Bundle**:
A task- or mission-scoped audit package that gathers lifecycle history, code evidence metadata, CI/review metadata, effort records, and integration evidence. It contains references and summaries, not source code, full diffs, or raw provider payloads by default.
_Avoid_: Source archive, eDiscovery package

**Legacy Partial History**:
Historical data that predates newer audit capture paths and may be incomplete. Legacy partial history should be labeled with caveats instead of backfilled with speculative events.
_Avoid_: Pretending old gaps are complete history

**Evidence Completeness**:
A status that summarizes whether Orcy's provenance for a task or mission appears complete, partial, missing, not applicable, or unknown.
_Avoid_: Treating missing evidence as zero code work

**Learning Loop**:
A future Orcy capability where trusted history and outcomes are extracted into reusable knowledge, recommendations, rules, or agent context while preserving source citations, permissions, and uncertainty.
_Avoid_: Treating raw audit history as automatic wisdom

**Automation Rule**:
A habitat-scoped rule that reacts to a server-side trigger, checks conditions, and requests bounded actions such as notification, signal creation, task creation under an existing mission, priority change, assignment, review request, risk marking, or webhook call.
_Avoid_: Workflow rule, automation workflow

**Automation Run**:
A durable record of one Automation Rule evaluation or execution, including trigger context, condition result, skip reason, action results, and audit provenance.
_Avoid_: Treating automation side effects as invisible background work

**Notification**:
A recipient-scoped attention request for a human or agent to notice, acknowledge, defer, or act on something in a habitat.
_Avoid_: Pulse signal, toast

**Notification Event**:
The shared reason a notification exists, such as a task becoming blocked, an automation rule matching, a review being requested, or a digest becoming ready.
_Avoid_: Delivery, channel attempt

**Notification Delivery**:
The recipient-specific attention state for a notification event, including whether that human or agent has seen, acknowledged, snoozed, or muted it.
_Avoid_: Notification event, channel attempt

**Notification Subscription**:
A habitat default or recipient override that expresses which notification events should reach which humans or agents and through which channels.
_Avoid_: Global boolean preference

**Notification Channel**:
A route used to deliver notification attention, such as in-app, webhook, Slack, or Discord.
_Avoid_: Notification event, subscription

**Notification Digest**:
A recipient-facing summary notification that gathers multiple notification events into one attention item.
_Avoid_: Replacing the source notification events

**Notification Escalation**:
An automation-driven follow-up when a notification remains unacknowledged or otherwise needs more attention.
_Avoid_: Built-in notification rule engine

**Notification Mute**:
A recipient override that suppresses future matching notification deliveries without deleting historical attention records.
_Avoid_: Deleting notifications

**Notification Snooze**:
A time-bound deferral of a notification delivery or subscription so attention returns after the chosen time.
_Avoid_: Mute, acknowledgment

**Notification Clearance**:
The removal of resolved recipient attention state from the active inbox/query path after acknowledgment, resolution, expiry, or administrator cleanup while preserving compact history.
_Avoid_: Treating active inbox state as permanent audit storage

**Notification History**:
Compact retained evidence that a notification event and delivery outcome happened, kept for traceability after active attention state is cleared.
_Avoid_: Active delivery state

**Required Notification**:
A habitat-admin-defined notification default for critical events that can bypass recipient mute so operationally important attention is not silently suppressed.
_Avoid_: Letting automation or personal preferences make arbitrary notifications unmutable

**Pulse Signal**:
A shared mission or habitat signal that humans and agents can post, read, and react to as collaborative context. Pulse is passive shared memory; notification is active recipient attention.
_Avoid_: Notification, alert

**Elapsed Time**:
Clock time between lifecycle moments, such as claimed to completed or started to completed. Elapsed time is not the same as effort.
_Avoid_: Effort, work time

**Logged Effort**:
Effort explicitly reported by a human or agent as minutes spent on a task. Logged effort is stronger evidence of work than inferred heartbeat presence.
_Avoid_: Elapsed time, cycle time

**Inferred Presence**:
Time inferred from agent heartbeats while a task is claimed or in progress. It indicates presence or activity signal, not verified effort by itself.
_Avoid_: Actual effort, billable time

**Effort Entry**:
A recorded amount of effort or inferred presence associated with a task, actor, source, note, and timestamp.
_Avoid_: Timesheet when payroll-grade semantics are not intended

**Effort Correction**:
An audit-preserving adjustment that corrects an effort entry without silently changing history.
_Avoid_: Silent edit, hard delete

**Effort Basis**:
The source basis used to interpret effort analytics, such as logged effort, inferred presence, or unavailable. Analytics should state the basis rather than treating all time as one kind of effort.
_Avoid_: Actual time when the source is ambiguous

**Carry-Over Reason**:
An explanation for why a mission did not finish inside a sprint and moved forward, inferred from blockers, incomplete tasks, missing evidence, overdue work, estimate variance, rejection patterns, or inactivity unless explicitly captured later.
_Avoid_: Blame label

**Agent Quality Signal**:
An informational signal about an agent's recent work outcomes, confidence, and sample size. In v0.17 language this signal informs humans and agents but does not control assignment, gates, permissions, or review routing.
_Avoid_: Agent ranking, punishment score

**Link Source**:
The origin of an evidence link, such as webhook inference, branch pattern matching, commit trailer matching, agent reporting, or human manual linking.
_Avoid_: Type, provider

## Example Dialogue

Dev: "This mission shipped through three tasks. Where is the code evidence?"

Domain expert: "The mission rolls up evidence links from its tasks: two pull requests, six commits, changed file snapshots, and one failed then passing pipeline run. The release pull request is direct mission evidence because it spans all tasks. One commit was linked by branch pattern, another was reported from a local worktree, and another was manually linked by a human because it came from a hotfix branch. If the same commit belongs to two tasks, Orcy keeps one commit evidence record and two evidence links. If no one reports off-Orcy work, Orcy shows an evidence gap rather than assuming no code changed. If a link is wrong, Orcy records an evidence correction instead of deleting the original. Orcy stores file path snapshots for history, not full diffs. For time, Orcy separates elapsed lifecycle time from logged effort and inferred heartbeat presence. Audit events explain lifecycle changes, evidence changes, effort corrections, integration sync side effects, and other source-specific histories through one canonical language. Evidence bundles collect references and metadata for a task or mission, not raw source archives."
