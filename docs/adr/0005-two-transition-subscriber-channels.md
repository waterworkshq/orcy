# Two Transition Subscriber Channels: `onTaskEvent` and `onTransition`

Status: accepted · 2026-06-20

## Context

v0.20's `workflowService` needs to react to all 8 task lifecycle actions: `created`, `claimed`, `started`, `submitted`, `approved`, `rejected`, `completed`, `failed`, `released`, plus delegated/retry/effort variants. The existing `onTaskEvent` hook at `transition-emitter.ts:478` only fires for `completed | approved | rejected | failed` — the 4 lifecycle-completing actions codified in `NOTIFY_TASK_EVENT_ACTIONS` at `transition-emitter.ts:265-270`. The comment at lines 259-264 explicitly states: *"this list intentionally does not include all transition actions. If you add a new action here, audit every `onTaskEvent` consumer to confirm they handle it."* There's even a test `describe("notifyTaskEvent (inconsistency #2 preserved)")` at `transitionEmitter.test.ts:468` documenting this as a known, deliberate inconsistency from v0.17.1.

The design question: how does `workflowService` see `submitted` and `released` events without forcing an audit of every existing `onTaskEvent` consumer (today: `habitatSkillService.ts:461`)?

## Decision

**Add a parallel `onTransition` hook alongside the existing `onTaskEvent`. `onTransition` fires for every action that goes through `emitTransition()`. `workflowService` subscribes to `onTransition`. Existing `onTaskEvent` consumers and the existing 4-action firing set are unchanged.**

```ts
// transition-emitter.ts (extend)
type TransitionHook = (opts: { taskId, action, habitatId, ... }) => void;
const transitionHooks: TransitionHook[] = [];

export function onTransition(hook: TransitionHook): () => void;
function notifyTransition(opts: Parameters<TransitionHook>[0]): void;
// notifyTransition() called inside emitTransition() for all actions
```

## Rationale

**Two channels, two audiences:**

- **`onTaskEvent`** — lifecycle-completing actions only (4). Audience: consumers that should only react when work is "done" (e.g., `habitatSkillService` generates skills from completed work, not mid-flight signals). Preserves the existing v0.17.1 design intent.
- **`onTransition`** — all transitions. Audience: consumers that need to react to mid-lifecycle events. v0.20's `workflowService` is the first such consumer — it needs `submitted` (for tracking submission in workflow state), `released` (for `on_fail` on heartbeat-lost), and all the others.

The alternative — widening `onTaskEvent` to fire for all 8 actions — would force an audit of every existing consumer for unexpected side effects. The codebase explicitly warns against this (lines 259-264 comment, plus the preserved-inconsistency test). The risk is real: `habitatSkillService.ts:461` was designed assuming only 4 actions fire; receiving `submitted` or `released` could trigger skill generation at the wrong lifecycle point.

A parallel channel sidesteps the audit entirely. Consumers explicitly opt into the broader event stream by subscribing to `onTransition`. Existing consumers continue to see exactly what they always have.

## Alternatives considered

- **Widen `onTaskEvent` to fire for all 8 actions.** Rejected — requires audit of all existing consumers (currently `habitatSkillService`, future more); risks regressions; goes against the deliberate v0.17.1 design intent preserved in test `transitionEmitter.test.ts:468`.

- **`workflowService` polls task state instead of subscribing.** Rejected — poll-driven semantics are slower, more brittle, and don't match the established subscriber pattern. Other services (`habitatSkillService`) subscribe successfully.

- **Drop `submitted` and `released` from the events `workflowService` reacts to.** Rejected — loses the heartbeat-lost recovery path (`released` is the only signal that an agent went silent mid-claim). Loses real v0.20 functionality.

## Consequences

- `transition-emitter.ts` gains `onTransition`/`notifyTransition` (~30 lines, mirrors existing `onTaskEvent`/`notifyTaskEvent` pattern).
- `notifyTransition()` is called once inside `emitTransition()` (line ~525, after existing side effects complete).
- `workflowService` imports and calls `onTransition(...)` instead of `onTaskEvent(...)`.
- `habitatSkillService.ts:461` continues to use `onTaskEvent` — unchanged.
- Future consumers choose their channel based on whether they need lifecycle-completing events only or all transitions.
- Future v0.20.x or v0.21 can consolidate the two channels if a proper consumer audit is done — but that's a separate decision, not forced by v0.20.
