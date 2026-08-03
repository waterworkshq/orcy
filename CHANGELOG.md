# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.34.3 — 2026-08-03

### Refactors

#### derive task-dispatch action metadata from one field-descriptor declaration ([`5eebb2c`](https://github.com/waterworkshq/orcy/commit/5eebb2cbd05c17b1bc64fb1c71bb724b75804d7d))



### Tests

#### lock orcy_habitat_task agent-visible behavior (firewall characterization) ([`5d2909c`](https://github.com/waterworkshq/orcy/commit/5d2909cd160b7e257e0efe90f35c12822c43be2e))



## 0.34.2 — 2026-08-03

### Bug Fixes

#### replace review-dispatch private requireArgs with canonical requiredFor map ([`8dd57d8`](https://github.com/waterworkshq/orcy/commit/8dd57d8dea579886825397dffc549b3783272654))



### Documentation

#### add v0.34.1 release notes ([`73a3f93`](https://github.com/waterworkshq/orcy/commit/73a3f9380e621627f24ffb4042437b224cdb2901))



## 0.34.1 — 2026-08-02

### Bug Fixes

#### remove dead requiredFor from DispatchToolConfig + fix set_focus_mission validation ([`5241507`](https://github.com/waterworkshq/orcy/commit/524150715d854da186a1a27d6cbf86cfb92964b6))

1. Bug 1: DispatchToolConfig.requiredFor was a dead field — createDispatchTool
2. never reads it. Only triage populated it, creating a misleading duplicate
3. of the live createDispatchHandler validation map. Removed the field from the
4. interface and deleted triage's dead declaration.

6. Bug 2: triage set_focus_mission's live handler validation required missionId,
7. but the handler explicitly supports omit/null to clear the habitat focus.
8. An agent calling set_focus_mission without missionId was rejected before the
9. handler ran — the 'clear focus' capability was unreachable through MCP.
10. Fixed by removing missionId from the requiredFor map for set_focus_mission.

12. Added two regression tests: omit-path (no missionId key) and explicit-null
13. path (missionId: null) both reach the handler without validation rejection.



### Documentation

#### trim release notes — remove internal process details ([`e6918c7`](https://github.com/waterworkshq/orcy/commit/e6918c760d134272513eb22c8cbeec06f7ae4624))
