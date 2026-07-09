/**
 * v0.28-T3 — Internal `ContributionAdapterCatalog` foundation.
 *
 * Localizes per-kind registration behavior (id extraction, orphan-handler
 * validation, within-manifest + cross-plugin collision detection, registry
 * write) behind a single record adapter table. The factory receives the
 * 7 module-level registry Maps from `pluginManager.ts`, so this file imports
 * ONLY types (`./types.js`, `@orcy/shared`) — no Maps, no `pluginManager`
 * import → no circular dependency.
 *
 * Unconsumed by `pluginManager.ts` in this ticket (T4 wires it in). Acceptable
 * foundation state: typechecks, behavior-equivalent by construction to the
 * current switches, dead-but-correct until T4.
 *
 * Caveat: `CAPABILITY_MATRIX.forbiddenByPhase` is still consumed behind a
 * `c.kind === "lifecycleInterceptor"` branch in `capabilityMatrixViolation`
 * (pluginManager.ts:263–272), not fully generic — a future phase-bearing kind
 * would still need a code change. v0.28 does not change this; documented here
 * to keep the policy data co-located with the catalog it gates.
 */
import type {
  Contribution,
  InterceptorEvent,
  LifecycleInterceptorContribution,
  PluginCapabilityName,
  SignalDetectorContribution,
} from "@orcy/shared";
import type {
  ActionListener,
  ChannelHandler,
  ConditionHandler,
  DetectorHandler,
  FormatterHandler,
  InterceptorHandler,
  PluginModule,
  ProviderHandler,
} from "./types.js";

/**
 * The 9 contribution kinds a plugin may declare
 * (ADR-0011 + ADR-0021 + ADR-0028). Source of truth for `ContributionKind`;
 * intentionally a static const so kind validity does not depend on factory
 * construction or module-init order.
 */
export const CONTRIBUTION_KIND_KEYS = [
  "notificationChannel",
  "signalDetector",
  "lifecycleInterceptor",
  "customMcpTool",
  "customHttpRoute",
  "webhookFormatter",
  "automationCondition",
  "automationAction",
  "integrationProvider",
] as const;

/** Discriminator string for {@link Contribution}. */
export type ContributionKind = (typeof CONTRIBUTION_KIND_KEYS)[number];

/**
 * Per-kind registration-time behavior. Dispatch is NOT part of the adapter
 * — only the validation/registration callbacks below. `label` and
 * `orphanCheck` are required for all 9 kinds; `collisionKey`, `collisions`,
 * and `register` are present only for the 7 registry kinds (Tier-C
 * `customMcpTool` and `customHttpRoute` omit them — their runtime exposure
 * lives outside the catalog in `getCustomMcpTools()` and
 * `initializePlugins()` respectively).
 */
export interface ContributionAdapter {
  /** Human-readable identifier for error messages (e.g. `detectorId`, `channelId`). */
  label: (c: Contribution) => string;
  /**
   * Returns `null` if the declared contribution has a matching handler in the
   * module, else an error string whose wording matches the current
   * `orphanHandler` switch (T4 proves equivalence via characterization tests).
   */
  orphanCheck: (c: Contribution, mod: PluginModule) => string | null;
  /**
   * Prefixed within-manifest dedup key + cross-plugin registry key. The within
   * key carries its namespace prefix (e.g. `channel:…`, `interceptor:<id>:<phase>:<event>`).
   * The cross key matches the kind's registry Map key (e.g. `channelId` for
   * `channelRegistry`, `${manifestId}:${detectorId}` for the namespaced
   * `detectorRegistry`). `lifecycleInterceptor` has no cross key — its
   * registration is append-into-bucket, not registry-key collision-checked.
   * Undefined for Tier-C kinds, which don't track collisions.
   */
  collisionKey?: (c: Contribution, manifestId: string) => { within: string; cross?: string };
  /**
   * Collision detection metadata. Owns the per-kind error format and the
   * cross-registry reference so `detectIdCollisions` in `pluginManager.ts`
   * can be a pure delegation loop with zero kind-switches.
   *
   * `lifecycleInterceptor` is the one kind with partial collision tracking:
   * it has a compound within-key and a within-error, but no `crossRegistry`
   * (its registration is append-into-bucket, not registry-key collision-checked)
   * and no `crossError`.
   *
   * Undefined for Tier-C kinds, which don't track collisions.
   */
  collisions?: {
    /** Field name used in error messages (e.g. "channelId", "detectorId", "provider"). */
    idFieldName: string;
    /** The registry Map to check for cross-plugin collisions. Absent for lifecycleInterceptor. */
    crossRegistry?: Map<string, unknown>;
    /** Within-manifest duplicate error string for this kind. */
    withinError: (c: Contribution) => string;
    /** Cross-plugin duplicate error string for this kind. Absent for lifecycleInterceptor. */
    crossError?: (c: Contribution) => string;
  };
  /**
   * Writes to the kind's registry Map. `lifecycleInterceptor` uniquely sorts
   * its phase/event bucket by `contribution.priority` after every insert
   * (ADR-0014 ordering). Undefined for Tier-C kinds.
   *
   * The third parameter `registries` is part of the interface contract; the
   * built-in adapters close over the destructured Maps from the factory and
   * ignore it, but a downstream consumer that subclasses or composes an
   * adapter can use it to write to any of the 7 registries uniformly.
   */
  register?: (c: Contribution, mod: PluginModule, registries: PluginRegistries) => void;
}

/**
 * Capability policy per contribution kind (ADR-0012 whitelist).
 * Replaces the former hardcoded `if/else` chain in `capabilityMatrixViolation`.
 * Adding a new contribution kind is a data entry in `CAPABILITY_MATRIX`, not a
 * code change — except for `forbiddenByPhase`, which remains a kind-specific
 * branch (see file-header caveat).
 */
export interface CapabilityPolicy {
  /** Capabilities this kind is allowed to declare in its `requires` array. */
  allowed: readonly PluginCapabilityName[];
  /**
   * Capabilities forbidden when a phase-specific field matches the key
   * (e.g. `{ pre: ["pulseWriter"] }`). Currently only consumed by
   * `lifecycleInterceptor` (`c.phase === key`).
   */
  forbiddenByPhase?: Readonly<Record<string, readonly PluginCapabilityName[]>>;
}

/**
 * Data-driven capability policy per contribution kind. Co-located with the
 * catalog so per-kind policy and per-kind registration live next to each other.
 *
 * Note: `customMcpTool`, `customHttpRoute`, `webhookFormatter`,
 * `automationCondition`, and `integrationProvider` declare empty `allowed`
 * arrays — their contributions declare `requires: []` at the type level
 * (verified in {@link Contribution}).
 */
export const CAPABILITY_MATRIX: Readonly<Record<ContributionKind, CapabilityPolicy>> = {
  signalDetector: {
    allowed: ["pulseReader", "pulseWriter", "commentReader", "taskReader"],
  },
  lifecycleInterceptor: {
    allowed: [
      "pulseReader",
      "pulseWriter",
      "commentReader",
      "taskReader",
      "habitatReader",
      "chatIntegrationReader",
    ],
    forbiddenByPhase: { pre: ["pulseWriter"] },
  },
  notificationChannel: {
    allowed: ["chatIntegrationReader"],
  },
  customMcpTool: {
    allowed: [],
  },
  customHttpRoute: {
    allowed: [],
  },
  webhookFormatter: {
    allowed: [],
  },
  automationCondition: {
    allowed: [],
  },
  automationAction: {
    allowed: ["taskWriter", "notificationSender", "webhookCaller"],
  },
  integrationProvider: {
    allowed: [],
  },
};

/**
 * The bag of 7 module-level registries the factory receives. Value types
 * mirror the Maps declared in `pluginManager.ts` (channel / detector /
 * interceptor{pre,post} / formatter / condition / action / provider).
 * Mutable by reference; the catalog does not own lifetime.
 */
export interface PluginRegistries {
  channelRegistry: Map<string, { pluginId: string; handler: ChannelHandler; timeoutMs?: number }>;
  detectorRegistry: Map<
    string,
    { pluginId: string; contribution: SignalDetectorContribution; handler: DetectorHandler }
  >;
  interceptorRegistry: {
    pre: Map<
      InterceptorEvent,
      Array<{
        pluginId: string;
        contribution: LifecycleInterceptorContribution;
        handler: InterceptorHandler;
      }>
    >;
    post: Map<
      InterceptorEvent,
      Array<{
        pluginId: string;
        contribution: LifecycleInterceptorContribution;
        handler: InterceptorHandler;
      }>
    >;
  };
  formatterRegistry: Map<string, { pluginId: string; handler: FormatterHandler }>;
  conditionRegistry: Map<string, { pluginId: string; handler: ConditionHandler }>;
  actionRegistry: Map<
    string,
    { pluginId: string; handler: ActionListener; timeoutMs?: number }
  >;
  providerRegistry: Map<string, { pluginId: string; handler: ProviderHandler }>;
}

/**
 * Build the per-kind adapter catalog. Each adapter's `register` closes over
 * the specific Map from the passed `registries` bag (via destructure) so
 * per-call lookup is O(1) and the adapter body stays small. Called once at
 * module init in `pluginManager.ts` (T4).
 */
export function buildContributionCatalog(
  registries: PluginRegistries,
): Record<ContributionKind, ContributionAdapter> {
  const {
    channelRegistry,
    detectorRegistry,
    interceptorRegistry,
    formatterRegistry,
    conditionRegistry,
    actionRegistry,
    providerRegistry,
  } = registries;

  // Collision-error template helpers. The catalog owns the per-kind error
  // format and the cross-registry reference so `detectIdCollisions` in
  // `pluginManager.ts` is a pure delegation loop with zero kind-switches.
  // Templates:
  //   within: `duplicate ${idFieldName} "${label(c)}"${withinSuffix} within manifest`
  //   cross:  `${idFieldName} "${label(c)}" already registered${crossSuffix}`
  // Default crossSuffix is " by another plugin"; signalDetector uses "".
  // lifecycleInterceptor's withinSuffix is ` (${phase}/${event})`; others use "".
  const makeWithinError =
    (idFieldName: string, label: (c: Contribution) => string, withinSuffix?: (c: Contribution) => string) =>
    (c: Contribution): string =>
      `duplicate ${idFieldName} "${label(c)}"${withinSuffix ? withinSuffix(c) : ""} within manifest`;

  const makeCrossError =
    (idFieldName: string, label: (c: Contribution) => string, crossSuffix: string) =>
    (c: Contribution): string =>
      `${idFieldName} "${label(c)}" already registered${crossSuffix}`;

  return {
    notificationChannel: {
      label: (c) => (c.kind === "notificationChannel" ? c.channelId : ""),
      orphanCheck: (c, mod) => {
        if (c.kind !== "notificationChannel") return null;
        return typeof mod.channels?.[c.channelId] === "function"
          ? null
          : `notificationChannel "${c.channelId}" declared but no matching handler in module.channels`;
      },
      collisionKey: (c) => {
        if (c.kind !== "notificationChannel") return { within: "" };
        return { within: `channel:${c.channelId}`, cross: c.channelId };
      },
      collisions: {
        idFieldName: "channelId",
        crossRegistry: channelRegistry,
        withinError: makeWithinError("channelId", (c) => (c.kind === "notificationChannel" ? c.channelId : "")),
        crossError: makeCrossError("channelId", (c) => (c.kind === "notificationChannel" ? c.channelId : ""), " by another plugin"),
      },
      register: (c, mod) => {
        if (c.kind !== "notificationChannel") return;
        const handler = mod.channels?.[c.channelId];
        if (!handler) return;
        channelRegistry.set(c.channelId, {
          pluginId: mod.manifest.id,
          handler,
          timeoutMs: c.timeoutMs,
        });
      },
    },

    signalDetector: {
      label: (c) => (c.kind === "signalDetector" ? c.detectorId : ""),
      orphanCheck: (c, mod) => {
        if (c.kind !== "signalDetector") return null;
        return typeof mod.detectors?.[c.detectorId] === "function"
          ? null
          : `signalDetector "${c.detectorId}" declared but no matching handler in module.detectors`;
      },
      // Cross-key is the composite `${manifestId}:${detectorId}` matching
      // `detectorRegistry`'s namespaced Map key. T1 discovery: this
      // cross-plugin check is dead code on the disk-loading path (manifest.id
      // collisions are rejected by `loadPluginFromPath`), but preserved for a
      // future non-disk loading path that could reach it.
      collisionKey: (c, manifestId) => {
        if (c.kind !== "signalDetector") return { within: "" };
        return {
          within: `detector:${c.detectorId}`,
          cross: `${manifestId}:${c.detectorId}`,
        };
      },
      collisions: {
        idFieldName: "detectorId",
        crossRegistry: detectorRegistry,
        // Documented asymmetry: signalDetector's cross-error omits the
        // "by another plugin" suffix (byte-for-byte fidelity with the
        // pre-catalog switch).
        withinError: makeWithinError("detectorId", (c) => (c.kind === "signalDetector" ? c.detectorId : "")),
        crossError: makeCrossError("detectorId", (c) => (c.kind === "signalDetector" ? c.detectorId : ""), ""),
      },
      register: (c, mod) => {
        if (c.kind !== "signalDetector") return;
        const handler = mod.detectors?.[c.detectorId];
        if (!handler) return;
        detectorRegistry.set(`${mod.manifest.id}:${c.detectorId}`, {
          pluginId: mod.manifest.id,
          contribution: c,
          handler,
        });
      },
    },

    lifecycleInterceptor: {
      label: (c) => (c.kind === "lifecycleInterceptor" ? c.interceptorId : ""),
      orphanCheck: (c, mod) => {
        if (c.kind !== "lifecycleInterceptor") return null;
        return typeof mod.interceptors?.[c.interceptorId] === "function"
          ? null
          : `lifecycleInterceptor "${c.interceptorId}" declared but no matching handler in module.interceptors`;
      },
      // Compound within-key carrying id+phase+event; no cross key (interceptor
      // registration is append-into-bucket, not registry-key collision-checked).
      collisionKey: (c) => {
        if (c.kind !== "lifecycleInterceptor") return { within: "" };
        return {
          within: `interceptor:${c.interceptorId}:${c.phase}:${c.event}`,
        };
      },
      collisions: {
        idFieldName: "interceptorId",
        // No crossRegistry: append-into-bucket, not registry-key collision-checked.
        // Within-error carries the phase/event suffix: `(pre/taskCreated)`.
        withinError: makeWithinError(
          "interceptorId",
          (c) => (c.kind === "lifecycleInterceptor" ? c.interceptorId : ""),
          (c) => (c.kind === "lifecycleInterceptor" ? ` (${c.phase}/${c.event})` : ""),
        ),
        // No crossError: lifecycleInterceptor has no cross-plugin check.
      },
      // Unique to this kind: append into the phase/event bucket, then sort by
      // `contribution.priority` (ADR-0014). Sort is in-place (`.sort()`, not
      // `.toSorted()`) — the TS 6.0.3 LSP doesn't recognize the ES2023 lib
      // additions, and `.toSorted()` would type-error here. Behavior-equivalent
      // to pluginManager.ts:511.
      register: (c, mod) => {
        if (c.kind !== "lifecycleInterceptor") return;
        const handler = mod.interceptors?.[c.interceptorId];
        if (!handler) return;
        const bucket = interceptorRegistry[c.phase];
        const list = bucket.get(c.event) ?? [];
        list.push({
          pluginId: mod.manifest.id,
          contribution: c,
          handler,
        });
        list.sort((a, b) => a.contribution.priority - b.contribution.priority);
        bucket.set(c.event, list);
      },
    },

    // Tier-C — validation only, no registry. Runtime exposure lives in
    // `getCustomMcpTools()` (pluginManager.ts:671).
    customMcpTool: {
      label: (c) => (c.kind === "customMcpTool" ? c.toolName : ""),
      orphanCheck: (c, mod) => {
        if (c.kind !== "customMcpTool") return null;
        return typeof mod.mcpHandlers?.[c.toolName] === "function"
          ? null
          : `customMcpTool "${c.toolName}" declared but no matching handler in module.mcpHandlers`;
      },
    },

    // Tier-C — validation only; the route is mounted by `initializePlugins`
    // (pluginManager.ts:632), not registered into a Map.
    customHttpRoute: {
      label: (c) => (c.kind === "customHttpRoute" ? c.path : ""),
      // Note: error string deliberately omits the path — matches the current
      // `orphanHandler` byte-for-byte (pluginManager.ts:326–328).
      orphanCheck: (c, mod) => {
        if (c.kind !== "customHttpRoute") return null;
        return typeof mod.routeHandlers === "function"
          ? null
          : `customHttpRoute declared but module.routeHandlers is missing or not a function`;
      },
    },

    webhookFormatter: {
      label: (c) => (c.kind === "webhookFormatter" ? c.formatId : ""),
      orphanCheck: (c, mod) => {
        if (c.kind !== "webhookFormatter") return null;
        return typeof mod.formatters?.[c.formatId] === "function"
          ? null
          : `webhookFormatter "${c.formatId}" declared but no matching handler in module.formatters`;
      },
      collisionKey: (c) => {
        if (c.kind !== "webhookFormatter") return { within: "" };
        return { within: `formatter:${c.formatId}`, cross: c.formatId };
      },
      collisions: {
        idFieldName: "formatId",
        crossRegistry: formatterRegistry,
        withinError: makeWithinError("formatId", (c) => (c.kind === "webhookFormatter" ? c.formatId : "")),
        crossError: makeCrossError("formatId", (c) => (c.kind === "webhookFormatter" ? c.formatId : ""), " by another plugin"),
      },
      register: (c, mod) => {
        if (c.kind !== "webhookFormatter") return;
        const handler = mod.formatters?.[c.formatId];
        if (!handler) return;
        formatterRegistry.set(c.formatId, {
          pluginId: mod.manifest.id,
          handler,
        });
      },
    },

    automationCondition: {
      label: (c) => (c.kind === "automationCondition" ? c.conditionId : ""),
      orphanCheck: (c, mod) => {
        if (c.kind !== "automationCondition") return null;
        return typeof mod.conditions?.[c.conditionId] === "function"
          ? null
          : `automationCondition "${c.conditionId}" declared but no matching handler in module.conditions`;
      },
      collisionKey: (c) => {
        if (c.kind !== "automationCondition") return { within: "" };
        return { within: `condition:${c.conditionId}`, cross: c.conditionId };
      },
      collisions: {
        idFieldName: "conditionId",
        crossRegistry: conditionRegistry,
        withinError: makeWithinError("conditionId", (c) => (c.kind === "automationCondition" ? c.conditionId : "")),
        crossError: makeCrossError("conditionId", (c) => (c.kind === "automationCondition" ? c.conditionId : ""), " by another plugin"),
      },
      register: (c, mod) => {
        if (c.kind !== "automationCondition") return;
        const handler = mod.conditions?.[c.conditionId];
        if (!handler) return;
        conditionRegistry.set(c.conditionId, {
          pluginId: mod.manifest.id,
          handler,
        });
      },
    },

    automationAction: {
      label: (c) => (c.kind === "automationAction" ? c.actionId : ""),
      orphanCheck: (c, mod) => {
        if (c.kind !== "automationAction") return null;
        return typeof mod.actions?.[c.actionId] === "function"
          ? null
          : `automationAction "${c.actionId}" declared but no matching handler in module.actions`;
      },
      collisionKey: (c) => {
        if (c.kind !== "automationAction") return { within: "" };
        return { within: `action:${c.actionId}`, cross: c.actionId };
      },
      collisions: {
        idFieldName: "actionId",
        crossRegistry: actionRegistry,
        withinError: makeWithinError("actionId", (c) => (c.kind === "automationAction" ? c.actionId : "")),
        crossError: makeCrossError("actionId", (c) => (c.kind === "automationAction" ? c.actionId : ""), " by another plugin"),
      },
      register: (c, mod) => {
        if (c.kind !== "automationAction") return;
        const handler = mod.actions?.[c.actionId];
        if (!handler) return;
        actionRegistry.set(c.actionId, {
          pluginId: mod.manifest.id,
          handler,
          timeoutMs: c.timeoutMs,
        });
      },
    },

    integrationProvider: {
      label: (c) => (c.kind === "integrationProvider" ? c.provider : ""),
      // Object-shape validation: ProviderHandler is an object exposing both
      // `listIssues` and `getIssue` methods (IssueProviderAdapter minus the
      // `provider` self-identifying field). All three typeof checks required
      // — a partial handler is not load-bearing.
      orphanCheck: (c, mod) => {
        if (c.kind !== "integrationProvider") return null;
        const provider = mod.providers?.[c.provider];
        return typeof provider === "object" &&
          typeof provider?.listIssues === "function" &&
          typeof provider?.getIssue === "function"
          ? null
          : `integrationProvider "${c.provider}" declared but no matching handler in module.providers`;
      },
      collisionKey: (c) => {
        if (c.kind !== "integrationProvider") return { within: "" };
        return { within: `provider:${c.provider}`, cross: c.provider };
      },
      collisions: {
        idFieldName: "provider",
        crossRegistry: providerRegistry,
        withinError: makeWithinError("provider", (c) => (c.kind === "integrationProvider" ? c.provider : "")),
        crossError: makeCrossError("provider", (c) => (c.kind === "integrationProvider" ? c.provider : ""), " by another plugin"),
      },
      register: (c, mod) => {
        if (c.kind !== "integrationProvider") return;
        const handler = mod.providers?.[c.provider];
        if (!handler) return;
        providerRegistry.set(c.provider, {
          pluginId: mod.manifest.id,
          handler,
        });
      },
    },
  };
}
