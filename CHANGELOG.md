# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.34.4 — 2026-08-03

### Bug Fixes

#### map correct-code-evidence-link wire names to backend + wire ArgsOf handler typing ([`381407b`](https://github.com/waterworkshq/orcy/commit/381407bea61f3c71261b67d2ad5cf85371116050))

1. The correct-code-evidence-link action returned 400: the wire delivered linkStatus/correctionReason but the backend correctLinkSchema requires status/reason, and the handler rest-spread the wire names through. Add an explicit wire->backend map. Wiring ArgsOf<A> to ActionEntry.execute surfaced the mismatch; making ActionEntry generic kills the args:any erasure at the inline arrows (args.bordId is now a compile error). Method-syntax bivariance lets named handlers keep their own typed args. The legacy code-evidence test becomes an honest wire->backend integration test.



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
