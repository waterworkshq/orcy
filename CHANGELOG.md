# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.31.10 — 2026-07-16

### Refactors

#### canonicalize feature to mission identifiers across UI and API ([`7623a6a`](https://github.com/waterworkshq/orcy/commit/7623a6a30cbc184e46897644d792a63122843a15))

1. Rename the surviving feature-named identifiers to their canonical mission forms: FeatureCard to MissionCard, FeatureHeader to MissionHeader, onSelectFeature to onSelectMission, addFeatureDependency to addMissionDependency, featureId to missionId in API clients, topFeatures to topMissions (matching server return), makeFeature factories to makeMission, setFeature setters to setMission, ScheduledTaskForm labels and error messages, template variable feature_name to mission_name. G8 (global template name 'Feature') kept as a legitimate category label per user decision.



## 0.31.9 — 2026-07-16

### Refactors

#### rename board method names to habitat, coordinate cache-key literals ([`2550d14`](https://github.com/waterworkshq/orcy/commit/2550d14b1265de4f473fe5d3857d0efde3416c17))

1. Rename the surviving board-named UI methods to their canonical habitat forms: queryKeys.pulse.byBoard to byHabitat (including the cache-key discriminator literal), insights.byBoard to byHabitat, notificationPrefs.board to habitat, getBoardPrefs to getHabitatPrefs, updateBoardPrefs to updateHabitatPrefs, listByBoard to listByHabitat, getBoardMetrics to getHabitatMetrics. All callers updated. Cache-key discriminator literals change deliberately (one-time cache miss, not a bug).


#### rename boardService and boardSecretCache to habitat ([`4cf75db`](https://github.com/waterworkshq/orcy/commit/4cf75db24342dbe6e25d8a1c5fec18be4c4173fc))

1. Rename the two remaining board-named service modules: boardService.ts to habitatService.ts, boardSecretCache.ts to habitatSecretCache.ts. Exports already canonical; all import paths updated including webhook-secret-verification. No behavior change.



## 0.31.8 — 2026-07-16

### Refactors

#### rename board.ts to habitat.ts (schema + repo + factory + shared types) ([`52fa29d`](https://github.com/waterworkshq/orcy/commit/52fa29ddb438518d3d759a8c4e3f9cd641cd0547))

1. Pure file rename + import-path sweep: the 4 legacy board.ts files (db/schema, repositories, test/factories, shared/types) were the last files still named board.ts despite their exports already being canonical (habitats, Habitat, makeHabitat). git mv preserves history; 236 import paths updated. No symbol or behavior change; shared rebuilt before dependents.


#### rename feature.ts to mission.ts (repo + factory + shared types) ([`ea1fe8d`](https://github.com/waterworkshq/orcy/commit/ea1fe8d3eff8c4936d07cf47c8ad2cc8e343b200))

1. Pure file rename + import-path sweep: the 3 legacy feature.ts files (repositories, test/factories, shared/types) were the last feature-named files despite their exports already being canonical (Mission, MissionSummary, etc.). git mv preserves history; 178 import paths updated across 165 files. No symbol or behavior change; shared rebuilt before dependents.
