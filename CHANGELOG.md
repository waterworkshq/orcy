# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.39.2 — 2026-08-13

### Documentation

#### add v0.39.2 operator notes ([`34f216b`](https://github.com/waterworkshq/orcy/commit/34f216b5745e06496bcfc923da05cd7e9e45fc09))



### Tests

#### add concurrency proof and fix lingering lint and test regressions ([`aa641c1`](https://github.com/waterworkshq/orcy/commit/aa641c13b59723e73e982c76f216b980fcf7cf16))




- Prove that concurrent fresh-rerun allocations allocate monotonic generations without collisions or lock timeouts. Fix error-cause forwarding and unused identifiers across API and UI, and fix mocked error and remote-participant fixtures in prioritization and board-summary test suites.





## 0.39.1 — 2026-08-13

### Documentation

#### mark v0.39.0 shipped ([`9903984`](https://github.com/waterworkshq/orcy/commit/990398488a4e4e3ea952e8cc924aa72448a6ad19))


#### add v0.39.1 operator notes ([`0abe932`](https://github.com/waterworkshq/orcy/commit/0abe932316f2dbcd1052a963da1e42bbf14a334d))



### Features

#### add comment pagination and query error retry to communication board ([`af2eaa4`](https://github.com/waterworkshq/orcy/commit/af2eaa4e9a4fb5ff1f1ec7b6783a8ae961425e74))




- Support multi-page comments via infinite query and surface query error states with retry actions in the communication board.





## 0.39.0 — 2026-08-13

### Documentation

#### add v0.38.0 operator notes ([`69c958e`](https://github.com/waterworkshq/orcy/commit/69c958efd174e65471d9c57a9d71ed3f97951d6a))




- Add the hand-written operator-facing release notes for the Learning Loop v1 minor release following the minor-release convention, and flip the roadmap entry and readme What's Next from release-pending to Shipped now that the tag has landed.




#### add v0.39.0 operator notes ([`fe9e227`](https://github.com/waterworkshq/orcy/commit/fe9e2279d2e46dfdbbfc19b3de0d90bc30789556))




- Hand-written operator-facing notes for the Habitat Shared Room minor: co-presence, Pulse as shared memory, agent-mail supervision, and the mission Communication tab.





### Features

#### surface habitat co-presence and Pulse as a shared board ([`32b0e65`](https://github.com/waterworkshq/orcy/commit/32b0e652d8142ef10f8332e311c96c5da3af1919))




- Live viewers distinguish humans from agents with "in habitat" copy, and Pulse chrome states the board is shared, while skills keep the digest required and habitat SSE subscribe optional.




#### notify recipient agents of habitat mail via Notification V2 ([`230aa62`](https://github.com/waterworkshq/orcy/commit/230aa626e86066af90c31f5c83e942abe1cdb490))




- Sending mail enqueues a subject-only agent.message_received event for the recipient when a subscription exists, without putting the body on the wire or failing the send.




#### merge mission Pulse and comments into Communication (#8) ([`1bc5a37`](https://github.com/waterworkshq/orcy/commit/1bc5a37ab90220876fdcaf3224a6a649bf6bd4e4))




- feat(ui): merge mission Pulse and comments into Communication




- Mission detail lists existing Pulse and comment queries in one tab. Query construction, merge, row labels, and list chrome stay in separate modules so the board only orchestrates filters and composers. Pulse-only filter hides the comment composer so a posted comment cannot vanish from the visible list.
