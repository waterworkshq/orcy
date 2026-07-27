# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.33.2 — 2026-07-27

### Chores

#### bump TypeScript 6.0.3 -> 7.0.2 + Node engines >=22 -> >=24 ([`3567123`](https://github.com/waterworkshq/orcy/commit/35671239808542a5dcb141b315cc1508a77782f6))

1. TypeScript 7.0 (native Go compiler, "Corsa") is stable on the main
2. typescript package. The TS6 migration (v0.22.1) was the bridge that
3. addressed every removed option; TS7 adoption is the version bump +
4. verification. Zero code changes needed.

6. Node engines floor raised from >=22 to >=24 to match CI (already
7. running Node 24). This aligns the stated minimum with reality.



## 0.33.1 — 2026-07-27

### Refactors

#### resolve lint error and auto-fix 265 lint warnings ([`7c927b9`](https://github.com/waterworkshq/orcy/commit/7c927b9326e65dd3cbf16f41969a779f4a0a19d2))

1. Fix the sole lint error (unicorn/no-useless-fallback-in-spread in
2. importAttempts.ts:1067 — redundant ?? {} on a required field) and
3. auto-fix 265 of 373 pre-existing lint warnings via oxlint --fix:

5. 119x unicorn/no-array-sort: .sort() -> .toSorted()
6. 136x eslint/no-unused-vars: removed unused imports and variables
7. 5x unicorn/no-array-reverse: .reverse() -> .toReversed()
8. 4x eslint/preserve-caught-error: added .cause to re-throws
9. 1x unicorn/no-useless-fallback-in-spread (manual fix)

11. Remaining 108 warnings are non-auto-fixable style rules
12. (no-underscore-dangle, consistent-function-scoping, no-shadow) that
13. require case-by-case treatment. All checks green: typecheck, build,
14. 5612 tests, 0 lint errors.



## 0.33.0 — 2026-07-26

### Bug Fixes

#### make routeHandlers mount failure crash-loud (ADR-0041) ([`4e8df0b`](https://github.com/waterworkshq/orcy/commit/4e8df0bd2276ba9ff2c52d1043a10392e87edb4e))

1. Remove the cosmetic try/catch+rollback in initializePlugins: a throwing
2. routeHandlers now propagates as a boot-aborting error. The rollback was
3. theater -- Fastify poisons the instance on register failure, so listen()
4. rejects regardless; the rolled-back getLoadedPlugins() view was never
5. observable. Delete unregisterContributions entirely (zero callers after
6. the rollback removal).


#### reject malformed customHttpRoute method/path at validation ([`a99e33f`](https://github.com/waterworkshq/orcy/commit/a99e33f4da7338edb883ee44cb8af5a34e8dd284))

1. Cold-review blocker: validatePlugin never validated method/path, and the
2. new collision-key construction calls c.method.toUpperCase() unwrapped in
3. the loadPlugins loop -- so a non-string method (e.g. method: 123) threw
4. TypeError and rejected the entire loadPlugins() scan (no pluginErrors
5. entry; later plugins never discovered), with index.ts then logging the
6. misleading 'continuing without plugins'.


#### reject unsupported customHttpRoute methods at validation ([`1448ce9`](https://github.com/waterworkshq/orcy/commit/1448ce9d0694a105d8c913b6ae2d13a7520434e2))

1. F1 was incomplete: it rejected non-string/empty method/path but accepted
2. any non-empty method string. A final cold review proved
3. orphanCheck({method:'TRACE'}) returned null -- contradicting the
4. CustomHttpRouteContribution type union (GET|POST|PATCH|DELETE) and
5. ADR-0041's 'invalid method rejected at load.'

7. Add case-insensitive membership validation over the four supported
8. methods (uppercase before lookup, consistent with the collision key's
9. method normalization): get/GET pass, TRACE/BOGUS reject at validation
10. (never reach collision-key construction or registration). Supported set
11. declared as a module-level Set mirroring the @orcy/shared type union
12. (no shared runtime const exists); keep-in-sync note points to the union.



### Documentation

#### reflect v0.33.0 Plugin Activation Contract delivery + fix plugin-runtime doc drift ([`cd90cc1`](https://github.com/waterworkshq/orcy/commit/cd90cc1f130b84dc201d294073b1420d4ea1c643))



### Features

#### customHttpRoute collision detection at load (ADR-0041) ([`0b7f030`](https://github.com/waterworkshq/orcy/commit/0b7f0306a15f2978cd4813ec09a1ec03d0ea6916))

1. Add customHttpRoute to the load-time collision-detection surface via
2. CATALOG: within-manifest and cross-plugin (method, path) collisions
3. reject the whole plugin at load (mirrors notificationChannel). Method
4. uppercased in the key (matches Fastify case-insensitive method handling);
5. path byte-equal as-declared. customHttpRouteRegistry is collision-only
6. -- Fastify's router owns dispatch.

8. Refreshes ContributionAdapter interface docs to 8 registry kinds.

10. Structural faults are now rejected at load; a later commit makes
11. execution faults (routeHandlers throw at mount) honestly crash-loud.

13. See docs/adr/0041-plugin-activation-contract-structural-at-load-execution-crashloud.md



### Refactors

#### extract plugin boot phase into runPluginBoot for testable crash-loud catches ([`f46f519`](https://github.com/waterworkshq/orcy/commit/f46f519e21367ea6dff10c7c3464517054725de5))

1. Extract the loadPlugins (non-fatal) and initializePlugins (fatal) boot
2. catches from index.ts into runPluginBoot(fastify) in pluginBoot.ts, so
3. the ADR-0041 two-regime contract is unit-testable without spawning the
4. compiled server. index.ts calls runPluginBoot at the same point in the
5. boot sequence (after loadQuarantinesFromDb, before initDaemonWiring);
6. boot order is unchanged.
