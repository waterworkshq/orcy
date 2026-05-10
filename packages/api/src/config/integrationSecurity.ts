import { createHmac, timingSafeEqual } from 'crypto';
import * as dns from 'dns';
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

export interface UrlValidationResult {
  valid: boolean;
  reason?: string;
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

  try {
    const [v4, v6] = await Promise.allSettled([
      dns.promises.resolve4(hostname),
      dns.promises.resolve6(hostname),
    ]);

    const resolved: string[] = [];
    if (v4.status === 'fulfilled') resolved.push(...v4.value);
    if (v6.status === 'fulfilled') resolved.push(...v6.value);

    for (const ip of resolved) {
      if (isPrivateIP(ip)) {
        return { valid: false, reason: `Hostname "${hostname}" resolves to private/internal IP "${ip}"` };
      }
    }
  } catch (err) {
    logger.warn({ err, hostname }, 'DNS resolution failed during SSRF check');
    return { valid: false, reason: 'DNS resolution failed' };
  }

  if (scheme !== 'https') {
    const posture = classifyPosture(undefined, undefined);
    if (posture === 'remote') {
      return { valid: false, reason: 'HTTPS is required for outbound requests in production/remote posture' };
    }
  }

  return { valid: true };
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
