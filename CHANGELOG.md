# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.44.2 — 2026-10-17

### Bug Fixes

#### validate stored permissions in role detail reads ([`e2c27ad`](https://github.com/waterworkshq/orcy/commit/e2c27ad9689bcbe3dcea8446a72cba0795138a71))


#### validate stored permissions in role detail reads ([`b544b4d`](https://github.com/waterworkshq/orcy/commit/b544b4dbf47d95ef7d20cdd97e0783fe92853daf))




- Reuse guarded stored-permission parsing for role detail reads, authorize custom namespaces before parsing, and pin safe validation and denial responses for every malformed fixture.




#### validate reviewer types before client calls ([`3776183`](https://github.com/waterworkshq/orcy/commit/377618322de9822136a520993cf78dbf9d37eae1))


#### validate reviewer types before client calls ([`48befb0`](https://github.com/waterworkshq/orcy/commit/48befb07d8b58e4abef66fcddc4e6ef647dc1f97))




- Advertise and enforce human or agent reviewer types before client calls, preserve omission-to-human compatibility, and document the roster token format and source.





### Chores

#### remove unused import custody helpers ([`bbc53b9`](https://github.com/waterworkshq/orcy/commit/bbc53b9fbcced2723bb3afa54d4b4eee3fcdd60e))


#### remove unused import custody helpers ([`1cadf73`](https://github.com/waterworkshq/orcy/commit/1cadf7347e989f7168e649c7cfcddba277cb1126))




- Remove the unused import-domain custody helper and its otherwise-unused traversal while retaining the restore-aware publication path.




#### ignore local dot directories ([`90613e7`](https://github.com/waterworkshq/orcy/commit/90613e7c79a2fbf15a2cc9c965cbb3a2fcbccd51))



### Documentation

#### record v0.44.1 delivery ([`6f3d974`](https://github.com/waterworkshq/orcy/commit/6f3d974321405ffd1a95f7592c4b89da896d849c))




- Record the test-only patch release in the roadmap, product next steps and capability register while preserving the v0.44.0 runtime contract.




#### define unknown custody audit attribution ([`1099b8b`](https://github.com/waterworkshq/orcy/commit/1099b8b69c363ee99393790469b63a9ed6d556d6))


#### define unknown custody audit attribution ([`d0aa6ff`](https://github.com/waterworkshq/orcy/commit/d0aa6ffb4f8022d63ce584e8141aacf01f6356f4))




- Define the retained unknown custody-attribution sentinel and its consumer projection and count filters, with real audit-row coverage that preserves history.




#### clarify reviewer roster token requirements ([`b25a15d`](https://github.com/waterworkshq/orcy/commit/b25a15ddcefaa24093c627a407cca5ab3a5f7d97))


#### add v0.44.2 operator notes ([`268d285`](https://github.com/waterworkshq/orcy/commit/268d2854c6a035f3d2ef638e5140f5d1038183cf))



### Tests

#### pin redaction for every malformed permission fixture ([`c3bd41d`](https://github.com/waterworkshq/orcy/commit/c3bd41d82443e5d06e661cc3000d4d8aaa5b0cc6))


#### report race worker failures promptly ([`bcf0c1e`](https://github.com/waterworkshq/orcy/commit/bcf0c1ef9e4d2ace77834d38c2c39c8190737180))


#### report race worker failures promptly ([`6b23c3b`](https://github.com/waterworkshq/orcy/commit/6b23c3bc2fd5fd4a12d5cfc88838f27faa2d954f))




- Detect governance race-worker code, signal, and process failures while waiting for markers, include bounded diagnostics, and verify child cleanup.





## 0.44.1 — 2026-10-14

### Documentation

#### record v0.44.0 delivery and release verification ([`3bbec47`](https://github.com/waterworkshq/orcy/commit/3bbec47a7cff0bf5c824f020284b827411674792))




- Mark scoped roles and governed review management as shipped, update the roadmap version and product next steps, and promote the bounded administration and review capabilities to Available after the managed release completed.




#### add v0.44.1 operator notes ([`2743a0e`](https://github.com/waterworkshq/orcy/commit/2743a0e8864599501a0d3f0c34e2f8d06c932fbb))




- Document test-only regression coverage for database proof constraints, current remote authority, recovery, contention, legacy repair and triage UI contracts, with verification boundaries and no operator action.





### Tests

#### cover SQL proof constraints and stale remote authority ([`03e15fd`](https://github.com/waterworkshq/orcy/commit/03e15fde5a95d75c93e57b9cb8a71c01f6f0b385))




- Add direct constraint rejection and valid controls for release epoch pairing and proved checkpoint fields. Verify that persisted credential expiry and hard grant revocation invalidate stale authority snapshots, with five discriminating fault checks and existing fixtures.




#### strengthen recovery, contention and triage UI coverage ([`f47f174`](https://github.com/waterworkshq/orcy/commit/f47f174b8100872f27beac6b181efa2b92f532f1))




- Pin proved-resume exemptions, single-attempt writer contention and legacy repair replay with current fixtures and positive controls. Extend triage request, deferred-backlog and form-reset coverage with discriminating checks while keeping production behavior unchanged.





## 0.44.0 — 2026-10-14

### Bug Fixes

#### address scoped governance review findings ([`61ecdb8`](https://github.com/waterworkshq/orcy/commit/61ecdb86e12e0309e7d4a7a572d8c061cf618579))




- Repair restore-mode scope reenrollment, canonical task deletion, custody attribution and ledger versions, reviewer mutation admission, and supplied concurrency validation. Strengthen client forwarding and behavioral test discriminators, update transaction mock seams, and reconcile the managed authorization documentation.




#### recheck persisted Team governance inside writes ([`b2dd5c4`](https://github.com/waterworkshq/orcy/commit/b2dd5c4a796970a36615a3774b2e29ce1ced8f70))




- Use current persisted human governance during Team deletion and membership mutations on the same IMMEDIATE transaction client. Preserve versionless inputs and error ordering, document the authority boundary, and add production SQLite and HTTP acceptance coverage for stale credentials and reservation-time authority loss.




#### enforce persisted Team governance at write boundaries ([`4e0b3c9`](https://github.com/waterworkshq/orcy/commit/4e0b3c9f36c881b2db822a9eea43bf920efee988))




- Merge current persisted human governance checks for Team deletion and membership mutations, with transaction-bound operations, production acceptance coverage, and corrected API documentation.





### Documentation

#### record v0.43.0 delivery and release verification ([`5982920`](https://github.com/waterworkshq/orcy/commit/59829208419b52f4399e8ff979bc4eaa5ab3b81d))




- Mark delivered hardening as shipped, update the product roadmap and capability register, and record release-day migration checks and successful CI.




#### clarify optional Team member role default ([`c8de1aa`](https://github.com/waterworkshq/orcy/commit/c8de1aa35a9b325b66a71847435adbeadd6e5d43))




- Document that adding a Team member accepts an omitted role and defaults it to member, matching the existing request schema and repository behavior.




#### add v0.44.0 operator notes ([`8712dfe`](https://github.com/waterworkshq/orcy/commit/8712dfe72b696dfe2847d1498ea0e7efdc8d1b86))




- Prepare convention-compliant minor release notes for scoped roles and governed review management, document upgrade actions and verification, and move the completed delivery out of upcoming work while retaining publication-pending status.





### Features

#### add scoped roles and governed review management ([`77368d1`](https://github.com/waterworkshq/orcy/commit/77368d1b815a2efbf979f2f85fae1d99d62b4c4f))




- Introduce immutable role revisions, versioned scoped assignments and retained governance audit with human administration and explicit personal ownership. Apply current transaction-bound authority and optional concurrency expectations to review configuration and reviewer allocation, preserve durable review safety, and retire authority atomically across managed deletion and import paths.





### Tests

#### synchronize governance race fixtures and reconcile docs ([`a479b3d`](https://github.com/waterworkshq/orcy/commit/a479b3d617d66560076fb091c7c9a46e28495a1c))




- Wait for worker database initialization before releasing paired commands and assert the actual conflict status and code. Remove a redundant restore revocation scan and correct review-contract documentation, helper comments and client-test claims.




#### isolate compiled startup output per smoke suite ([`2d6743f`](https://github.com/waterworkshq/orcy/commit/2d6743fc9b158cdc31cbded68fcc803679012048))




- Compile boot smoke fixtures directly into private native output directories so parallel builds cannot truncate modules while startup children import them. Preserve workspace and installed migration coverage, default test parallelism, and owned fixture cleanup.




#### isolate compiled startup builds ([`c9f0729`](https://github.com/waterworkshq/orcy/commit/c9f0729298a93efd84b120f5243973adcfbc2e83))




- Merge private compiler output for API boot smoke suites to prevent parallel shared-output truncation during startup. Preserve migration-layout coverage and default test parallelism.




#### match upgrade fixture journal mode to production ([`7687dcd`](https://github.com/waterworkshq/orcy/commit/7687dcd9fe5970fe9ed7aadd9fe38797292fcfaa))




- Use WAL while constructing the pre-upgrade SQLite fixture to avoid rollback-journal fsync overhead under full-suite load. Keep the original five-second bound, per-statement commits, real upgrade execution, and existing assertions unchanged.




#### stabilize pre-upgrade fixture setup ([`a5f73e5`](https://github.com/waterworkshq/orcy/commit/a5f73e5c82468341b03e7632117f6d8fd2c3d6ff))




- Merge production-matching WAL fixture setup to remove rollback-journal overhead without changing upgrade assertions, commit boundaries or test time limits.
