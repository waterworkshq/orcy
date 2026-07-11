# orcy

**Roadmap & README** On every feature completion, move the delivered release from "Upcoming" to "Delivered" in `docs/ROADMAP.md` and update the "What's Next" table in `README.md` to reflect current state. The roadmap is a living document — stale roadmap misleads everyone.

**Releases** Managed via `release-it` + `git-cliff`. Run `pnpm release:patch` for patches, `pnpm release:minor` for minor releases, or `pnpm release:major` for major releases to auto-bump version, generate CHANGELOG.md (3 entries max), tag, push, and create GitHub Release. Do not manually create tags or releases. Use `pnpm release:dry` to preview. Config: `.release-it.json`, `cliff.toml`.

**Package Manager** Project uses pnpm package manager, so always use `pnpm` not `npm`, `bun` or any other.

**Memory specific HARD requirement** Maintain a growing memory for the tracking of decisions, lessons, risks, and high signal items in the project in the `docs/plans/MEMORY.md` file. This must contain specific high signal items that are important to remember like DECISIONS, LEARNINGS, RISKS etc. This will grow alongside the implementation scratchpad of the project(`docs/plans/SCRATCHPAD.md`) and can be referenced and maintained throughout the project but not commited. **The MEMORY.md is not to be used for implementation details or hallucinated by you, it is strictly to maintain a high signal reference for the project.**

**Implementation Scratchpad** Use the file `docs/plans/SCRATCHPAD.md` to record various brainstorm ideas, outline implementation approaches, and experiment with solutions during work. This can and should also record any implementation details during the actual work. This is a safe space for capturing implementation time working, testing hypotheses and exploring different strategies without affecting the production documentation. This should not be tracking decisions, learnings, or risks — those belong in `docs/plans/MEMORY.md`. **The SCRATCHPAD.md is not to be used for capturing anything other than implementation details.**

**Dont rush into making commits.** The commits have to be stritcly given permission for before you start making them or if they are a part of the plan.

**Dont commit any planning artifacts** The planning artifacts (like plans, roadmaps, etc.) should not be committed to the repository. They should be kept in the `docs/plans/` directory and maintained as planning/implementation artifacts.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **orcy** (15019 symbols, 41583 relationships, 257 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/orcy/context` | Codebase overview, check index freshness |
| `gitnexus://repo/orcy/clusters` | All functional areas |
| `gitnexus://repo/orcy/processes` | All execution flows |
| `gitnexus://repo/orcy/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
