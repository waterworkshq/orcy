# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.11.3 — 2026-05-21

### Bug Fixes

#### unique reviewer constraint, sprint overlap validation, human-readable email events, empty email null coercion ([`db1268e`](https://github.com/waterworkshq/orcy/commit/db1268e469962f48beb51012bb0be8ed3d105ab5))

1. P0-5: Add unique index on (task_id, reviewer_id) via migration 0012
2. P0-13: Add composite index (task_id, status) on task_reviewers
3. P2-13: Sprint date overlap validation via getOverlappingForHabitat
4. P3-11: EVENT_TYPE_LABELS mapping for human-readable watching emails
5. P3-13: updateUserEmail coerces empty string to null



## 0.11.2 — 2026-05-21

### Bug Fixes

#### address remaining review issues — 35 fixes across 7 batches ([`248f21d`](https://github.com/waterworkshq/orcy/commit/248f21d059a8ee44f838a0197a6b8be837b51c5f))

1. Backend services:
2. Remove status from SprintUpdateInput (P2-5)
3. Add endDate > startDate validation in createSprint (P0-8)
4. Fix carryOverPolicy as any cast (P0-12)
5. Add CAS-style status guard in completeSprint (P2-3)
6. Sort findNextPlanningSprint by startDate (P2-10)
7. Fix burndown endDate to use sprint end date (P2-7)
8. Remove dead code in predictionService (P2-9)
9. Add race condition guard in approveTask (P1-4)
10. Use requiredCount in hasAllRequiredApprovals (P1-7)
11. Add idempotency to recordApproval (P1-11)
12. Fix isSelfApproval to be dynamic (P1-15)
13. Notify task assignee on priority change (P3-3)
14. Pass commentContent for mentioned notifications (P3-5)
15. Parallel email dispatch with Promise.allSettled (P3-6)
16. Add Zod date validation on sprint routes (P2-6)



## 0.11.1 — 2026-05-21

### Bug Fixes

#### enforce antiSelfReview, refactor ReviewRulesTab to React Query, optimize SprintDashboard ([`28543aa`](https://github.com/waterworkshq/orcy/commit/28543aa84e133d2b8a9d2d256bb3e679634cfc64))

1. Enforce antiSelfReview: exclude task creator from reviewer pool when flag enabled
2. ReviewRulesTab: replace manual useState+useEffect with useQuery/useMutation
3. and centralized queryKeys.reviewRules
4. SprintDashboard: shallow comparison on store selectors, useMemo for derived
5. data, fix velocity calculation (Math.floor), extract TERMINAL_STATUSES constant
