import { createHmac, timingSafeEqual } from 'crypto';
import * as dns from 'dns';
import { Agent } from 'undici';
import { classifyPosture } from './security.js';
import { logger } from '../lib/logger.js';

const DEFAULT_SLACK_TIMESTAMP_SKEW_SECONDS = 60 * 5;

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

const BLOCKED_SCHEMES = new Set(['file', 'ftp', 'gopher', 'data', 'javascript']);

const BLOCKED_HEADER_PREFIXES = [
  'authorization',
  'cookie',
  'host',
  'x-forwarded',
  'proxy-',
  'x-real-ip',
  'x-api-key',
  'www-authenticate',
];

/**
 * `resolvedIps` carries the addresses the validation pass resolved (empty for
 * allowlisted hosts and absent on rejections) so callers can pin their fetch
 * to exactly these addresses instead of triggering a second DNS lookup.
 */
export interface UrlValidationResult {
  valid: boolean;
  reason?: string;
  resolvedIps?: string[];
}

export function getAllowlistedHosts(): string[] {
  const raw = process.env.ORCY_SSRF_ALLOWLIST ?? '';
  if (!raw.trim()) return [];
  return raw.split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:a.b.c.d and ::ffff:xxxx:xxxx) embeds an IPv4
  // address that the prefix checks below never inspect — unwrap it first.
  const mappedV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized);
  if (mappedV4) return isPrivateIPv4(mappedV4[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (mappedHex) {
    const packed = (parseInt(mappedHex[1], 16) << 16) | parseInt(mappedHex[2], 16);
    return isPrivateIPv4(
      `${(packed >>> 24) & 255}.${(packed >>> 16) & 255}.${(packed >>> 8) & 255}.${packed & 255}`,
    );
  }
  if (normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe80')) return true;
  if (normalized.startsWith('ff')) return true;
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;
  return false;
}

function isPrivateIP(ip: string): boolean {
  if (ip.includes(':')) return isPrivateIPv6(ip);
  return isPrivateIPv4(ip);
}

export async function validateOutboundUrl(url: string): Promise<UrlValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }

  const scheme = parsed.protocol.replace(':', '').toLowerCase();
  if (BLOCKED_SCHEMES.has(scheme)) {
    return { valid: false, reason: `Scheme "${scheme}:" is not allowed for outbound requests` };
  }

  if (scheme !== 'https' && scheme !== 'http') {
    return { valid: false, reason: `Scheme "${scheme}:" is not allowed` };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const allowlisted = getAllowlistedHosts();

  if (allowlisted.includes(hostname)) {
    return { valid: true };
  }

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { valid: false, reason: `Hostname "${hostname}" is not allowed` };
  }

  if (isPrivateIP(hostname)) {
    return { valid: false, reason: `Private/internal IP "${hostname}" is not allowed` };
  }

  // Literal-IP hosts were private-checked above; fetching them performs no
  // DNS lookup, so they neither need nor have a resolution pass.
  const isLiteralIp = hostname.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(hostname);

  let resolved: string[] = [];
  if (isLiteralIp) {
    resolved = [hostname];
  } else {
    const [v4, v6] = await Promise.allSettled([
      dns.promises.resolve4(hostname),
      dns.promises.resolve6(hostname),
    ]);
    if (v4.status === 'fulfilled') resolved.push(...v4.value);
    if (v6.status === 'fulfilled') resolved.push(...v6.value);

    // Fail closed: an empty answer set (e.g. a rebinding hostname that
    // refuses resolution at validation time) must not pass as valid.
    if (resolved.length === 0) {
      return { valid: false, reason: 'DNS resolution returned no addresses' };
    }

    for (const ip of resolved) {
      if (isPrivateIP(ip)) {
        return { valid: false, reason: `Hostname "${hostname}" resolves to private/internal IP "${ip}"` };
      }
    }
  }

  if (scheme !== 'https') {
    const posture = classifyPosture(undefined, undefined);
    if (posture === 'remote') {
      return { valid: false, reason: 'HTTPS is required for outbound requests in production/remote posture' };
    }
  }

  return { valid: true, resolvedIps: resolved };
}

/** Thrown by {@link fetchValidated} when the URL fails the canonical check —
 * typed so callers can distinguish validation rejections from network errors. */
export class UrlRejectedError extends Error {
  constructor(reason: string) {
    super(`URL rejected: ${reason}`);
    this.name = 'UrlRejectedError';
  }
}

/** A dns.lookup-compatible callback that answers ONLY with `ips` — the
 * addresses the validation pass resolved — so the fetch cannot be
 * DNS-rebinding-diverted to a different answer. */
export function buildPinnedLookup(ips: string[]) {
  const answers = ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  return (
    _hostname: string,
    options: { all?: boolean } | ((err: Error | null, address: string, family: number) => void),
    maybeCallback?: (err: Error | null, result: unknown) => void,
  ): void => {
    const callback = (typeof options === 'function' ? options : maybeCallback) as
      ((err: Error | null, address?: unknown, family?: number) => void) | undefined;
    if (!callback) throw new Error('pinned lookup: missing callback');
    if (typeof options === 'object' && options.all) {
      callback(null, answers);
      return;
    }
    callback(null, answers[0].address, answers[0].family);
  };
}

// Bounded cache: one Agent per (hostname, validated-ips) pair. Agents hold
// keep-alive sockets, so per-call instantiation would leak; the bound keeps
// the cache finite under many distinct targets.
const pinnedAgents = new Map<string, Agent>();
const PINNED_AGENT_CACHE_LIMIT = 128;

function pinnedAgentFor(hostname: string, ips: string[]): Agent {
  const key = `${hostname}|${[...ips].sort().join(',')}`;
  let agent = pinnedAgents.get(key);
  if (!agent) {
    agent = new Agent({
      connect: { lookup: buildPinnedLookup(ips) as never },
    });
    pinnedAgents.set(key, agent);
    if (pinnedAgents.size > PINNED_AGENT_CACHE_LIMIT) {
      const oldest = pinnedAgents.keys().next().value;
      if (oldest !== undefined) {
        const evicted = pinnedAgents.get(oldest);
        pinnedAgents.delete(oldest);
        void evicted?.close().catch(() => {});
      }
    }
  }
  return agent;
}

/**
 * Validates `url` with the canonical checker and fetches it PINNED to the
 * addresses that validation resolved (one DNS resolution total, SNI
 * preserved) — closing the validate-then-fetch rebinding window. Redirects
 * fail closed and a 10s timeout applies unless `init.signal` overrides.
 * Allowlisted hosts (valid without resolution) fetch unpinned.
 * Throws {@link UrlRejectedError} on validation failure.
 */
export async function fetchValidated(url: string, init: RequestInit = {}): Promise<Response> {
  const check = await validateOutboundUrl(url);
  if (!check.valid) throw new UrlRejectedError(check.reason ?? 'not allowed');
  const requestInit: RequestInit = {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    ...init,
  };
  const pinned = check.resolvedIps ?? [];
  if (pinned.length > 0) {
    const { hostname } = new URL(url);
    // Cast to a fresh object type: Node's RequestInit already declares
    // `dispatcher` with its bundled undici-types version, which is
    // structurally incompatible with the standalone undici Agent's types.
    (requestInit as { dispatcher?: unknown }).dispatcher = pinnedAgentFor(hostname, pinned);
  }
  return fetch(url, requestInit);  return fetch(url, requestInit);
}

export function filterUnsafeHeaders(
  headers: Record<string, string>,
  allowedKeys?: string[],
): { headers: Record<string, string>; blocked: string[] } {
  const blocked: string[] = [];
  const safe: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    const isBlocked = BLOCKED_HEADER_PREFIXES.some(prefix => lower.startsWith(prefix));
    const isExplicitlyAllowed = allowedKeys?.some(ak => ak.toLowerCase() === lower);

    if (isBlocked && !isExplicitlyAllowed) {
      blocked.push(key);
    } else {
      safe[key] = value;
    }
  }

  return { headers: safe, blocked };
}

const SENSITIVE_HEADER_PATTERNS = [
  /^authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^x-api-key$/i,
  /^x-auth-token$/i,
  /^x-access-token$/i,
  /^x-secret$/i,
  /^x-hub-signature(-256)?$/i,
  /^x-slack-signature$/i,
  /^proxy-authorization$/i,
  /^www-authenticate$/i,
  /secret/i,
  /token/i,
  /key/i,
  /password/i,
  /auth/i,
];

export function redactSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_PATTERNS.some(pattern => pattern.test(key))) {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

export function isRemotePosture(): boolean {
  return classifyPosture(undefined, undefined) === 'remote';
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    const maxLen = Math.max(bufA.length, bufB.length);
    const paddedA = Buffer.alloc(maxLen);
    const paddedB = Buffer.alloc(maxLen);
    bufA.copy(paddedA, maxLen - bufA.length);
    bufB.copy(paddedB, maxLen - bufB.length);
    timingSafeEqual(paddedA, paddedB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function verifyGitHubHmac(rawBody: string | Buffer, signature: string, secret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function verifyGitLabToken(providedToken: string, secret: string): boolean {
  if (!providedToken || !secret) return false;
  return constantTimeEqual(providedToken, secret);
}

export function verifySlackSignature(
  signature: string | undefined,
  timestamp: string | undefined,
  rawBody: string,
  signingSecret: string,
  maxSkewSeconds: number = DEFAULT_SLACK_TIMESTAMP_SKEW_SECONDS,
): { valid: boolean; reason?: string } {
  if (!signingSecret) {
    return { valid: false, reason: 'No signing secret configured' };
  }
  if (!signature) {
    return { valid: false, reason: 'Missing X-Slack-Signature header' };
  }
  if (!timestamp) {
    return { valid: false, reason: 'Missing X-Slack-Request-Timestamp header' };
  }

  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) {
    return { valid: false, reason: 'Invalid timestamp' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > maxSkewSeconds) {
    return { valid: false, reason: 'Timestamp too old or too far in future' };
  }

  const baseString = `v0:${timestamp}:${rawBody}`;
  const expected = 'v0=' + createHmac('sha256', signingSecret).update(baseString).digest('hex');

  try {
    const valid = timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    return valid ? { valid: true } : { valid: false, reason: 'Signature mismatch' };
  } catch {
    return { valid: false, reason: 'Signature comparison error' };
  }
}

export function verifyDiscordSignature(
  signature: string | undefined,
  timestamp: string | undefined,
  rawBody: string,
  publicKey: string,
): boolean {
  if (!signature || !timestamp || !publicKey) return false;
  try {
    const nacl = require('tweetnacl');
    const enc = new TextEncoder();
    const message = enc.encode(timestamp + rawBody);
    const sigBytes = Buffer.from(signature, 'hex');
    const keyBytes = Buffer.from(publicKey, 'hex');
    return nacl.sign.detached.verify(message, sigBytes, keyBytes);
  } catch {
    return false;
  }
}
