# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.36.1 — 2026-08-09

### Bug Fixes

#### strip field-level .default() from patch sub-schemas + extract publishHabitatUpdate helper ([`cf0da86`](https://github.com/waterworkshq/orcy/commit/cf0da86e42ce9248500eeed04e4f1be9820403c9))




- Remove .default() from anomalySettingsSchema and autoAssignSettingsSchema   sub-fields so partial PATCHes don't silently reset unspecified fields to   Zod-injected defaults before the service deep-merge runs (CS-20)




- Remove .default(false) from codeReviewSettingsSchema.autoApproveOnMerge —   same data-loss pattern




- Extract publishHabitatUpdate(habitatId, habitat) helper in habitatService   centralizing mask + cache rebuild + SSE broadcast; route all 3 habitat-   change paths through it so side effects stay consistent (CS-21)





## 0.36.0 — 2026-08-07

### Documentation

#### add v0.36.0 release notes + sync ROADMAP/README ([`cd9438d`](https://github.com/waterworkshq/orcy/commit/cd9438d79f73d665b8324b7cebd35ef29d4a2f48))



### Refactors

#### deepen public Habitat transport contract across server, MCP, and shared types (#3) ([`82b4949`](https://github.com/waterworkshq/orcy/commit/82b49490acf7e7187a04706463d2ac1f5d01645c))




- refactor: deepen public Habitat transport contract across server, MCP, and shared types




- Consolidate server habitat update input: Zod schema is now the single source of truth via z.infer<typeof updateHabitatSchema>, widening the service from 7 to 11 fields and eliminating the `as` cast at the route boundary; repo keeps its broader 16-field type for internal callers




- Fix two stale-UI bugs: roadmap focus-goal and prioritization rules routes now broadcast habitat.updated SSE (roadmap routes through the widened service; prioritization and wiki scheduler add explicit SSE broadcasts)




- Align MCP to PublicHabitat: replace raw secret-bearing Habitat return types with masked PublicHabitat, delete the 6-field HabitatSettings type-lie, and rename legacy boardId parameters to habitatId




- Remove dead updateHabitatSettings MCP tool: the tool 401-ed on every call (PATCH route is humanAuth, MCP authenticates as agentAuth); scoped sub-routes remain the pattern for future agent write needs




- Fix pre-existing type gaps surfaced by z.infer: add missing Zod defaults to release/roadmap/anomaly settings schemas, make secret fields optional in CodeReviewSettings/CiCdSettings interfaces, and add critical_path to the roadmap scoring algorithm enum




- Add contract tests: MCP masking boundary (4 tests with negative proof), SSE broadcast verification (2 tests), and a compile-time drift guard asserting UpdateHabitatInput equals z.infer




- fix: rename boardId to habitatId in habitatGetMetrics handler




- Missed during the C9 boardId→habitatId rename in the orcy_habitat dispatch tool — habitatGetMetrics lives in lifecycle-gaps.ts, not habitat.ts, and was the only handler not updated. Without this fix, the metrics action sends undefined as the habitat ID.




- refactor: wire HabitatListItem type into list/find MCP handlers




- Replace inline {id, name, description} object projections with the shared HabitatListItem type alias, following the extract-on-2+ convention.




- fix: address PR review feedback — settings merge, test quality, missed schema




- Remove .default() from release/roadmap/anomaly settings sub-schemas to   prevent silent field reset on partial PATCH; add deep-merge for all   settings blobs in habitatService.updateHabitat so unspecified fields   preserve their existing stored values




- Add payload masking assertions to SSE contract tests (verify   hasGithubSecret present, githubSecret absent on broadcast data)




- Restructure always-green negative-proof masking test into a real   pass-through guard that fails if masking is added to the MCP handler




- Rename boardId to habitatId in BOARD_GET_METRICS_TOOL schema (missed   during the HabitatClient rename — handler was already updated)




- Add caveat comment to drift guard acknowledging its tautology limitation




- docs: update MCP usage skill for orcy_habitat tool contract changes




- Remove stale update-settings example (action deleted) and rename boardId to habitatId in all orcy_habitat examples (sharedParams renamed in T4). Other tools' boardId usage preserved — only the habitat dispatch tool was renamed.




- ---------





## 0.35.4 — 2026-08-07

### Chores

#### notification write scope for ack/snooze + linked-identity recipient dedup ([`146b0f1`](https://github.com/waterworkshq/orcy/commit/146b0f117210e568247378c68800e1b2b4e81add))




- Add a dedicated notification.write scope for notification ack/snooze endpoints (previously read, asymmetric with all other POST routes that carry write scopes) and dedup remote notification recipients by externalIdentityId so the same linked identity across pods or records receives one delivery instead of duplicates.





### Documentation

#### add v0.35.3 release notes ([`6281a35`](https://github.com/waterworkshq/orcy/commit/6281a3558f6ac101ac73d8e810df61af41ce10bd))


#### mark v0.35.3 delivered ([`b70ebfb`](https://github.com/waterworkshq/orcy/commit/b70ebfbe95be4cc8445a24495019534bf3454eb5))


#### add v0.35.4 release notes + sync ROADMAP/README ([`40552d3`](https://github.com/waterworkshq/orcy/commit/40552d3dc5213062d04631ac6c11ed3445e5e736))




- Three-piece patch release: notification.write scope for ack/snooze, linked-identity recipient dedup, and stale deferred-doc cleanup.
