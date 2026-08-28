/**
 * Policy-installed authentication — the single authentication authority
 * (ADR-0049).
 *
 * A route DECLARES its effective policy through the typed native Fastify
 * route config (`config.authPolicy`). The root installer installed by
 * `createHttpApp` resolves that declaration, prepends the registry's guard at
 * the preHandler stage (before every route-level authorization middleware),
 * and records the same declaration in the observed inventory. Homogeneous
 * scoped plugins instead declare one inherited policy via
 * {@link inheritAuthPolicy}; explicit route-level declarations that conflict
 * with their scope are rejected — silent replacement is forbidden.
 *
 * Object-level authorization (`requireHabitatAccess`, `adminOnly`, remote
 * action scopes, idempotency) stays in the route's own preHandler chain and
 * runs AFTER the installed guard; this catalog never absorbs it.
 *
 * Readiness is closed: every route on the instance must resolve an effective
 * policy (declared or inherited) before the application becomes ready. A
 * route that reaches readiness without one is a boot error — there is no
 * fallback classification and no inference.
 *
 * Verified ingress moves provider signature/token checking behind closed core
 * verifier IDs (ADR-0028: provider-signed ingress stays in-tree). The same
 * declaration drives exact raw-body eligibility (see
 * {@link verifiedIngressRoutePaths}) — no separately maintained literal path
 * list — and every verifier must pass a readiness self-probe proving it can
 * actually verify its credential model (a correct credential accepted, an
 * incorrect one rejected) before the application may assemble.
 */
import { createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from "fastify";
import { agentAuth, humanAuth, agentOrHumanAuth, registrationAuth } from "./middleware/auth.js";
import { daemonAuth } from "./middleware/daemonAuth.js";
import { remoteParticipantAuth } from "./middleware/remoteAuth.js";
import { authenticateRealtime } from "./middleware/realtimeAuth.js";
import { badRequest, unauthorized } from "./errors.js";
import {
  isRemotePosture,
  verifyDiscordSignature,
  verifyGitHubHmac,
  verifyGitLabToken,
  verifySlackSignature,
} from "./config/integrationSecurity.js";
import {
  createCiCdSecretSource,
  createCodeReviewSecretSource,
  type WebhookSecretSource,
} from "./services/webhooks/webhook-secret-verification.js";
import {
  isActionableGitHubIssueEvent,
  resolveGitHubIssueIngress,
} from "./services/integrations/webhookService.js";
import type { GitHubWebhookPayload } from "./services/integrations/webhookService.js";
import { lookupManualInviteByToken, MANUAL_TOKEN_PREFIX } from "./services/remoteInviteService.js";
import type { RemoteInviteRow } from "./repositories/remoteInvite.js";

// ---------------------------------------------------------------------------
// Closed catalog
// ---------------------------------------------------------------------------

/** Closed catalog of authentication policies (ADR-0049). */
export const AUTH_POLICY_IDS = [
  "anonymous",
  "human",
  "agent",
  "local_actor",
  "registration",
  "daemon",
  "realtime",
  "remote_participant",
  "manual_invite",
  "verified_ingress",
] as const;

export type AuthPolicyId = (typeof AUTH_POLICY_IDS)[number];

/** Policies installable without a credential-model qualifier. */
export type SimpleAuthPolicyId = Exclude<AuthPolicyId, "verified_ingress">;

/** Closed set of core-owned verified-ingress verifiers. No System Plugin may supply one. */
export const CORE_VERIFIER_IDS = [
  "github_code_review_hmac",
  "github_ci_hmac",
  "github_issues_hmac",
  "gitlab_code_review_token",
  "gitlab_ci_token",
  "slack_signing",
  "discord_ed25519",
] as const;

export type CoreVerifierId = (typeof CORE_VERIFIER_IDS)[number];

/** A route's authentication declaration. `verified_ingress` requires a core verifier ID. */
export type AuthPolicy =
  | SimpleAuthPolicyId
  | { policy: "verified_ingress"; verifier: CoreVerifierId };

declare module "fastify" {
  interface FastifyContextConfig {
    authPolicy?: AuthPolicy;
  }

  interface FastifyRequest {
    /** Resolved manual invite from the `manual_invite` policy guard. */
    manualInvite?: RemoteInviteRow;
    /** Verified-ingress credential resolution from the installed verifier guard. */
    verifiedIngress?: VerifiedIngressContext;
  }
}

/** Credential resolution recorded by a verified-ingress guard for its handler. */
export interface VerifiedIngressContext {
  verifier: CoreVerifierId;
  verified: boolean;
  /** github_issues_hmac: eligible connections and the one whose secret matched (fail-soft family). */
  issues?: { connections: unknown[]; matched: unknown | null };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

type PolicyGuard = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

/** Anonymous is an explicit policy, not the absence of one. Its guard asserts nothing by design. */
async function anonymousPolicyGuard(): Promise<void> {}

/**
 * Exact bytes for signature verification: fastify-raw-body capture when
 * eligible, the historical JSON.stringify fallback otherwise. Mirrors the
 * pre-policy inline verifiers byte for byte.
 */
function rawBodyOrStringified(request: FastifyRequest): string {
  return typeof request.rawBody === "string" ? request.rawBody : JSON.stringify(request.body);
}

/**
 * Manual-invite credential guard: format + hash lookup, stashing the resolved
 * invite for the handler. The two routes historically answered a
 * missing/malformed token with DISTINCT messages (same 400/code/details);
 * the guard preserves each. Unknown tokens keep the shared canonical
 * not-found error.
 */
async function manualInviteTokenGuard(request: FastifyRequest): Promise<void> {
  const token = request.headers["x-orcy-invite-token"] as string | undefined;
  if (!token || !token.startsWith(MANUAL_TOKEN_PREFIX)) {
    const message = request.routeOptions.url?.endsWith("/accept")
      ? "Invite token required in X-Orcy-Invite-Token header"
      : "Invalid invite token format";
    throw badRequest(message, "INVALID_INVITE_TOKEN");
  }
  request.manualInvite = lookupManualInviteByToken(token);
}

/**
 * GitHub HMAC guard body. `failClosed` comes from the selected verifier's
 * registry entry — the declaration is the sole posture authority; this body
 * never closes over a parallel constant.
 */
async function githubHmacIngressGuard(
  source: WebhookSecretSource,
  failClosed: boolean | undefined,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // The handler's 400 for a missing X-GitHub-Event header outranks signature
  // rejection today; defer so that precedence is preserved byte for byte.
  const event = request.headers["x-github-event"];
  if (!event) return;
  const signature = request.headers["x-hub-signature-256"] as string | undefined;
  const { matched, secretsPresent } = source.verifyGitHubSignature(
    rawBodyOrStringified(request),
    signature,
  );
  request.verifiedIngress = { verifier: githubVerifierFor(source), verified: matched };
  if (!matched && (failClosed ? secretsPresent || isRemotePosture() : secretsPresent)) {
    reply.code(401).send({ error: "Invalid or missing signature" });
  }
}

function githubVerifierFor(source: WebhookSecretSource): CoreVerifierId {
  return source === ciCdSource ? "github_ci_hmac" : "github_code_review_hmac";
}

/**
 * GitLab token guard body. `failClosed` comes from the selected verifier's
 * registry entry — same declaration-owned rule as the GitHub body.
 */
async function gitlabTokenIngressGuard(
  source: WebhookSecretSource,
  failClosed: boolean | undefined,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Missing object_kind 400 (handler) outranks token rejection today; defer.
  const objectKind = (request.body as Record<string, unknown> | undefined)?.object_kind;
  if (!objectKind) return;
  const providedToken = request.headers["x-gitlab-token"] as string | undefined;
  const { matched, secretsPresent } = source.verifyGitLabToken(providedToken);
  request.verifiedIngress = { verifier: gitlabVerifierFor(source), verified: matched };
  if (!matched && (failClosed ? secretsPresent || isRemotePosture() : secretsPresent)) {
    reply.code(401).send({ error: "Invalid or missing token" });
  }
}

function gitlabVerifierFor(source: WebhookSecretSource): CoreVerifierId {
  return source === ciCdSource ? "gitlab_ci_token" : "gitlab_code_review_token";
}

/** Slack v0 HMAC guard — preserves the configured-key/missing-key posture matrix. */
async function slackVerifiedIngressGuard(request: FastifyRequest): Promise<void> {
  const signingSecret = process.env.SLACK_SIGNING_SECRET ?? "";
  const signature = request.headers["x-slack-signature"] as string | undefined;
  const timestamp = request.headers["x-slack-request-timestamp"] as string | undefined;
  if (signingSecret) {
    const result = verifySlackSignature(
      signature,
      timestamp,
      rawBodyOrStringified(request),
      signingSecret,
    );
    if (!result.valid) {
      throw unauthorized(result.reason ?? "Invalid signature");
    }
  } else if (isRemotePosture()) {
    throw unauthorized("Slack signing secret not configured");
  }
  request.verifiedIngress = { verifier: "slack_signing", verified: signingSecret !== "" };
}

/** Discord Ed25519 guard — same posture matrix; verification itself was repaired in this ticket. */
async function discordVerifiedIngressGuard(request: FastifyRequest): Promise<void> {
  const publicKey = process.env.DISCORD_PUBLIC_KEY ?? "";
  const signature = request.headers["x-signature-ed25519"] as string | undefined;
  const timestamp = request.headers["x-signature-timestamp"] as string | undefined;
  if (publicKey) {
    if (!verifyDiscordSignature(signature, timestamp, rawBodyOrStringified(request), publicKey)) {
      throw unauthorized("Invalid signature");
    }
  } else if (isRemotePosture()) {
    throw unauthorized("Discord public key not configured");
  }
  request.verifiedIngress = { verifier: "discord_ed25519", verified: publicKey !== "" };
}

/** GitHub issues HMAC guard — fail-soft by design: resolution is stashed, never rejected. */
async function githubIssuesVerifiedIngressGuard(request: FastifyRequest): Promise<void> {
  const payload = (request.body ?? {}) as GitHubWebhookPayload;
  // Historical no-op ordering: payloads without an issue, without a
  // repository, or with an unsupported action were answered before any
  // connection lookup or signature work — no connection query and no
  // signature warning for events that were never going to sync.
  if (!isActionableGitHubIssueEvent(payload)) {
    request.verifiedIngress = { verifier: "github_issues_hmac", verified: false };
    return;
  }
  const signature = request.headers["x-hub-signature-256"] as string | undefined;
  const resolution = resolveGitHubIssueIngress(rawBodyOrStringified(request), signature, payload);
  request.verifiedIngress = {
    verifier: "github_issues_hmac",
    verified: resolution.matched !== null,
    issues: { connections: resolution.connections, matched: resolution.matched },
  };
}

const codeReviewSource = createCodeReviewSecretSource();
const ciCdSource = createCiCdSecretSource();

/** Each wrapper reads its posture from the registry entry at request time — the declaration is the authority. */
async function githubCodeReviewVerifiedIngressGuard(request: FastifyRequest, reply: FastifyReply) {
  return githubHmacIngressGuard(
    codeReviewSource,
    VERIFIED_INGRESS_VERIFIERS.github_code_review_hmac.failClosed,
    request,
    reply,
  );
}

async function githubCiVerifiedIngressGuard(request: FastifyRequest, reply: FastifyReply) {
  return githubHmacIngressGuard(
    ciCdSource,
    VERIFIED_INGRESS_VERIFIERS.github_ci_hmac.failClosed,
    request,
    reply,
  );
}

async function gitlabCodeReviewVerifiedIngressGuard(request: FastifyRequest, reply: FastifyReply) {
  return gitlabTokenIngressGuard(
    codeReviewSource,
    VERIFIED_INGRESS_VERIFIERS.gitlab_code_review_token.failClosed,
    request,
    reply,
  );
}

async function gitlabCiVerifiedIngressGuard(request: FastifyRequest, reply: FastifyReply) {
  return gitlabTokenIngressGuard(
    ciCdSource,
    VERIFIED_INGRESS_VERIFIERS.gitlab_ci_token.failClosed,
    request,
    reply,
  );
}

/** Simple policies install the existing core middleware verbatim. */
const SIMPLE_POLICY_GUARDS: { [P in SimpleAuthPolicyId]: PolicyGuard } = {
  anonymous: anonymousPolicyGuard,
  human: humanAuth,
  agent: agentAuth,
  local_actor: agentOrHumanAuth,
  registration: registrationAuth,
  daemon: daemonAuth,
  realtime: authenticateRealtime,
  remote_participant: remoteParticipantAuth,
  manual_invite: manualInviteTokenGuard,
};

// ---------------------------------------------------------------------------
// Verifier readiness self-probes
// ---------------------------------------------------------------------------

/** A verifier is readiness-valid only when it accepts a correct credential AND rejects an incorrect one. */
export function probeVerifierPair(accept: () => boolean, reject: () => boolean): boolean {
  return accept() === true && reject() === false;
}

function makeGitHubHmacSelfProbe(): () => boolean {
  const secret = randomBytes(16).toString("hex");
  const payload = '{"probe":"auth-policy-readiness"}';
  const good = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  const bad = "sha256=" + createHmac("sha256", secret).update(`${payload} `).digest("hex");
  return () =>
    probeVerifierPair(
      () => verifyGitHubHmac(payload, good, secret),
      () => verifyGitHubHmac(payload, bad, secret),
    );
}

function makeGitLabTokenSelfProbe(): () => boolean {
  const secret = randomBytes(16).toString("hex");
  return () =>
    probeVerifierPair(
      () => verifyGitLabToken(secret, secret),
      () => verifyGitLabToken(`${secret}-wrong`, secret),
    );
}

function makeSlackSelfProbe(): () => boolean {
  const secret = randomBytes(16).toString("hex");
  const payload = '{"probe":"slack-readiness"}';
  return () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const good = "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${payload}`).digest("hex");
    const bad = "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${payload} `).digest("hex");
    return probeVerifierPair(
      () => verifySlackSignature(good, ts, payload, secret).valid,
      () => verifySlackSignature(bad, ts, payload, secret).valid,
    );
  };
}

function makeDiscordSelfProbe(): () => boolean {
  return () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    // The verifier expects the raw 32-byte key (SPKI DER's last 32 bytes).
    const publicHex = publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("hex");
    const ts = String(Math.floor(Date.now() / 1000));
    const payload = '{"type":1}';
    const good = sign(null, Buffer.from(ts + payload), privateKey).toString("hex");
    const bad = sign(null, Buffer.from(`${ts}${payload} `), privateKey).toString("hex");
    return probeVerifierPair(
      () => verifyDiscordSignature(good, ts, payload, publicHex),
      () => verifyDiscordSignature(bad, ts, payload, publicHex),
    );
  };
}

// ---------------------------------------------------------------------------
// Verified-ingress verifier registry — declaration, guard, readiness, raw body
// ---------------------------------------------------------------------------

interface VerifiedIngressVerifierSpec {
  /** Local-API-relative paths guarded by this verifier (mounted under /api/v1 and /api). */
  routePaths: readonly string[];
  /**
   * Sole posture authority for GitHub/GitLab families — the installed guard
   * reads this exact field at request time. `true` rejects an unmatched
   * credential under remote posture even with zero configured secrets (the
   * code-review routes' historical `{ failClosed: true }`); `false` (the CI
   * families' pre-policy behavior, no failClosed option passed) rejects only
   * when a corresponding Habitat secret exists. Absent for families whose
   * disposition is not rejection-based (github_issues_hmac is fail-soft).
   */
  failClosed?: boolean;
  guard: PolicyGuard;
  /** Must prove the implementation can verify its credential model; run once per assembly. */
  selfProbe(): boolean;
}

const VERIFIED_INGRESS_VERIFIERS: { [V in CoreVerifierId]: VerifiedIngressVerifierSpec } = {
  github_code_review_hmac: {
    routePaths: ["/webhooks/github"],
    failClosed: true,
    guard: githubCodeReviewVerifiedIngressGuard,
    selfProbe: makeGitHubHmacSelfProbe(),
  },
  github_ci_hmac: {
    routePaths: ["/webhooks/github-ci"],
    failClosed: false,
    guard: githubCiVerifiedIngressGuard,
    selfProbe: makeGitHubHmacSelfProbe(),
  },
  github_issues_hmac: {
    routePaths: ["/webhooks/github/issues"],
    guard: githubIssuesVerifiedIngressGuard,
    selfProbe: makeGitHubHmacSelfProbe(),
  },
  gitlab_code_review_token: {
    routePaths: ["/webhooks/gitlab"],
    failClosed: true,
    guard: gitlabCodeReviewVerifiedIngressGuard,
    selfProbe: makeGitLabTokenSelfProbe(),
  },
  gitlab_ci_token: {
    routePaths: ["/webhooks/gitlab-ci"],
    failClosed: false,
    guard: gitlabCiVerifiedIngressGuard,
    selfProbe: makeGitLabTokenSelfProbe(),
  },
  slack_signing: {
    routePaths: ["/chat/slack/command"],
    guard: slackVerifiedIngressGuard,
    selfProbe: makeSlackSelfProbe(),
  },
  discord_ed25519: {
    routePaths: ["/chat/discord/interaction"],
    guard: discordVerifiedIngressGuard,
    selfProbe: makeDiscordSelfProbe(),
  },
};

/**
 * Exact raw-body capture routes, derived from the same verifier declarations
 * that install the guards — under both the current and deprecated prefixes.
 */
export function verifiedIngressRoutePaths(): readonly string[] {
  const paths = new Set<string>();
  for (const spec of Object.values(VERIFIED_INGRESS_VERIFIERS)) {
    for (const relative of spec.routePaths) {
      paths.add(`/api/v1${relative}`);
      paths.add(`/api${relative}`);
    }
  }
  return [...paths].sort();
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

function methodsOf(routeOptions: RouteOptions): string[] {
  const raw = routeOptions.method;
  return (Array.isArray(raw) ? raw : [raw]).map((m) => String(m).toUpperCase());
}

function policyEquals(a: AuthPolicy, b: AuthPolicy): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.policy === b.policy && a.verifier === b.verifier;
}

/** Inventory-facing rendering of an effective policy. */
export function formatEffectivePolicy(policy: AuthPolicy): string {
  return typeof policy === "string" ? policy : `verified_ingress:${policy.verifier}`;
}

/**
 * One declaration, one resolver: the runtime guard and the observed inventory
 * both call this. `undefined` means NO effective policy — a readiness failure,
 * never a fallback classification.
 */
export function resolveEffectiveAuthPolicy(
  config: { authPolicy?: AuthPolicy } | undefined,
): AuthPolicy | undefined {
  return config?.authPolicy;
}

function validatePolicyDeclaration(declared: AuthPolicy, url: string): AuthPolicy {
  if (typeof declared === "string") {
    // String() defeats the literal-union narrowing: untyped JS config could
    // still deliver the bare "verified_ingress" string at runtime.
    if (String(declared) === "verified_ingress") {
      throw new Error(
        `Route ${url} declares verified_ingress without a core verifier ID; declare { policy: "verified_ingress", verifier: "..." }`,
      );
    }
    if ((AUTH_POLICY_IDS as readonly string[]).includes(declared)) return declared;
    throw new Error(`Route ${url} declares unknown auth policy "${declared}"`);
  }
  if (declared && typeof declared === "object" && declared.policy === "verified_ingress") {
    if ((CORE_VERIFIER_IDS as readonly string[]).includes(declared.verifier)) {
      return declared;
    }
    throw new Error(
      `Route ${url} declares verified_ingress with unknown core verifier "${String(declared.verifier)}"`,
    );
  }
  throw new Error(
    `Route ${url} declares a malformed auth policy (${JSON.stringify(declared)}); verified_ingress requires { policy: "verified_ingress", verifier: <core verifier ID> }`,
  );
}

/** The guard a policy installs. Registry indirection — mutating an entry mutates enforcement. */
export function policyGuardFor(policy: AuthPolicy): PolicyGuard {
  // The bare "verified_ingress" string never reaches here: it is a type error
  // and validatePolicyDeclaration rejects it at registration time.
  if (typeof policy === "string") {
    return SIMPLE_POLICY_GUARDS[policy];
  }
  return VERIFIED_INGRESS_VERIFIERS[policy.verifier].guard;
}

/** Routes whose policy guard is already installed (root installer or scope applier). */
const guardInstalledRoutes = new WeakSet<object>();

function installPolicyGuard(routeOptions: RouteOptions, policy: AuthPolicy): void {
  if (guardInstalledRoutes.has(routeOptions)) return;
  guardInstalledRoutes.add(routeOptions);
  const guard = policyGuardFor(policy);
  const existing =
    routeOptions.preHandler == null
      ? []
      : Array.isArray(routeOptions.preHandler)
        ? [...routeOptions.preHandler]
        : [routeOptions.preHandler];
  // Prepend: authentication runs before every route-level authorization
  // middleware that remains in the route's own preHandler chain.
  routeOptions.preHandler = [guard, ...existing];
}

export interface AuthPolicyRouteClassification {
  method: string;
  url: string;
  effectivePolicy: AuthPolicy | undefined;
}

/**
 * Framework normalization for readiness validation, mirroring the
 * characterization suite's rule exactly: the @fastify/cors preflight
 * catch-all is the ONE wildcard OPTIONS route (`fastify.options('*')` answers
 * preflight before authentication by design). Any other OPTIONS route — or
 * any unknown application route — must still declare a policy.
 */
function isCorsPreflightCatchAll(routeOptions: RouteOptions): boolean {
  return routeOptions.url === "*" && methodsOf(routeOptions).includes("OPTIONS");
}

/**
 * Root installer. Called by `createHttpApp` before any route registration:
 * validates verifier readiness (boot fails if a verifier cannot verify) and
 * installs guards for route-level declarations. Routes that declare nothing
 * here are either filled by their homogeneous scope ({@link inheritAuthPolicy},
 * whose scoped hook runs after this one) or fail readiness below.
 */
export function installAuthPolicy(fastify: FastifyInstance): void {
  for (const [id, spec] of Object.entries(VERIFIED_INGRESS_VERIFIERS) as [
    CoreVerifierId,
    VerifiedIngressVerifierSpec,
  ][]) {
    if (!spec.selfProbe()) {
      throw new Error(
        `Verified-ingress verifier "${id}" failed its readiness self-probe: it must accept a correctly signed probe credential and reject an incorrect one before the HTTP application may assemble.`,
      );
    }
  }

  const routes: RouteOptions[] = [];
  installStates.set(fastify, routes);

  fastify.addHook("onRoute", (routeOptions) => {
    routes.push(routeOptions);
    const declared = routeOptions.config?.authPolicy;
    if (declared === undefined) return;
    installPolicyGuard(routeOptions, validatePolicyDeclaration(declared, routeOptions.url));
  });

  // Closed readiness: the application may not become ready while any route
  // reachable on this instance has no effective authentication policy. A
  // missing declaration is a boot error — never inferred from middleware
  // names, paths, or an exception list.
  fastify.addHook("onReady", async () => {
    const missing: string[] = [];
    const seen = new Set<RouteOptions>();
    for (const routeOptions of routes) {
      if (seen.has(routeOptions)) continue;
      seen.add(routeOptions);
      if (isCorsPreflightCatchAll(routeOptions)) continue;
      if (resolveEffectiveAuthPolicy(routeOptions.config) === undefined) {
        missing.push(`${methodsOf(routeOptions).join("|")} ${routeOptions.url}`);
      }
    }
    if (missing.length > 0) {
      const shown = missing.slice(0, 8).join(", ");
      const more = missing.length > 8 ? ` (and ${missing.length - 8} more)` : "";
      throw new Error(
        `Readiness failure: ${missing.length} route(s) have no effective authentication policy: ${shown}${more}. Every route must declare config.authPolicy or inherit one from a homogeneous scope.`,
      );
    }
  });
}

const installStates = new WeakMap<FastifyInstance, RouteOptions[]>();

/**
 * Effective policy of every route on an assembly-installed instance. Resolved
 * lazily so scope-level inheritance (applied by scoped onRoute hooks after the
 * root hook) is final. This is the observed inventory's classification source.
 */
export function authPolicyClassifications(
  fastify: FastifyInstance,
): AuthPolicyRouteClassification[] {
  const routes = installStates.get(fastify);
  if (!routes) {
    throw new Error(
      "auth policy installer is not active on this instance — construct through createHttpApp",
    );
  }
  return routes.flatMap((routeOptions) =>
    methodsOf(routeOptions).map((method) => ({
      method,
      url: routeOptions.url,
      effectivePolicy: resolveEffectiveAuthPolicy(routeOptions.config),
    })),
  );
}

/**
 * Scope-level applier for heterogeneous plugins whose routes declare policy
 * per route. On a seam-constructed instance the root installer has already
 * installed these guards — this is a no-op — but a plugin registered directly
 * on a bare instance still gets enforcement for its own declarations.
 */
export function applyDeclaredAuthPolicies(fastify: FastifyInstance): void {
  fastify.addHook("onRoute", (routeOptions) => {
    const declared = routeOptions.config?.authPolicy;
    if (declared === undefined) return;
    installPolicyGuard(routeOptions, validatePolicyDeclaration(declared, routeOptions.url));
  });
}

/**
 * Declares one inherited effective policy for a homogeneous scoped plugin.
 * Call first inside the plugin body. Routes that declare nothing inherit it;
 * a route-level declaration that conflicts with the scope is a boot error
 * (silent replacement is forbidden); an identical declaration is allowed.
 */
export function inheritAuthPolicy(fastify: FastifyInstance, inherited: SimpleAuthPolicyId): void {
  fastify.addHook("onRoute", (routeOptions) => {
    const declared = routeOptions.config?.authPolicy;
    if (declared === undefined) {
      // Mutate the existing config object rather than replacing it: earlier
      // onRoute observers (root installer, inventory capture) hold references
      // to it and must see the inherited policy.
      if (routeOptions.config) {
        routeOptions.config.authPolicy = inherited;
      } else {
        routeOptions.config = { authPolicy: inherited };
      }
      installPolicyGuard(routeOptions, inherited);
      return;
    }
    if (!policyEquals(declared, inherited)) {
      throw new Error(
        `Route ${routeOptions.url} declares auth policy ${formatEffectivePolicy(declared)}, conflicting with its homogeneous scope's inherited policy "${inherited}". Homogeneous scopes may not be silently narrowed — declare the route consistently or move it out of the scope.`,
      );
    }
    // Identical explicit declaration — an allowed, deliberate restatement of
    // the scope's policy. Install through the same deduplicated authority: on
    // seam-constructed instances the root installer already ran and the
    // WeakSet makes this a no-op; on bare instances this is the only
    // installation, so the declaration must never silently depend on the
    // root hook being present.
    installPolicyGuard(routeOptions, declared);
  });
}
