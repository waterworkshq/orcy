# Orcy — Documentation Review

# Critical Issues, Cross-Document Inconsistencies, and Recommendations

**Review Date:** April 2, 2026  
**Reviewer:** System Architect  
**Documents Reviewed:** 01-PRD.md, 02-SPEC.md, 03-PLAN.md, SKILL.md  
**Status:** ✅ ALL CRITICAL ISSUES FIXED — READY FOR BUILD

---

## Fixes Applied

All 5 critical issues and all 5 important issues have been resolved:

| # | Issue | Fix Applied |
|---|-------|-------------|
| C1 | Stale timeout mismatch (PRD=5min, SPEC/SKILL=2h) | Unified to **30 minutes** in PRD NFR-2.4, SPEC Section 8.2, SKILL.md |
| C2 | Missing `POST /api/tasks/:id/claim` REST endpoint | Added to SPEC Section 4.2 Task Lifecycle endpoints |
| C3 | `done` status wrongly allowed in `board_update_task_status` | Removed `done`; added note that only `submit` leads to `submitted`, only `approve` leads to `done` |
| C4 | `EXPONIENTIAL_BACKOFF` typo in Conductor workflow | Fixed to `EXPONENTIAL_BACKOFF` in SPEC Section 6.1 |
| C5 | Human auth unspecified | Defined as **JWT Bearer token** in PRD NFR-3.5 and SPEC Section 4.1 |
| C6 | Human auth scheme not in PRD | Added NFR-3.5 to PRD |
| C7 | Phase 4 dependency on Phase 3 unclear | Updated PLAN Section 5.4 with clarification |
| C8 | SQLite not equivalent to SKIP LOCKED | Added caveat in SPEC Section 8.1; SQLite is dev-only |
| C9 | `rejectionReason` not highlighted in context | Added explicit note in SPEC Section 5.2 and SKILL.md rejection flow |
| C10 | SKILL.md created twice (P2.12 and P6.9) | Removed P6.9, P2.12 now creates docs/SKILL.md |

### Additional Fixes

- Added FR-3.6 note defining failure trigger (agent-reported or Conductor timeout)
- Added PRD glossary entries for "Stale Task" and "JWT Bearer Token"
- Added `board_check_task_status` guidance in SKILL.md (agent calls `board_get_task_context` to poll status)
- Renamed P2.12 output from `docs/AGENTS.md` → `docs/SKILL.md`

---

## Updated Summary Scores

| Document | Score | Verdict |
|----------|-------|---------|
| PRD | 9/10 | Solid product vision. All requirements consistent. |
| SPEC | 9/10 | Complete architecture. All bugs fixed. |
| PLAN | 9/10 | Realistic phases. All cross-doc issues resolved. |
| SKILL | 9/10 | Clear agent guidance. Rejection flow fixed. |

**Overall: ✅ READY FOR BUILD**
