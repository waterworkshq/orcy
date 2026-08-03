# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.34.5 — 2026-08-03

### Bug Fixes

#### map correct-mission-evidence-link wire names to backend (status/reason) ([`a002c80`](https://github.com/waterworkshq/orcy/commit/a002c800544aeaf15ea35165629cd6182298feca))

1. Same wire/backend name drift as the task variant fixed in v0.34.4: the mission wire delivers linkStatus/correctionReason but correctLinkSchema requires status/reason, and the handler rest-spread the wire names through -> 400. Add the explicit wire->backend map. Update the legacy test to an honest wire->backend integration test.



## 0.34.4 — 2026-08-03

### Bug Fixes

#### map correct-code-evidence-link wire names to backend + wire ArgsOf handler typing ([`381407b`](https://github.com/waterworkshq/orcy/commit/381407bea61f3c71261b67d2ad5cf85371116050))

1. The correct-code-evidence-link action returned 400: the wire delivered linkStatus/correctionReason but the backend correctLinkSchema requires status/reason, and the handler rest-spread the wire names through. Add an explicit wire->backend map. Wiring ArgsOf<A> to ActionEntry.execute surfaced the mismatch; making ActionEntry generic kills the args:any erasure at the inline arrows (args.bordId is now a compile error). Method-syntax bivariance lets named handlers keep their own typed args. The legacy code-evidence test becomes an honest wire->backend integration test.



## 0.34.3 — 2026-08-03

### Refactors

#### derive task-dispatch action metadata from one field-descriptor declaration ([`5eebb2c`](https://github.com/waterworkshq/orcy/commit/5eebb2cbd05c17b1bc64fb1c71bb724b75804d7d))



### Tests

#### lock orcy_habitat_task agent-visible behavior (firewall characterization) ([`5d2909c`](https://github.com/waterworkshq/orcy/commit/5d2909cd160b7e257e0efe90f35c12822c43be2e))
