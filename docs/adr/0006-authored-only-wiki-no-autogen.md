# Authored-Only Wiki; Auto-Write Deferred to Learning Loop

Status: accepted · 2026-06-25

## Context

The v0.21 "Living Library" release introduces a Habitat Wiki — an authored knowledge layer above Orcy's existing primitives. It is an input/draft-surfacing mechanism where generated material feeds a human or agent author who then writes the page.

`learning-loop-data-extraction` is explicitly a future cross-cutting release whose **Extraction targets** list includes *"wiki draft suggestions"*. Seed 12 is where extraction/auto-write belongs.

The design question: **does v0.21 auto-write any wiki content, or is every page authored by a human or agent orcy with the scheduler only spawning authoring work?**

## Decision

**v0.21 ships authored-only wiki pages. Every page is written by a human or agent orcy. The scheduler (reusing v0.9 `scheduled_tasks` + v0.20 mission templates) spawns time-chunked authoring tasks that an orcy claims and authors — the scheduler never writes content. Generated material (mission outcome summaries, skill documents, derived aggregates) is treated as just another primitive input to the author, identical in treatment to pulses, signals, insights, evidence, and effort entries.**

Auto-write, auto-extraction, auto-promotion, and "wiki draft suggestions from history" are deferred to seed 12 (Learning Loop).

## Rationale

- **Resolves the seed 10 bullet 6 ambiguity cleanly.** Treating generated material as a primitive input (one row in the augmentation surface alongside all the others) makes bullet 6 consistent with the rest of seed 10's "authored layer above primitives" framing, without requiring any auto-write machinery.
- **Keeps v0.21 scope honest.** Auto-write is a categorically different capability from authoring — it requires extraction sources, citation models, confidence thresholds, feedback-loop prevention, and human review queues (all enumerated in seed 12 §Initial Scope). Shipping it under v0.21 would silently turn a knowledge-layer release into an extraction release.
- **Preserves the authored value proposition.** The wiki's reason for existing is that human/agent synthesis produces something the auto-generated surfaces cannot: long-form, cross-referenced, curated narrative. Auto-written pages would dilute that signal and create a "is this actually curated?" trust question for readers.
- **Matches the CONTEXT.md glossary boundary.** **Learning Loop** is already defined as *"a future Orcy capability where trusted history and outcomes are extracted into reusable knowledge, recommendations, rules, or agent context."* That is precisely the auto-write surface; it is correctly reserved for seed 12.
- **Consistent with agent-as-author.** Agent authoring is not auto-write — an agent orcy claims an authoring task and writes the page like a human would, making the same editorial decisions. The CAPS-clarified boundary during grilling: "self-authoring by an agent or human, not any form of autogen as of now."
- **Reusable scheduling machinery.** The scheduler does not need new infrastructure — it reuses v0.9 `scheduled_tasks` and v0.20 `mission_templates`. The only new artifact is a template type for wiki-authoring tasks. This pattern is already proven for feature creation and recurring tasks.

## Alternatives considered

- **Auto-generate draft pages from mission outcomes (seed 10 bullet 6 read literally).** Rejected:
  - Creates page rows without author intent — rows that may never be edited, cluttering the wiki with low-quality drafts.
  - Requires extraction logic (what to include, how to phrase, how to cite) that belongs to seed 12.
  - Breaks the "authored layer above primitives" model by making the system itself an author.

- **Ship a "wiki draft suggestions" feature in v0.21.** Rejected:
  - Explicitly listed as a seed 12 extraction target. Pulling it into v0.21 would either delay v0.21 or ship a half-built extractor.
  - Requires the citation/confidence/review infrastructure seed 12 is scoped to design.

- **Metadata-only convention on existing primitives instead of a wiki.** Rejected:
  - Does not solve the long-form authored knowledge problem. Adding structure to findings/signals makes them more queryable but does not produce curated narrative.

## Consequences

- `wiki_pages` rows always have a non-null `created_by` pointing to a human or agent orcy. There is no `source='system_generated'` authorship path in v0.21.
- The scheduler integration produces *task* rows (via `scheduled_tasks` + a new template type), not `wiki_pages` rows. Tasks are claimed and authored normally.
- Generated/derived material (mission summaries, skill documents) joins the list of primitives consumed by Authoring Augmentation (see CONTEXT.md) — no special status, no special persistence, no auto-row creation.
- ADR-0008 (Scheduler Spawns Authoring Tasks) depends on this ADR and exists to protect this boundary from scheduler drift.
- Seed 12 may later introduce auto-written drafts as a *feed into* this authored layer. The authored-only model in v0.21 does not block that — it leaves the door open by treating today's primitives and tomorrow's auto-drafts uniformly as author inputs.
- Reviewers and readers can trust that every v0.21 wiki page was deliberately authored by an orcy.
