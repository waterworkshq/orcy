# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.22.14 — 2026-06-30

### Refactors

#### consolidate AgentAvatar, add priority indicators and a11y improvements ([`ff1d595`](https://github.com/waterworkshq/orcy/commit/ff1d5958f78a2d3219647fb56ac1003e38cfefbf))

1. Extract AgentAvatar into a shared component used by TaskCard, TaskCardList, and TaskTableColumns to replace duplicate inline implementations. The component accepts a fallback prop for customizable null states.

3. Add priority-colored left borders to TaskCardList items using the new PRIORITY_BORDER_CLASS mapping. Display rejectedCount badges with ↩ indicator when rejections exist.

5. Memoize selectedIds as a Set in TaskCardList to optimize selection lookups. Add sorting indicator to mobile card view. Add aria-labels to SprintSelector and drag handles in PrioritizationTab for screen reader compatibility.

7. Update tests to mock AgentAvatar and use CSS class selectors instead of title attributes for deterministic assertions.



## 0.22.13 — 2026-06-30

### Refactors

#### optional scheduleType, deduplicate getHabitatId, export BadgeVariant ([`1d58a59`](https://github.com/waterworkshq/orcy/commit/1d58a59a95c2f99cd98600eb5246d434988f4ee5))

1. Make scheduleType optional in WikiSettings and SetCadenceInput, moving validation
2. into schema refine so it's only required when enabled is true. Extract currentHabitatId
3. once in approveTask instead of calling getHabitatId multiple times.

5. Replace JSON.parse(JSON.stringify) with structuredClone in MCP config writing.
6. Simplify duration parsing by removing the redundant ms-unit guard in parseDurationWindow.

8. Switch tests to vi.useFakeTimers for deterministic clock control instead of spin-waiting.
9. Export BadgeVariant from Badge.tsx and import it in formatting.ts and MissionCard to
10. remove the `as any` type cast. Apply consistent single-quote formatting across
11. affected UI files and remove DOM.Iterable from ui tsconfig.



## 0.22.12 — 2026-06-29

### Bug Fixes

#### shared write cap counter, action quarantine, PluginRun type widening ([`06c37aa`](https://github.com/waterworkshq/orcy/commit/06c37aa5622974d2f51138eb3dba21db21823dc7))

1. Code review fixes for the plugin extraction arc (v0.22.8–v0.22.11):
