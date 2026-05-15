<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **orcy** (8672 symbols, 13926 relationships, 299 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/orcy/context` | Codebase overview, check index freshness |
| `gitnexus://repo/orcy/clusters` | All functional areas |
| `gitnexus://repo/orcy/processes` | All execution flows |
| `gitnexus://repo/orcy/process/{name}` | Step-by-step execution trace |

<!-- gitnexus:end -->

**Roadmap & README** On every feature completion, move the delivered release from "Upcoming" to "Delivered" in `docs/ROADMAP.md` and update the "What's Next" table in `README.md` to reflect current state. The roadmap is a living document — stale roadmap misleads everyone.

**Releases** Managed via `release-it` + `git-cliff`. Run `pnpm release` (patch), `pnpm release:minor`, or `pnpm release:major` to auto-bump version, generate CHANGELOG.md (3 entries max), tag, push, and create GitHub Release. Do not manually create tags or releases. Use `pnpm release:dry` to preview. Config: `.release-it.json`, `cliff.toml`.

**Package Manager** Project uses pnpm package manager, so always use `pnpm` not `npm`, `bun` or any other.

**Memory specific HARD requirement** Please maintain a growing memory for the overall work being done in the project in the docs/plans/MEMORY.md file. This must contain a summary of the work and specific high signal items that are important to remember like DECISIONS, LEARNINGS, RISKS etc. This will grow alongside the implementation of the project and must be referenced and maintained throughout the project but not commited.

**Dont rush into making commits.** The commits have to be stritcly given permission for before you start making them or if they are a part of the plan.
