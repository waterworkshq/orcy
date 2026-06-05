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
