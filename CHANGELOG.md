# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.29.10 — 2026-07-12

### Refactors

#### extract healthSnapshot collector to repository module ([`075abea`](https://github.com/waterworkshq/orcy/commit/075abea689b1693819d2f206a248fdc0c61e8871))


#### extract webhookDelivery collector to repository module ([`b9f9f34`](https://github.com/waterworkshq/orcy/commit/b9f9f3440a6fee97e3278ee4f228ac9c3c8fa9b5))


#### extract integrationSync collector to repository module ([`ca80c24`](https://github.com/waterworkshq/orcy/commit/ca80c24be8dad22b3aa90fe23868a7ae85efd6e5))


#### extract effortEntry query to repository module ([`d5bf5af`](https://github.com/waterworkshq/orcy/commit/d5bf5af18bec1f35e7bb3f61537fe0f2ad62ab41))



## 0.29.9 — 2026-07-12

### Refactors

#### consolidate claimTask guards onto checkClaimability as single mutation authority ([`7182b3a`](https://github.com/waterworkshq/orcy/commit/7182b3a8c1ef66cee57df47702e8e3ec73aacf99))


#### project workflow-gate constraint inside getAvailableTasksForAgent closing read-path gap ([`b54216b`](https://github.com/waterworkshq/orcy/commit/b54216b8faaa8908c0c22252a8151d97c9a75b3e))



## 0.29.8 — 2026-07-11

### Bug Fixes

#### unregister contributions on route-mount failure in initializePlugins rollback ([`3901d11`](https://github.com/waterworkshq/orcy/commit/3901d11a22fad740c50f9ee701e8e1993e146161))

1. When fastify.register() rejects for a plugin's routeHandlers, prior to this
2. fix only loadedPlugins.delete(id) ran — the channel / detector / interceptor
3. / formatter / condition / action / provider entries published by
4. loadPlugins() remained live. Admin surfaces (getLoadedPlugins) reported the
5. plugin as not-loaded while its contributions stayed callable.

7. Add an unregisterContributions() helper that reverses each kind's register
8. adapter: drop Map entries by id (with an owner-check on the kinds whose
9. registry values include pluginId), and filter lifecycleInterceptor entries
10. out of the per-phase/per-event bucket by (pluginId, interceptorId, phase,
11. event). Wire it into initializePlugins() before loadedPlugins.delete(id).

13. Tier-C kinds (customMcpTool, customHttpRoute) have no per-plugin registry;
14. removing from loadedPlugins is sufficient (getCustomMcpTools iterates
15. loadedPlugins, and the failing fastify.register is what this rollback
16. responds to).


#### pass declared contribution requires in notification channel dispatch ([`3962787`](https://github.com/waterworkshq/orcy/commit/396278756ad25ee849ecb4823d09d603be99e594))

1. dispatchToChannelPlugin was hardcoded to startPluginRun({ requires: [] }),
2. silently dropping the chatIntegrationReader capability that
3. NotificationChannelContribution declares and that
4. contributionAdapters.ts:165-167 lists as the only allowed capability for
5. this kind. Sibling dispatchers (dispatchInterceptorRun, runDetector) carry
6. the contribution object in their entries and read entry.contribution.requires
7. directly.

9. Channel registry entries only store { pluginId, handler, timeoutMs } — same
10. shape as actionRegistry, which dispatchActionHandler already handles via a
11. manifest lookup. Mirror that pattern: read loadedPlugins.get(pluginId) and
12. find the notificationChannel contribution matching channelId; pass its
13. requires array through to startPluginRun.



### Documentation

#### add claimability authority ADR and update domain glossary for deepening work ([`2ebca2f`](https://github.com/waterworkshq/orcy/commit/2ebca2f4b65a551b8cb37dfdacb7c5e05ed11ea7))
