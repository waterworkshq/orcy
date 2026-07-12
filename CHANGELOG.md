# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

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



## 0.29.7 — 2026-07-11

### Bug Fixes

#### replace hardcoded stale version string with real package version ([`c0e7823`](https://github.com/waterworkshq/orcy/commit/c0e7823e4f4729176bcd0ba396822e1e010da35d))


#### add board_start_task tool and fix claim description pointing at broken status path ([`05f6f49`](https://github.com/waterworkshq/orcy/commit/05f6f49b86bf0d2a009e2518efec7df9eae8461b))

1. T3 narrowed updateTaskSchema with .strict() (v0.29.5), which closed the
2. lifecycle bypass but left MCP agents with no path to transition
3. claimed → in_progress: the start tool didn't exist, and the claim tool
4. description told agents to call board_update_task with status="in_progress"
5. — which .strict() now rejects.

7. Add BOARD_START_TASK_TOOL + habitatStartTask (calls client.startTask,
8. returns enriched task)
9. Register the start action in TASK_DISPATCH_TOOL/ACTIONS so orcy_habitat_task
10. can route it
11. Fix BOARD_CLAIM_TASK_TOOL description to reference board_start_task
12. Add BOARD_FAIL_TASK_TOOL + habitatFailTask (client.failTask existed but
13. the tool was missing; board_update_task's description referenced it)
14. Register the fail action in TASK_DISPATCH_TOOL/ACTIONS
15. Add behavioral tests for habitatStartTask + route checks for start/fail


#### add keyboard access to TaskCard clickable div ([`99ee9b8`](https://github.com/waterworkshq/orcy/commit/99ee9b85cb3528bb24dd51efbf1461f033322941))


#### add keyboard access to MissionTaskKanban and PipelineContextSidebar clickable divs ([`a41d36b`](https://github.com/waterworkshq/orcy/commit/a41d36ba0d37feb46f82ce2d3a9dd98aefc14603))


#### add keyboard access to DataTable sortable column headers ([`ba65717`](https://github.com/waterworkshq/orcy/commit/ba657172992d09c312986cbc1e1c56caf57fac29))


#### add aria-label to SideNavBar nav and aria-current to active link ([`42aa4f9`](https://github.com/waterworkshq/orcy/commit/42aa4f96f0cf82c0ba6dc6317ad6ea33bc3855f0))


#### add role aria-modal aria-labelledby and focus management to Dialog primitive ([`6224183`](https://github.com/waterworkshq/orcy/commit/62241836d74bca7556ff306b339527776a8546c2))

1. Add role='dialog' aria-modal='true' on the content panel
2. Generate stable id with React.useId(); wire aria-labelledby to DialogTitle
3. via DialogContext so existing consumers (EditMissionForm, HabitatSettings,
4. etc.) get a labelled dialog with no code changes
5. DialogTitle accepts optional id prop; falls back to context-provided id
6. or its own useId for standalone usage
7. Focus trap: Tab cycles focus within the panel, Shift-Tab cycles in reverse
8. On open: focus first focusable child (or panel) via requestAnimationFrame
9. to ensure children have mounted
10. On close: restore focus to the previously-active element
11. Backward-compatible: existing open/onClose/children/contentClassName callers
12. work unchanged

14. Affects ~17 dialog consumers. Hand-rolled role/aria-modal/aria-labelledby in
15. OnboardingModal / TaskDetailModal can now be removed in a follow-up.


#### add role aria-modal aria-labelledby and focus management to Drawer primitive ([`4a47f2b`](https://github.com/waterworkshq/orcy/commit/4a47f2bf2b1dee780a3ebc17c5d99ea6bcb498f1))

1. Mirror the Dialog primitive (6224183) on Drawer so the 5 panels that wrap
2. content in Drawer (HelpDrawer, SprintPlanningPanel, ArchivedMissionsPanel,
3. AgentPanel, ActivityPanel) become keyboard-accessible:

5. role="dialog" + aria-modal="true" + aria-labelledby on the panel
6. aria-labelledby auto-generated via useId() with optional prop override
7. focus trap (Tab / Shift-Tab cycle within panel; Escape to close)
8. focus restoration: save document.activeElement on open, restore on close
9. requestAnimationFrame defer so focusable children are present on mount
10. tabIndex={-1} + outline-none so the panel itself can receive programmatic
11. focus when it has no focusable children


#### add keyboard focus trigger and aria attributes to Tooltip primitive ([`d7d18ff`](https://github.com/waterworkshq/orcy/commit/d7d18ff395f3153f21517a8a9bf08683d6c33841))

1. Tooltip currently only shows on onMouseEnter/onMouseLeave, so keyboard
2. and touch users get no announcement. Used pervasively (TaskCard badges,
3. DataTable sort indicator, etc.).

5. onFocus/onBlur on the wrapper mirror mouse show/hide so keyboard users
6. see the tooltip when tabbing onto the trigger; touch users get it on
7. first tap (focus) and it dismisses on the next tap (blur).
8. role="tooltip" + stable id (via useId()) on the popup element.
9. aria-describedby={tooltipId} on the wrapper while the tooltip is
10. visible, so screen readers announce the tooltip text when the trigger
11. is focused.

13. Public API (children, content, position, className, ref) is unchanged;
14. all additions are internal attributes on existing elements.



### Chores

#### delete orphaned PulseUnreadBadge component with zero imports ([`c12f943`](https://github.com/waterworkshq/orcy/commit/c12f943b2e0adec383a3a961121b98004e46da9c))



### Refactors

#### remove dead animKey useState allocation from TaskCard ([`fb9aa41`](https://github.com/waterworkshq/orcy/commit/fb9aa414c4fdb8d845a975540bf709a7ba95ef97))



### Style

#### switch sort to toSorted in domains test for ES2025 consistency ([`a1b47af`](https://github.com/waterworkshq/orcy/commit/a1b47af968ace6d3b59cac50f2ee4fd4b3b5ae82))


#### replace hardcoded colors with theme tokens in MissionGraphNode ([`170af21`](https://github.com/waterworkshq/orcy/commit/170af21de54f07f6272dce2ac9d0d8bc72b43d72))

1. Replace 'border-[rgba(68,72,77,0.15)]' with 'border-outline-variant/15'
2. (matches Drawer.tsx pattern)
3. Replace 'border-amber-400' with 'border-outline-variant border-dashed'
4. (no amber token exists in the design system; outline-variant + dashed style
5. preserves the 'dependency not met' visual signal while staying theme-aware)
6. Extract inline node width/minHeight to NODE_WIDTH / NODE_MIN_HEIGHT constants
