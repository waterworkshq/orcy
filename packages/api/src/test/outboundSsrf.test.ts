import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as dns from 'dns';
import { validateOutboundUrl, filterUnsafeHeaders, getAllowlistedHosts } from '../config/integrationSecurity.js';

describe('validateOutboundUrl', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.ORCY_SSRF_ALLOWLIST;
    delete process.env.NODE_ENV;
    delete process.env.HOST;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('blocks loopback addresses', () => {
    it('rejects http://127.0.0.1', async () => {
      const result = await validateOutboundUrl('http://127.0.0.1/webhook');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Private/internal IP');
    });

    it('rejects http://localhost', async () => {
      const result = await validateOutboundUrl('http://localhost/webhook');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Hostname');
    });

    it('rejects http://[::1]', async () => {
      const result = await validateOutboundUrl('http://[::1]/webhook');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Private/internal IP');
    });
  });

  describe('blocks private networks', () => {
    it('rejects 10.x.x.x (RFC1918)', async () => {
      const result = await validateOutboundUrl('http://10.0.0.1/webhook');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Private/internal IP');
    });

    it('rejects 172.16.x.x (RFC1918)', async () => {
      const result = await validateOutboundUrl('http://172.16.0.1/webhook');
      expect(result.valid).toBe(false);
    });

    it('rejects 192.168.x.x (RFC1918)', async () => {
      const result = await validateOutboundUrl('http://192.168.1.1/webhook');
      expect(result.valid).toBe(false);
    });

    it('rejects 169.254.169.254 (link-local / metadata)', async () => {
      const result = await validateOutboundUrl('http://169.254.169.254/latest/meta-data/');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Private/internal IP');
    });
  });

  describe('blocks multicast and reserved', () => {
    it('rejects 224.0.0.1 (multicast)', async () => {
      const result = await validateOutboundUrl('http://224.0.0.1/webhook');
      expect(result.valid).toBe(false);
    });

    it('rejects 0.0.0.0', async () => {
      const result = await validateOutboundUrl('http://0.0.0.0/webhook');
      expect(result.valid).toBe(false);
    });
  });

  describe('blocks IPv6 private', () => {
    it('rejects fc00:: (unique local)', async () => {
      const result = await validateOutboundUrl('http://[fc00::1]/webhook');
      expect(result.valid).toBe(false);
    });

    it('rejects fd00:: (unique local)', async () => {
      const result = await validateOutboundUrl('http://[fd12:3456::1]/webhook');
      expect(result.valid).toBe(false);
    });

    it('rejects fe80:: (link-local)', async () => {
      const result = await validateOutboundUrl('http://[fe80::1]/webhook');
      expect(result.valid).toBe(false);
    });

    it('rejects ff02:: (multicast)', async () => {
      const result = await validateOutboundUrl('http://[ff02::1]/webhook');
      expect(result.valid).toBe(false);
    });
  });

  describe('blocks unsafe schemes', () => {
    it('rejects file://', async () => {
      const result = await validateOutboundUrl('file:///etc/passwd');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('file');
    });

    it('rejects gopher://', async () => {
      const result = await validateOutboundUrl('gopher://localhost:6379/');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('gopher');
    });

    it('rejects ftp://', async () => {
      const result = await validateOutboundUrl('ftp://internal.server/file');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('ftp');
    });

    it('rejects data://', async () => {
      const result = await validateOutboundUrl('data:text/html,<script>alert(1)</script>');
      expect(result.valid).toBe(false);
    });

    it('rejects javascript://', async () => {
      const result = await validateOutboundUrl('javascript:alert(1)');
      expect(result.valid).toBe(false);
    });
  });

  describe('allows valid public HTTPS URLs', () => {
    it('allows https://example.com/webhook', async () => {
      const result = await validateOutboundUrl('https://example.com/webhook');
      expect(result.valid).toBe(true);
    });

    it('allows https://hooks.slack.com/services/xxx', async () => {
      const result = await validateOutboundUrl('https://hooks.slack.com/services/T00/B00/xxx');
      expect(result.valid).toBe(true);
    });

    it('allows https://discord.com/api/webhooks/xxx', async () => {
      const result = await validateOutboundUrl('https://discord.com/api/webhooks/12345/token');
      expect(result.valid).toBe(true);
    });
  });

  describe('invalid URL format', () => {
    it('rejects non-URL strings', async () => {
      const result = await validateOutboundUrl('not-a-url');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Invalid URL');
    });

    it('rejects empty string', async () => {
      const result = await validateOutboundUrl('');
      expect(result.valid).toBe(false);
    });
  });

  describe('allowlist configuration', () => {
    it('allows allowlisted internal host', async () => {
      process.env.ORCY_SSRF_ALLOWLIST = 'my-internal.local,10.0.0.5';
      const result = await validateOutboundUrl('http://my-internal.local/hook');
      expect(result.valid).toBe(true);
    });

    it('allows allowlisted IP', async () => {
      process.env.ORCY_SSRF_ALLOWLIST = '10.0.0.5';
      const result = await validateOutboundUrl('http://10.0.0.5/hook');
      expect(result.valid).toBe(true);
    });

    it('still blocks non-allowlisted internal', async () => {
      process.env.ORCY_SSRF_ALLOWLIST = '10.0.0.5';
      const result = await validateOutboundUrl('http://10.0.0.1/hook');
      expect(result.valid).toBe(false);
    });
  });

  describe('HTTPS enforcement in remote posture', () => {
    it('rejects http in remote posture', async () => {
      process.env.NODE_ENV = 'production';
      const result = await validateOutboundUrl('http://example.com/webhook');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('HTTPS');
    });

    it('allows http in local-dev without allowlist', async () => {
      process.env.HOST = '127.0.0.1';
      const result = await validateOutboundUrl('http://example.com/webhook');
      expect(result.valid).toBe(true);
    });
  });

  describe('DNS resolution', () => {
    it('blocks hostname that resolves to private IP', async () => {
      vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['127.0.0.1']);
      vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(new Error('no AAAA'));
      const result = await validateOutboundUrl('https://evil.example.com/webhook');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('resolves to private');
    });

    it('allows hostname that resolves to public IP', async () => {
      vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['93.184.216.34']);
      vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(new Error('no AAAA'));
      const result = await validateOutboundUrl('https://good.example.com/webhook');
      expect(result.valid).toBe(true);
    });

    it('allows when DNS resolution fails (literal checks passed)', async () => {
      vi.spyOn(dns.promises, 'resolve4').mockRejectedValue(new Error('ENOTFOUND'));
      vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(new Error('ENOTFOUND'));
      const result = await validateOutboundUrl('https://unknown.example.com/webhook');
      expect(result.valid).toBe(true);
    });

    it('blocks hostname resolving to 169.254.169.254', async () => {
      vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['169.254.169.254']);
      vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(new Error('no AAAA'));
      const result = await validateOutboundUrl('https://metadata-rebind.example.com/webhook');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('169.254.169.254');
    });
  });
});

describe('filterUnsafeHeaders', () => {
  it('blocks Authorization header', () => {
    const { headers, blocked } = filterUnsafeHeaders({ Authorization: 'Bearer secret' });
    expect(headers).toEqual({});
    expect(blocked).toContain('Authorization');
  });

  it('blocks Cookie header', () => {
    const { headers, blocked } = filterUnsafeHeaders({ Cookie: 'session=abc' });
    expect(headers).toEqual({});
    expect(blocked).toContain('Cookie');
  });

  it('blocks Host header', () => {
    const { headers, blocked } = filterUnsafeHeaders({ Host: 'internal.corp' });
    expect(headers).toEqual({});
    expect(blocked).toContain('Host');
  });

  it('blocks X-Forwarded-For', () => {
    const { headers, blocked } = filterUnsafeHeaders({ 'X-Forwarded-For': '10.0.0.1' });
    expect(headers).toEqual({});
    expect(blocked).toContain('X-Forwarded-For');
  });

  it('blocks X-Forwarded-Host', () => {
    const { headers, blocked } = filterUnsafeHeaders({ 'X-Forwarded-Host': 'evil.com' });
    expect(headers).toEqual({});
    expect(blocked).toContain('X-Forwarded-Host');
  });

  it('blocks Proxy-Authorization', () => {
    const { headers, blocked } = filterUnsafeHeaders({ 'Proxy-Authorization': 'Basic abc' });
    expect(headers).toEqual({});
    expect(blocked).toContain('Proxy-Authorization');
  });

  it('blocks X-Real-IP', () => {
    const { headers, blocked } = filterUnsafeHeaders({ 'X-Real-IP': '10.0.0.1' });
    expect(headers).toEqual({});
    expect(blocked).toContain('X-Real-IP');
  });

  it('blocks X-API-Key', () => {
    const { headers, blocked } = filterUnsafeHeaders({ 'X-API-Key': 'my-secret-key' });
    expect(headers).toEqual({});
    expect(blocked).toContain('X-API-Key');
  });

  it('blocks WWW-Authenticate', () => {
    const { headers, blocked } = filterUnsafeHeaders({ 'WWW-Authenticate': 'Basic realm="test"' });
    expect(headers).toEqual({});
    expect(blocked).toContain('WWW-Authenticate');
  });

  it('allows safe custom headers', () => {
    const { headers, blocked } = filterUnsafeHeaders({
      'X-Custom-Header': 'value',
      Accept: 'application/json',
      'X-Request-Id': '123',
    });
    expect(headers).toEqual({
      'X-Custom-Header': 'value',
      Accept: 'application/json',
      'X-Request-Id': '123',
    });
    expect(blocked).toEqual([]);
  });

  it('allows explicitly allowed headers', () => {
    const { headers, blocked } = filterUnsafeHeaders(
      { Authorization: 'Bearer token', 'X-Custom': 'val' },
      ['Authorization'],
    );
    expect(headers).toEqual({ Authorization: 'Bearer token', 'X-Custom': 'val' });
    expect(blocked).toEqual([]);
  });

  it('handles case-insensitive matching', () => {
    const { headers, blocked } = filterUnsafeHeaders({ authorization: 'Bearer secret' });
    expect(headers).toEqual({});
    expect(blocked).toContain('authorization');
  });

  it('returns empty when no headers provided', () => {
    const { headers, blocked } = filterUnsafeHeaders({});
    expect(headers).toEqual({});
    expect(blocked).toEqual([]);
  });
});

describe('getAllowlistedHosts', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.ORCY_SSRF_ALLOWLIST;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns empty array when not set', () => {
    expect(getAllowlistedHosts()).toEqual([]);
  });

  it('parses comma-separated hosts', () => {
      process.env.ORCY_SSRF_ALLOWLIST = 'host1,host2,host3';
    expect(getAllowlistedHosts()).toEqual(['host1', 'host2', 'host3']);
  });

  it('trims whitespace', () => {
      process.env.ORCY_SSRF_ALLOWLIST = ' host1 , host2 ';
    expect(getAllowlistedHosts()).toEqual(['host1', 'host2']);
  });

  it('filters empty entries', () => {
      process.env.ORCY_SSRF_ALLOWLIST = 'host1,,host2,';
    expect(getAllowlistedHosts()).toEqual(['host1', 'host2']);
  });
});

describe('executeHttpRequest SSRF blocking', () => {
  it('blocks request to localhost URL', async () => {
    const { executeHttpRequest } = await import('../services/webhooks/webhook-delivery.js');
    const result = await executeHttpRequest(
      'http://localhost:3000/webhook',
      '{}',
      null,
      {},
      'test-delivery-1',
      'test.event'
    );
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(0);
    expect(result.responseBody).toContain('Blocked');
  });

  it('blocks request to 127.0.0.1', async () => {
    const { executeHttpRequest } = await import('../services/webhooks/webhook-delivery.js');
    const result = await executeHttpRequest(
      'http://127.0.0.1:3000/webhook',
      '{}',
      null,
      {},
      'test-delivery-2',
      'test.event'
    );
    expect(result.success).toBe(false);
    expect(result.responseBody).toContain('Blocked');
  });

  it('blocks request to 169.254.169.254', async () => {
    const { executeHttpRequest } = await import('../services/webhooks/webhook-delivery.js');
    const result = await executeHttpRequest(
      'http://169.254.169.254/latest/meta-data/',
      '{}',
      null,
      {},
      'test-delivery-3',
      'test.event'
    );
    expect(result.success).toBe(false);
    expect(result.responseBody).toContain('Blocked');
  });

  it('filters unsafe headers from outgoing request', async () => {
    const { executeHttpRequest } = await import('../services/webhooks/webhook-delivery.js');
    const result = await executeHttpRequest(
      'https://example.com/webhook',
      '{}',
      null,
      { Authorization: 'Bearer secret', 'X-Custom': 'safe' },
      'test-delivery-4',
      'test.event'
    );
    expect(result.responseBody).not.toContain('Bearer');
  });
});

describe('sendTestWebhook SSRF blocking', () => {
  it('blocks test webhook to localhost', async () => {
    const { sendTestWebhook } = await import('../services/webhooks/webhook-delivery.js');
    const result = await sendTestWebhook({
      id: 'sub-1',
      habitatId: null,
      name: 'Test',
      url: 'http://localhost:3000/hook',
      secret: null,
      events: [],
      headers: {},
      format: 'standard',
      enabled: 1,
    });
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(0);
    expect(result.latencyMs).toBe(0);
  });

  it('blocks test webhook to private IP', async () => {
    const { sendTestWebhook } = await import('../services/webhooks/webhook-delivery.js');
    const result = await sendTestWebhook({
      id: 'sub-2',
      habitatId: null,
      name: 'Test',
      url: 'http://10.0.0.1/hook',
      secret: null,
      events: [],
      headers: {},
      format: 'standard',
      enabled: 1,
    });
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(0);
  });
});

describe('sendToSlack SSRF blocking', () => {
  it('blocks Slack send to localhost', async () => {
    const { sendToSlack } = await import('../services/slackService.js');
    const result = await sendToSlack('http://localhost:3000/slack', { text: 'test' });
    expect(result).toBe(false);
  });

  it('blocks Slack send to private IP', async () => {
    const { sendToSlack } = await import('../services/slackService.js');
    const result = await sendToSlack('http://192.168.1.1/slack', { text: 'test' });
    expect(result).toBe(false);
  });
});

describe('sendToDiscord SSRF blocking', () => {
  it('blocks Discord send to localhost', async () => {
    const { sendToDiscord } = await import('../services/discordService.js');
    const result = await sendToDiscord('http://localhost:3000/discord', { content: 'test' });
    expect(result).toBe(false);
  });

  it('blocks Discord send to private IP', async () => {
    const { sendToDiscord } = await import('../services/discordService.js');
    const result = await sendToDiscord('http://172.16.0.1/discord', { content: 'test' });
    expect(result).toBe(false);
  });
});

describe('chatService sendTestMessage SSRF blocking', () => {
  it('blocks test message to localhost for Slack', async () => {
    const { sendTestMessage } = await import('../services/chatService.js');
    const result = await sendTestMessage('http://localhost:3000/slack', 'slack');
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(0);
  });

  it('blocks test message to private IP for Discord', async () => {
    const { sendTestMessage } = await import('../services/chatService.js');
    const result = await sendTestMessage('http://10.0.0.1/discord', 'discord');
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(0);
  });
});
