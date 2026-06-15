import type { IdentityProviderRow } from "../repositories/identityProvider.js";
import { getEnabledIdentityProviders } from "../repositories/identityProvider.js";

/** Classification of how a habitat is reachable from outside the local machine, derived from the configured base URL by {@link detectReachabilityProfile}. */
export type ReachabilityProfile =
  | "local_only"
  | "lan_vpn_tailscale"
  | "tunnel"
  | "vps_reverse_proxy"
  | "git_provider_bridge";

/** Single readiness gate in a {@link ReadinessReport}, carrying its pass state, human-readable detail, and severity. */
export interface ReadinessCheck {
  key: string;
  label: string;
  passed: boolean;
  detail: string;
  severity: "error" | "warning" | "info";
}

/** Full readiness verdict produced by {@link checkReadiness}: the reachability profile, overall ready/can-invite flags, and the individual {@link ReadinessCheck}s. */
export interface ReadinessReport {
  profile: ReachabilityProfile;
  ready: boolean;
  canInvite: boolean;
  checks: ReadinessCheck[];
  baseUrl: string | null;
  hasProvider: boolean;
  hasManualInviteOption: boolean;
}

const PRIVATE_NETWORK_PATTERNS = [
  /^https?:\/\/10\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/172\.(1[6-9]|2[0-9]|3[01])\./,
  /^https?:\/\/localhost(:\d+)?(\/.*)?$/,
  /^https?:\/\/127\.0\.0\./,
  /^https?:\/\/[a-f0-9:]+:[a-f0-9]+%/, // Tailscale interface scope
];

function isPrivateNetworkUrl(url: string): boolean {
  return PRIVATE_NETWORK_PATTERNS.some((pattern) => pattern.test(url));
}

function isHttpsUrl(url: string): boolean {
  return url.startsWith("https://");
}

/** Classifies the configured base URL into a {@link ReachabilityProfile} indicating how a habitat is reachable from outside the local machine (HTTPS tunnel, LAN/VPN/Tailscale, VPS reverse proxy, or local-only). */
export function detectReachabilityProfile(baseUrl: string | null): ReachabilityProfile {
  if (!baseUrl) return "local_only";
  if (isHttpsUrl(baseUrl)) return "tunnel";
  if (isPrivateNetworkUrl(baseUrl)) return "lan_vpn_tailscale";
  // HTTP on a public address — likely a VPS behind a reverse proxy
  if (baseUrl.startsWith("http://")) return "vps_reverse_proxy";
  return "local_only";
}

/** Returns the trimmed `ORCY_PUBLIC_URL` (or `ORCY_BASE_URL` fallback) value, or `null` when neither env var is set; reads from `process.env` on every call. */
export function getBaseUrl(): string | null {
  const url = process.env.ORCY_PUBLIC_URL ?? process.env.ORCY_BASE_URL;
  if (!url || typeof url !== "string") return null;
  return url.trim() || null;
}

/** Inspects the habitat's base URL and enabled identity providers (via a {@link IdentityProviderRow} repository read) to produce a {@link ReadinessReport} indicating whether the habitat is ready to share and whether invites can be issued. */
export function checkReadiness(
  habitatId: string,
  options?: { manualInviteSelected?: boolean },
): ReadinessReport {
  const baseUrl = getBaseUrl();
  const profile = detectReachabilityProfile(baseUrl);
  const providers = getEnabledIdentityProviders(habitatId);
  const hasProvider = providers.length > 0;
  const hasManualInviteOption = options?.manualInviteSelected === true;

  const checks: ReadinessCheck[] = [];

  // 1. Base URL configured
  checks.push({
    key: "base_url",
    label: "Public/base URL configured",
    passed: baseUrl !== null,
    detail: baseUrl
      ? `Base URL: ${baseUrl}`
      : "ORCY_PUBLIC_URL not set. Configure it to enable external access.",
    severity: "error",
  });

  // 2. HTTPS or trusted private network
  const usesHttps = baseUrl !== null && isHttpsUrl(baseUrl);
  const isPrivate = baseUrl !== null && isPrivateNetworkUrl(baseUrl);
  checks.push({
    key: "transport_security",
    label: "HTTPS or trusted private network",
    passed: usesHttps || isPrivate,
    detail: usesHttps
      ? "Transport uses HTTPS."
      : isPrivate
        ? "Transport is on a trusted private network (LAN/VPN/Tailscale)."
        : "Remote access should use HTTPS or a trusted private network.",
    severity: usesHttps || isPrivate ? "info" : "error",
  });

  // 3. Provider callback URL matches base URL
  if (hasProvider && baseUrl) {
    const callbackMismatch = providers.some((p) => {
      const callbackUrl = (p.config as Record<string, unknown>)?.callbackUrl;
      if (typeof callbackUrl !== "string") return false;
      return !callbackUrl.startsWith(baseUrl);
    });
    checks.push({
      key: "callback_url_match",
      label: "Provider callback URL matches base URL",
      passed: !callbackMismatch,
      detail: callbackMismatch
        ? "One or more providers have a callback URL that does not match the base URL."
        : "All provider callback URLs match the configured base URL.",
      severity: callbackMismatch ? "error" : "info",
    });
  }

  // 4. Provider or manual invite explicitly selected
  checks.push({
    key: "identity_method",
    label: "Provider auth or manual invite selected",
    passed: hasProvider || hasManualInviteOption,
    detail: hasProvider
      ? `Provider auth configured: ${providers.map((p) => p.name).join(", ")}`
      : hasManualInviteOption
        ? "Manual invite fallback explicitly selected."
        : "Configure a provider or explicitly select manual invite fallback.",
    severity: hasProvider || hasManualInviteOption ? "info" : "error",
  });

  // 5. Manual invite warning when no provider
  if (!hasProvider && hasManualInviteOption) {
    checks.push({
      key: "manual_invite_warning",
      label: "Manual invite without provider identity",
      passed: false,
      detail:
        "Manual credentials provide weaker identity context and require careful rotation/revocation.",
      severity: "warning",
    });
  }

  // 6. Git-provider bridge limitation
  if (profile === "git_provider_bridge") {
    checks.push({
      key: "git_provider_bridge",
      label: "Git-provider bridge mode",
      passed: false,
      detail:
        "Git-provider bridge is a fallback for when direct Orcy access is unavailable. Direct shared habitat is not available.",
      severity: "warning",
    });
  }

  const errorChecks = checks.filter((c) => c.severity === "error" && !c.passed);
  const ready = errorChecks.length === 0 && baseUrl !== null;
  const canInvite = ready && (hasProvider || hasManualInviteOption);

  return {
    profile,
    ready,
    canInvite,
    checks,
    baseUrl,
    hasProvider,
    hasManualInviteOption,
  };
}

/** Projects an {@link IdentityProviderRow} into a summary shape with boolean flags for the presence of `clientId` and `clientSecret` (never their values), safe to return over the wire. */
export function getProviderSummary(provider: IdentityProviderRow): {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  issuer: string | null;
  hasClientId: boolean;
  hasClientSecret: boolean;
  callbackUrl: string | null;
} {
  const config = provider.config as Record<string, unknown>;
  return {
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    enabled: provider.enabled,
    issuer: provider.issuer,
    hasClientId: Boolean(config?.clientId),
    hasClientSecret: Boolean(config?.clientSecret),
    callbackUrl: typeof config?.callbackUrl === "string" ? config.callbackUrl : null,
  };
}
