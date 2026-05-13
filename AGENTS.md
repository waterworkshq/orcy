<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **orcy** (8672 symbols, 13926 relationships, 299 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

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

**Roadmap & README** On every feature completion, move the delivered release from "Upcoming" to "Delivered" in `docs/ROADMAP.md` and update the "What's Next" table in `README.md` to reflect current state. The roadmap is a living document — stale roadmap misleads everyone.

**Releases** Managed via `release-it` + `git-cliff`. Run `pnpm release` (patch), `pnpm release:minor`, or `pnpm release:major` to auto-bump version, generate CHANGELOG.md (3 entries max), tag, push, and create GitHub Release. Do not manually create tags or releases. Use `pnpm release:dry` to preview. Config: `.release-it.json`, `cliff.toml`.

**Package Manager** Project uses pnpm package manager, so always use `pnpm` not `npm`, `bun` or any other.
**Memory specific HARD requirement** Please maintain a growing memory for the overall work being done in the project in the docs/plans/MEMORY.md file. This must contain a summary of the work and specific high signal items that are important to remember like DECISIONS, LEARNINGS, RISKS etc. This will grow alongside the implementation of the project and must be referenced and maintained throughout the project but not commited.

**Dont rush into making commits.** The commits have to be stritcly given permission for before you start making them or if they are a part of the plan.
