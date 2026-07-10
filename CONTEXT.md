# Orcy Context

Orcy coordinates work between humans and AI coding agents. This glossary captures product language and domain boundaries, not implementation details.

## Language

**Triage**:
The automated detection of clustered implicit signals and engineering findings, the bounded investigation that follows, and the routing of the result into corrective work or a deferred backlog — without orphaning any flagged issue. Triage investigates and routes; it does not fix, judge agent quality, or auto-apply bucket decisions.
_Avoid_: Auto-fix, alerting, monitoring (when describing the detect-investigate-route loop rather than passive observation)

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

**Audit Provenance**:
The structured trace context that explains how an Audit Event originated and which source-specific execution produced it. Shared request, route, provider, and remote-participant fields coexist with typed, namespaced context for mechanisms such as automation, notifications, and plugins; result payloads and domain state remain event metadata rather than provenance.
_Avoid_: Audit Source (the origin channel), actor, arbitrary event payload

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

**Workflow**:
An optional orchestration plan attached to a mission that declares dependency and gate relationships between the mission's tasks. A mission without a workflow behaves as today (any agent can claim any task); a mission with a workflow restricts which tasks are claimable based on gate state. Workflow nodes are tasks — there is no separate "step" entity.
_Avoid_: Pipeline, runbook, playbook, DAG, workflow step

**Workflow Gate**:
A typed condition on a dependency from one task to another that determines when the downstream task becomes claimable. Five gate types ship in v0.20: completion of the upstream task (`on_complete`), lifecycle approval of the upstream task (`on_approve`), a matching pulse signal (`on_signal`), an explicit manual unblock (`on_manual`), and upstream failure (`on_fail`, which spawns recovery). A sixth type (`on_automation`) is planned for v0.20.1 once the v0.18 automation executor is wired into production.
_Avoid_: Trigger, transition, lifecycle event when describing the gate itself

**Workflow Join**:
The fan-in semantics declared on a task with multiple upstream workflow gates — whether all gates must fire (`all_of`), any gate (`any_of`), or a quorum (`n_of`) before the task becomes claimable.
_Avoid_: Merge, sync point

**Failure Context**:
A structured bundle of evidence about why a task failed, captured when the task transitions to `failed`, `rejected`, or `released`. Includes the failure reason, failure kind, artifacts produced before failure, recent lifecycle events, agent experience signals, and retry history. Failure context is the input to recovery.
_Avoid_: Error log, stack trace, debugging state

**Recovery Task**:
A task gated by an `on_fail` workflow gate from a failed task, whose job is to ingest the failure context, diagnose the cause, and either fix the underlying issue, retry with adjustments, or escalate as unrecoverable. Recovery tasks participate in the workflow like any other task — they can be claimed, submitted, approved, or failed.
_Avoid_: Retry task (when the work involves diagnosis rather than blind re-execution), error handler (when describing the work, not the code)

**Recovery Redemption**:
A successful recovery outcome where the recovery task's success causes the originally failed task's downstream `on_complete` or `on_approve` gates to fire as if the original had succeeded. The failed task stays failed in history; redemption is a forward-flowing unblock, not a rewrite of history.
_Avoid_: Retry success, rollback

**Template**:
A reusable scaffold stored at the habitat level (or globally when habitat-scoped is null) that instantiates a mission with predefined tasks and an optional workflow definition at creation time. Templates do not execute; they spawn. Existing instantiated missions are detached from their template — later template edits do not propagate.
_Avoid_: Blueprint, recipe, pattern, workflow definition (a template can contain a workflow definition but is not the same thing)

**Template Variable**:
A named placeholder inside a workflow template (such as `{{feature_name}}`) that the human fills in at instantiation time. Variable values are substituted into task titles, task descriptions, gate match configs, and recovery task templates when the mission is created from the template. Runtime tokens like `{{failedTaskTitle}}` and `{{failureReason}}` are left intact at instantiation and resolved later by the recovery subsystem.
_Avoid_: Parameter, argument, macro

**Experience Signal**:
A self-reported agent-experience pulse with `signalType: "experience"` and a category in `metadata.experience` (`stuck`, `confused`, `backtrack`, `surprised`, `ambiguous`, `sidetracked`, `smooth`). Experience signals are implicit — they capture what the agent noticed during work, distinct from intentional pulse communications like findings or blockers.
_Avoid_: Mood, sentiment, error log

**Recovery Depth**:
The recursion level of a recovery chain within a workflow. Original workflow gates are at depth 0; recovery-task gates spawned from `on_fail` are at depth 1; recovery-of-recovery gates are at depth 2. Deeper escalation is not auto-spawned — it surfaces as `workflow_recovery_unrecoverable` for human intervention.
_Avoid_: Retry count, failure level

**Failure Handler**:
A workflow-level or per-task configuration that declares what recovery task template to spawn and which agent selector to use when an `on_fail` gate fires. A workflow may declare one default failure handler; individual tasks may override it (including setting `null` to disable recovery for that task specifically).
_Avoid_: Exception handler, error callback

**Wiki Page**:
A habitat-scoped, authored, versioned markdown document that synthesizes the habitat's primitives — pulses, signals, insights, skills, evidence, generated material — into long-form knowledge. Authored by a human or agent orcy; never auto-generated. Organized in a tree with optional collection tags. Cites source primitives via wiki page links.
_Avoid_: Knowledge Base entry, doc, note (when the distinction is authored-synthesis vs. raw capture)

**Wiki Page Link**:
A citation from a wiki page to a source primitive (mission, task, pulse, insight, skill signal, code evidence, external issue, etc.). Links are citations, not dependencies — dangling links are surfaced at read time rather than enforced by cascade-delete. One page may cite many primitives; one primitive may be cited by many pages.
_Avoid_: Evidence Link (which records provenance for code artifacts specifically), Attachment, Reference

**Authoring Augmentation**:
The authoring-time surface that exposes active habitat primitives to a wiki page author as context while writing. On edits, surfaces deltas since the last page version; on initial or ongoing generation, a scheduler spawns time-chunked authoring tasks that an orcy claims and authors. The scheduler never writes content; relevance ranking and embeddings are out of scope.
_Avoid_: RAG, retrieval system, auto-completion, content generation

**Engineering Finding**:
A structured codebase observation posted as a pulse with `signalType: "finding"` and required metadata (`findingKind`, `severity`, `affectedFiles`, `blocksCurrentWork`). Engineering findings are intentional observations about the codebase (pre-existing bugs, scope gaps, approach dead-ends, integration breakage) — distinct from candid self-reported Experience Signals. Structured findings opt into wiki surfacing and triage routing; free-form findings without metadata remain backward-compatible but surface in a catch-all section.
_Avoid_: Bug report (when the observation is an in-system signal, not an external tracker item), finding (when the distinction between structured engineering finding and general pulse finding matters)

**Signal Surface**:
A reader-facing derived view in the wiki browser that aggregates signals into glanceable patterns — frequency, outcome correlation, time-windowed trends, per-domain filtering. Two surfaces ship in v0.21: Experience Signals (aggregated from `habitat_skill_signals`, privacy-protected to aggregates only) and Engineering Findings (individual + attributed, structured + unstructured). Signal surfaces are live queries over existing tables, not authored pages.
_Avoid_: Dashboard (when the view is specifically the wiki's signal-derived tabs), report (when the view is live/derived, not generated)

**Plugin**:
A bundled, manifest-declared extension that contributes to Orcy through one or more typed extension points (notification channel, signal detector, lifecycle interceptor, dynamic MCP tool, future action/condition/adapter). Loaded at server boot from a local filesystem drop-in (`PLUGINS_DIR`); cannot execute without a manifest. Same plugin module may declare multiple contributions. Marketplaces, npm install, and remote signed fetch are deferred.
_Avoid_: Add-on, extension, app, module (when describing the unit of ecosystem contribution)

**System Plugin**:
A plugin whose every contribution declares `scope: "system"`. System contributions shape server-wide infrastructure and are enabled at boot via the `PLUGINS_ENABLED` env list. Notification channels and webhook transformers are system-scoped: only one contribution per channel id may be loaded server-wide. Per-habitat enablement is meaningless for system plugins because their contribution shapes the infrastructure all habitats share.
_Avoid_: Global plugin (when the distinction is infrastructure vs content), Core module

**Habitat Plugin**:
A plugin whose every contribution declares `scope: "habitat"`. Habitat contributions produce per-habitat content or behavior and are enrolled per-habitat by a habitat admin via REST/UI. Signal detectors and lifecycle interceptors are habitat-scoped; a plugin may be enrolled in zero, one, or many habitats. Enrolled state is independent across habitats, but the plugin module itself is loaded once at boot and may be denied entry by the `ORCY_DETECTOR_ALLOWLIST` boot-time config when such an allowlist applies.
_Avoid_: Local plugin (when the distinction is per-habitat enrollment vs server boot), Tenant plugin

**Mixed Plugin**:
A plugin with both system-scoped and habitat-scoped contributions in one module. The system contributions are enabled at boot by the server admin; the habitat contributions are enrolled per-habitat by the habitat admin. The two enablement paths are independent — a mixed plugin can boot its system contribution server-wide without any habitat enrolling its habitat contribution, and vice versa a habitat can enroll the habitat contribution while the system contribution sits loaded-but-inert if env-disabled.
_Avoid_: Duplex plugin, dual plugin

**Plugin Manifest**:
A typed declaration emitted by a plugin that names the plugin, declares its version, lists its contributions (notification channels, detectors, MCP tool definitions, lifecycle interceptors), and binds a config schema default. Manifest is the contract between plugin author and Orcy; the existing `KanbanPlugin` interface is collapsed into it for v0.22.
_Avoid_: Manifest when describing a process or data row rather than the plugin contract, plugin.json (the manifest is an exported object, not a file convention)

**Plugin Enrollment**:
A per-habitat REST-managed configuration row that opts a habitat-scoped plugin into a specific habitat. Carries a habitat-scoped config blob validated against the plugin's manifest config schema, an `enabled` flag, and an audit trail. System plugins are not enrolled because their contributions are server-wide.
_Avoid_: Activation, installation, grant

**Detected Signal**:
A pulse signal emitted by a signal-detector plugin with `signalType: "detected"` and server-injected provenance (`metadata.detected: true`, `metadata.detector: "<pluginId>"`, `metadata.detectorRunId: "<runId>"`). Detected signals are categorically distinct from agent self-reports (`signalType: "experience"`) and intentional agent observations (`signalType: "finding"`) — they are automated pattern matches over pulse text, task events, comments, or submission output. They surface in the wiki signal-surface reader as their own sub-bucket (separate from Experience Signals and Engineering Findings) and route through v0.23 triage with different weighting from self-reports.
_Avoid_: Auto-finding, auto-signal, machine signal, classified signal (when describing the pulse category rather than a triage decision)

**Pattern Cluster**:
A time-windowed grouping of two or more implicit signals (experience, finding, or detected) sharing the same normalized subject (cluster key) and signal category within a habitat. A single signal is an observation; a cluster is an emerging pattern worth investigating, and is the trigger input to reactive triage. Clusters are detected by periodic scan, not per-signal event, because membership is a property of the window, not the individual post.
_Avoid_: Signal group, signal batch, alert, anomaly (when describing the cluster of signals rather than a board-health metric)

**Triage Mission**:
A mission spawned to investigate a Pattern Cluster or engineering finding, containing a single investigation task that a daemon agent claims. It holds only the investigation; corrective tasks created during the investigation land under the affected existing missions, linked back to the triage mission. One triage mission per cluster detection; its resolution feeds a Resolution Record for proactive historical lookup.
_Avoid_: Investigation ticket, bug mission, triage task (when describing the container mission rather than its child investigation task)

**Triage Investigation**:
The bounded analysis a daemon-owned agent performs after claiming a triage mission's investigation task — reading clustered signals, affected task/mission context, and historical resolutions, then posting an analysis pulse and optionally creating corrective work. It investigates and reports; it does not fix, judge agent quality, or modify existing work.
_Avoid_: Triage mission (the container), root-cause analysis (when describing the bounded agent task rather than open-ended debugging)

**Routing Bucket**:
The deferred-work classification assigned to an engineering finding during triage: `fix_now`, `defer_to_patch`, `defer_to_release`, `document_as_known_limitation`, or `needs_investigation`. The bucket decides where the finding routes. Bucket decisions stay human-in-the-loop for non-trivial cases — the workflow is deterministic (no finding is orphaned), the decision is not (the agent recommends, a human confirms).
_Avoid_: Priority, severity, label (when describing the routing classification rather than task priority or signal severity)

**Resolution Record**:
A record of how a triaged Pattern Cluster or engineering finding was resolved — root cause, fix, and resolution kind — keyed by the pattern's normalized subject for proactive matching. When a similar pattern emerges later, the historical resolution surfaces as a suggested fix before new triage work is created.
_Avoid_: Fix note, completion comment, wiki page (when describing the structured match-keyed record rather than authored knowledge)

**Release Detection**:
The provider-agnostic recognition that a tracked codebase has shipped a release, fed by GitHub release webhooks, CI/CD pipeline completion of a release workflow, CLI manual triggers, or external systems calling a shared trigger endpoint. Detection supplies a version string; classification of the release type (patch / minor / major) is the system's responsibility, not the detector's.
_Avoid_: Deploy, publish (when the event is the version bump, not the artifact drop)

**Release-Type Routing**:
The semver-aware determination of which deferred findings activate when a release ships. A patch release activates only patch-targeted findings; a minor activates patch + minor; a major activates everything. The release type is the routing key — patch ⊂ minor ⊂ major as cascading scopes — so a larger release covers everything a smaller one would.
_Avoid_: Priority, severity (when describing the type-cascade filter, not the finding's importance)

**Semver-Targeted Deferral**:
Tagging a deferred finding with the type of release it waits for (`patch`, `minor`, or `major`) or a specific version (`v0.24.0`, or any `v0.24.x`). A finding with a type target activates on the next release of that type-or-greater; a finding with a version target activates when that exact or prefixed version ships. The Routing Bucket captures the human's coarse deferral intent; the type or version target is the precise activation rule.
_Avoid_: Milestone, fix-version (when describing Orcy's type or version targeting, not an external tracker's label)

**Release Activation**:
The automatic transition of a deferred finding into active corrective work when its target release ships. Activation is unconditional — every release-matched finding promotes regardless of release type — because the human's decision was made at deferral time, not release time. The human's leverage is pre-release (re-defer or wontfix before the release ships) and post-promotion (triage the created missions), not a confirmation gate between detection and activation.
_Avoid_: Auto-fix, deployment trigger (when describing the finding activation, not a CI/CD action)

**Release Retrospective**:
A source-tagged analysis pulse emitted when a release is detected and activation runs, recording what shipped, which findings activated, which corrective missions were created, and which were skipped. The retrospective feeds the habitat wiki as a release-log entry and gives humans and agents a queryable record of what a release triggered and why.
_Avoid_: Release notes (when describing the in-system audit pulse, not the external changelog)

**Roadmap**:
The canonical plan for a habitat, expressed as the dependency-ordered structure of its missions. The mission dependency DAG _is_ the roadmap — there is no separate roadmap entity; release-gates and mission dependencies are the blocking conditions that shape what is claimable next. A habitat "follows a release-based workflow" when most of its missions carry release-gates, and "follows a feature-based workflow" when they do not; both are descriptive states of the same DAG, not separate modes.
_Avoid_: Plan, backlog, roadmap entity, roadmap table (when describing the mission DAG as the living plan, not a separate artifact)

**Release Gate**:
A hard blocking condition on a mission that resolves when a matching release ships. A release-gated mission is visible in the roadmap but unclaimable until its target release is detected; resolution makes the mission's tasks available to claim. Release-gates layer alongside mission dependencies as parallel blocking conditions evaluated by the same work-surfacing path. The singular form ("after a release") ships in v0.25.0; the reverse form ("before a release") and the compound window ("after X, before Y") are deferred.
_Avoid_: Release target (when describing the blocking condition on a mission, not a version pin), milestone (when describing Orcy's gate mechanism, not an external tracker's label)

## Example Dialogue

Dev: "This mission shipped through three tasks. Where is the code evidence?"

Domain expert: "The mission rolls up evidence links from its tasks: two pull requests, six commits, changed file snapshots, and one failed then passing pipeline run. The release pull request is direct mission evidence because it spans all tasks. One commit was linked by branch pattern, another was reported from a local worktree, and another was manually linked by a human because it came from a hotfix branch. If the same commit belongs to two tasks, Orcy keeps one commit evidence record and two evidence links. If no one reports off-Orcy work, Orcy shows an evidence gap rather than assuming no code changed. If a link is wrong, Orcy records an evidence correction instead of deleting the original. Orcy stores file path snapshots for history, not full diffs. For time, Orcy separates elapsed lifecycle time from logged effort and inferred heartbeat presence. Audit events explain lifecycle changes, evidence changes, effort corrections, integration sync side effects, and other source-specific histories through one canonical language. Evidence bundles collect references and metadata for a task or mission, not raw source archives."

Dev: "This mission's workflow stalled — what happened?"

Domain expert: "The build task failed, which fired the `on_fail` gate. The workflow's failure handler spawned a recovery task with a Failure Context — including the agent's `stuck` experience signal from 10 minutes before failure. The recovery agent claimed it, called `orcy_get_failure_context` to read what went wrong, fixed the API rate limit issue, and submitted. Recovery Redemption fired — the downstream deploy task's `on_approve` gate satisfied as if the original build had succeeded, and the workflow continued. Two recovery attempts maximum: if the recovery itself had failed at depth 2, you'd see `workflow_recovery_unrecoverable` in the audit trail and a notification would fire for human intervention."
