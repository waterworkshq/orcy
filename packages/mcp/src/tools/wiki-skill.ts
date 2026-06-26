import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Rendered skill guide instructing agents on the Habitat Wiki authoring protocol. */
export const WIKI_SKILL_TEXT = `# Wiki Skill Guide — Habitat Knowledge Authoring

The Habitat Wiki is an authored, versioned, searchable knowledge layer. It sits above
the habitat's primitives — pulses, signals, insights, skills, evidence — and lets you
synthesize them into long-form curated prose. The wiki does NOT auto-generate; every
page is authored by an orcy (human or agent).

## When to Author Wiki Pages

- After completing a mission, author a page summarizing what was learned, what conventions
  were discovered, and what pitfalls others should avoid.
- When you notice patterns across tasks (recurring issues, domain conventions, architecture
  decisions), author a page that synthesizes them.
- When existing primitives (pulses, insights, skills) tell a fragmented story that would
  benefit from a single coherent narrative.

## When NOT to Author

- Don't author a page that just duplicates what's already in pulses, insights, or habitat skills.
- Don't author a page for a single task — author pages that synthesize across tasks/missions.
- Don't forget to cite sources — every page should link to the primitives it synthesizes.

## Reading the Wiki

Use the \`orcy_wiki\` MCP tool:

- **\`search\`** — full-text search across published pages. Use before starting work in
  an unfamiliar area.
- **\`get_page\`** — read a specific page with resolved citations.
- **\`list_pages\`** — browse the page tree.
- **\`get_signal_surface\`** — check what agents struggle with (experience patterns,
  aggregated and privacy-protected) and what engineering findings exist before starting
  work in a domain. Pass \`signalClass: "both"\` to get patterns + findings in one call.

## Authoring Workflow

1. **Fetch context first.** Call \`get_authoring_context\` before writing.
   - For an existing page (provide \`pageId\`): returns deltas — primitives that changed
     since the page's last version.
   - For a new page (provide \`from\` + \`to\` dates): returns all primitives in that
     time window.
2. **Write the page.** Call \`create_page\` (new) or \`save_version\` (existing).
   Include \`editSummary\` for existing pages.
3. **Cite your sources.** Call \`add_link\` for each primitive the page synthesizes.
   Target types: \`mission\`, \`task\`, \`pulse\`, \`insight\`, \`skill_signal\`,
   \`commit\`, \`pull_request\`, \`evidence_link\`, \`external_issue\`.
4. **Publish when ready.** Call \`update_metadata\` with \`status: "published"\`.

## Coverage and the Cadence

The wiki has a habitat-wide cadence that periodically spawns authoring tasks. When you
claim a cadence-spawned task, it will include a time chunk (date range) to cover.

- Author the page(s) covering that period using the chunk context.
- If you evaluate a period and determine nothing worth authoring, call
  \`mark_no_update_needed\` with the date range and a reason. This advances the
  coverage watermark without producing a page.

## Versioning

- Every save creates an append-only version snapshot. Don't worry about losing prior
  wording — it's preserved.
- To restore an old version, use \`restore_version\`. This creates a NEW version with
  the old content. History is never rewritten.
- Draft status lets you save work-in-progress without publishing.

## Engineering Findings

When you surface a codebase observation during implementation work (pre-existing bug,
scope gap, integration breakage, undocumented convention), post it as a structured
finding via \`orcy_pulse\` with \`signalType: "finding"\` and the required metadata:

- \`findingKind\`: \`pre_existing_bug\`, \`scope_gap\`, \`approach_deadend\`,
  \`undocumented_convention\`, \`deferred_fix_candidate\`, \`schema_missing\`,
  \`integration_broken\`, \`other\`
- \`severity\`: \`low\`, \`medium\`, \`high\`, \`critical\`
- \`affectedFiles\`: array of file paths
- \`blocksCurrentWork\`: boolean

When in doubt, post structured. Free-form findings are accepted but do not surface in
the wiki Findings tab's structured section.
`;

/** MCP `Tool` registration for `orcy_wiki_instructions`; on call, returns the rendered Wiki skill guide. */
export const WIKI_SKILL_TOOL: Tool = {
  name: "orcy_wiki_instructions",
  description:
    "Teaches the Habitat Wiki authoring protocol: when to author pages, how to use the " +
    "orcy_wiki tool (search, read, author, version, link, signal surface, cadence), " +
    "coverage markers, and the structured engineering finding convention. " +
    "Use when you want to author or update wiki knowledge, when you need to understand " +
    "the authoring augmentation context, or when you want to learn the finding metadata convention.",
  inputSchema: { type: "object", properties: {} },
};

/** Returns the rendered Wiki skill guide text for the `orcy_wiki_instructions` MCP tool. */
export function getWikiSkillText(): string {
  return WIKI_SKILL_TEXT;
}
