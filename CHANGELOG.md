# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.29.12 — 2026-07-12

### Performance

#### virtualize TaskCardList with tanstack react-virtual threshold-gated ([`d20460f`](https://github.com/waterworkshq/orcy/commit/d20460f8ecb80cb793cc06278d7024aa2ad25c00))

1. Mobile branch in TaskTableView now uses @tanstack/react-virtual via
2. useVirtualizer in TaskCardList with VIRTUALIZE_THRESHOLD = 100. Items
3. under the threshold render unchanged so the existing 12 tests still pass
4. (3 < 100). TaskTableView's mobile branch wraps TaskCardList in a
5. bounded-height (max-height: 600px) scroll container and passes a ref
6. down so the virtualizer can measure scroll against the parent.

8. TaskCardItem is already React.memo'd; threshold gate avoids paying
9. virtualization overhead for small lists.



### Refactors

#### type 17 unknown return types in notificationsV2 domain module ([`c37512f`](https://github.com/waterworkshq/orcy/commit/c37512f45059b2298a9615c48c8cc6230ced51b0))

1. Replaces 'unknown' / 'unknown[]' return types with concrete types from
2. @orcy/shared based on the API route shapes in packages/api/src/routes/notifications.ts
3. and the repository/service return shapes:

5. inbox, history → InboxResponse { deliveries, total } (NotificationDelivery[])
6. getDelivery → { delivery, event }
7. ack, snooze, clear → NotificationDelivery
8. subscriptions → { overrides, defaults } (NotificationSubscription[])
9. adminSubscriptions → { subscriptions } (NotificationSubscription[])
10. createSubscription, updateSubscription → NotificationSubscription
11. retention → NotificationRetentionPolicy | null
12. updateRetention → NotificationRetentionPolicy
13. adminClear → ClearanceResult shape
14. migrateLegacy → MigrationResult shape

16. Notification types re-exported from packages/ui/src/types/index.ts so the
17. api domain modules can import them through the existing alias. Internal
18. interfaces (InboxResponse etc.) are exported because the api re-export
19. requires them to be visible.


#### normalize agents.ts return-type unwrapping consistency ([`a4c322c`](https://github.com/waterworkshq/orcy/commit/a4c322c1afd6b66cb9065dba4e876fbc549e7c8b))

1. agentsApi.list and agentsApi.listWithTasks unwrap responses via
2. .then((r) => r.agents), but agentsApi.get returned the wrapper
3. { agent: Agent } unchanged. Normalize so all three methods unwrap to
4. their inner value (matches most other domain modules).

6. Callers checked: the only consumer of agentsApi.get is useAgent() in
7. useHabitatData.ts, which is exported but currently unreferenced outside
8. the file. useAgent's useQuery data type now flows as Agent instead of
9. { agent: Agent }, with no caller-side changes required.



### Tests

#### add Dialog primitive escape overlay-close and focus-trap tests ([`1336589`](https://github.com/waterworkshq/orcy/commit/1336589e1f4b60a4b987946dede76312d06a79ea))


#### add Drawer primitive escape overlay-close and focus tests ([`f83688f`](https://github.com/waterworkshq/orcy/commit/f83688f56d50e612f994451b16a9ad95ad4ca139))


#### add SprintPlanningPanel rendering and sprint-creation tests ([`c2ba7dd`](https://github.com/waterworkshq/orcy/commit/c2ba7dd7f069e4c25685d95d96d29ccd4435e1f3))


#### add Tooltip primitive mouse focus and role tests ([`9ba13db`](https://github.com/waterworkshq/orcy/commit/9ba13db792a16ff0c4cb6652fe18b161fac338e0))


#### add CommentSection rendering add-comment and empty-state tests ([`e5b528e`](https://github.com/waterworkshq/orcy/commit/e5b528e084257974da36b2b8c421a75159db3a6e))



## 0.29.11 — 2026-07-12

### Refactors

#### extract lifecycle collector to repository module with fatal policy preserved ([`d2298eb`](https://github.com/waterworkshq/orcy/commit/d2298ebd5b3f8b239d5b6792df3dd784103d6169))


#### extract codeEvidence collector to repository module with context loader ([`67c4663`](https://github.com/waterworkshq/orcy/commit/67c46638c1897262c6abae09dfefc59bb29f9344))



## 0.29.10 — 2026-07-12

### Refactors

#### extract healthSnapshot collector to repository module ([`075abea`](https://github.com/waterworkshq/orcy/commit/075abea689b1693819d2f206a248fdc0c61e8871))


#### extract webhookDelivery collector to repository module ([`b9f9f34`](https://github.com/waterworkshq/orcy/commit/b9f9f3440a6fee97e3278ee4f228ac9c3c8fa9b5))


#### extract integrationSync collector to repository module ([`ca80c24`](https://github.com/waterworkshq/orcy/commit/ca80c24be8dad22b3aa90fe23868a7ae85efd6e5))


#### extract effortEntry query to repository module ([`d5bf5af`](https://github.com/waterworkshq/orcy/commit/d5bf5af18bec1f35e7bb3f61537fe0f2ad62ab41))
