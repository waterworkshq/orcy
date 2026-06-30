# orcy

**Roadmap & README** On every feature completion, move the delivered release from "Upcoming" to "Delivered" in `docs/ROADMAP.md` and update the "What's Next" table in `README.md` to reflect current state. The roadmap is a living document — stale roadmap misleads everyone.

**Releases** Managed via `release-it` + `git-cliff`. Run `pnpm release:patch` for patches, `pnpm release:minor` for minor releases, or `pnpm release:major` for major releases to auto-bump version, generate CHANGELOG.md (3 entries max), tag, push, and create GitHub Release. Do not manually create tags or releases. Use `pnpm release:dry` to preview. Config: `.release-it.json`, `cliff.toml`.

**Package Manager** Project uses pnpm package manager, so always use `pnpm` not `npm`, `bun` or any other.

**Memory specific HARD requirement** Maintain a growing memory for the tracking of decisions, lessons, risks, and high signal items in the project in the `docs/plans/MEMORY.md` file. This must contain specific high signal items that are important to remember like DECISIONS, LEARNINGS, RISKS etc. This will grow alongside the implementation scratchpad of the project(`docs/plans/SCRATCHPAD.md`) and can be referenced and maintained throughout the project but not commited. **The MEMORY.md is not to be used for implementation details or hallucinated by you, it is strictly to maintain a high signal reference for the project.**

**Implementation Scratchpad** Use the file `docs/plans/SCRATCHPAD.md` to record various brainstorm ideas, outline implementation approaches, and experiment with solutions during work. This can and should also record any implementation details during the actual work. This is a safe space for capturing implementation time working, testing hypotheses and exploring different strategies without affecting the production documentation. This should not be tracking decisions, learnings, or risks — those belong in `docs/plans/MEMORY.md`. **The SCRATCHPAD.md is not to be used for capturing anything other than implementation details.**

**Dont rush into making commits.** The commits have to be stritcly given permission for before you start making them or if they are a part of the plan.

**Dont commit any planning artifacts** The planning artifacts (like plans, roadmaps, etc.) should not be committed to the repository. They should be kept in the `docs/plans/` directory and maintained as planning/implementation artifacts.
