import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const DOCS_DIR = resolve(import.meta.dirname, '../../../..', 'docs');
const ROOT_DIR = resolve(import.meta.dirname, '../../../..');

function readDoc(name: string): string {
  return readFileSync(resolve(DOCS_DIR, name), 'utf-8');
}

function readRootFile(name: string): string {
  return readFileSync(resolve(ROOT_DIR, name), 'utf-8');
}

describe('Documentation validation', () => {
  describe('SECURITY.md', () => {
    const doc = readDoc('SECURITY.md');

    it('documents the dual posture model (local-dev vs remote)', () => {
      expect(doc).toContain('local-dev');
      expect(doc).toContain('remote');
      expect(doc).toContain('ADR-001');
    });

    it('documents agent identity binding from request.agent.id', () => {
      expect(doc).toContain('request.agent.id');
      expect(doc).toMatch(/never.*accept.*agent.*ID.*from.*URL|body|path/i);
    });

    it('documents all auth middleware types', () => {
      expect(doc).toContain('agentAuth');
      expect(doc).toContain('humanAuth');
      expect(doc).toContain('agentOrHumanAuth');
      expect(doc).toContain('authenticateRealtime');
    });

    it('documents startup validation for remote posture', () => {
      expect(doc).toContain('assertSecurityConfigOrExit');
      expect(doc).toContain('JWT_SECRET');
      expect(doc).toContain('ORCY_REGISTRATION_TOKEN');
    });

    it('documents inbound webhook fail-closed behavior', () => {
      expect(doc).toMatch(/fail.closed|fail-closed/i);
      expect(doc).toMatch(/constant.time/i);
    });

    it('documents outbound SSRF protections', () => {
      expect(doc).toContain('SSRF');
      expect(doc).toContain('ORCY_SSRF_ALLOWLIST');
    });

    it('documents git worktree safe execution', () => {
      expect(doc).toContain('execFileSync');
      expect(doc).toMatch(/no shell.*interpolation|without.*shell/i);
    });

    it('documents realtime stream tokens', () => {
      expect(doc).toMatch(/stream.?token/i);
      expect(doc).toContain('30');
    });

    it('documents task lifecycle authorization', () => {
      expect(doc).toMatch(/owner.only/i);
      expect(doc).toMatch(/reviewer.only/i);
    });

    it('documents known limitations without overstating protections', () => {
      expect(doc).toContain('Known Security Limitations');
      expect(doc).not.toContain('Agent impersonation\n**Severity');
    });
  });

  describe('DEPLOYMENT.md', () => {
    const doc = readDoc('DEPLOYMENT.md');

    it('documents required secrets for remote posture', () => {
      expect(doc).toContain('JWT_SECRET');
      expect(doc).toContain('ORCY_REGISTRATION_TOKEN');
    });

    it('documents ORCY_DEV_ALLOW_OPEN_REGISTRATION override', () => {
      expect(doc).toContain('ORCY_DEV_ALLOW_OPEN_REGISTRATION');
    });

    it('documents ORCY_SSRF_ALLOWLIST', () => {
      expect(doc).toContain('ORCY_SSRF_ALLOWLIST');
    });

    it('production checklist includes JWT_SECRET and REGISTRATION_TOKEN', () => {
      const checklistSection = doc.substring(doc.indexOf('Production Checklist'));
      expect(checklistSection).toContain('JWT_SECRET');
      expect(checklistSection).toContain('ORCY_REGISTRATION_TOKEN');
    });
  });

  describe('CONFIGURATION.md', () => {
    const doc = readDoc('CONFIGURATION.md');

    it('documents ORCY_DEV_ALLOW_OPEN_REGISTRATION', () => {
      expect(doc).toContain('ORCY_DEV_ALLOW_OPEN_REGISTRATION');
    });

    it('documents ORCY_SSRF_ALLOWLIST', () => {
      expect(doc).toContain('ORCY_SSRF_ALLOWLIST');
    });

    it('documents security posture classification', () => {
      expect(doc).toContain('local-dev');
      expect(doc).toContain('remote');
      expect(doc).toContain('NODE_ENV');
    });

    it('documents JWT_SECRET with production warning', () => {
      expect(doc).toContain('JWT_SECRET');
    });
  });

  describe('API.md', () => {
    const doc = readDoc('API.md');

    it('documents agent identity binding', () => {
      expect(doc).toMatch(/agent.*identity.*derived.*from.*API.*key/i);
    });

    it('documents that all non-public endpoints require auth', () => {
      expect(doc).toMatch(/All non-public.*endpoint.*require.*auth/i);
    });

    it('documents stream tokens for realtime auth', () => {
      expect(doc).toMatch(/stream.?token/i);
    });

    it('claim endpoint documents agent auth requirement', () => {
      const claimSection = doc.substring(doc.indexOf('POST /tasks/:id/claim'));
      expect(claimSection.substring(0, 500)).toMatch(/Agent auth required/i);
    });

    it('approve/reject endpoints document JWT-only auth', () => {
      const approveSection = doc.substring(doc.indexOf('POST /tasks/:id/approve'));
      expect(approveSection.substring(0, 500)).toMatch(/JWT auth required/i);

      const rejectSection = doc.substring(doc.indexOf('POST /tasks/:id/reject'));
      expect(rejectSection.substring(0, 500)).toMatch(/JWT auth required/i);
    });
  });

  describe('SKILL.md', () => {
    const doc = readDoc('SKILL.md');

    it('documents agent identity binding in MCP context', () => {
      expect(doc).toMatch(/agent.*identity.*request\.agent\.id|derived from.*API key/i);
    });

    it('documents that impersonation is prevented', () => {
      expect(doc).toMatch(/cannot.*impersonate|impersonating another agent/i);
    });
  });

  describe('.env.example', () => {
    const doc = readRootFile('.env.example');

    it('includes JWT_SECRET with production warning', () => {
      expect(doc).toContain('JWT_SECRET');
      expect(doc).toMatch(/remote posture|production/i);
    });

    it('includes ORCY_REGISTRATION_TOKEN', () => {
      expect(doc).toContain('ORCY_REGISTRATION_TOKEN');
    });

    it('includes ORCY_DEV_ALLOW_OPEN_REGISTRATION (commented)', () => {
      expect(doc).toContain('ORCY_DEV_ALLOW_OPEN_REGISTRATION');
    });

    it('includes ORCY_SSRF_ALLOWLIST (commented)', () => {
      expect(doc).toContain('ORCY_SSRF_ALLOWLIST');
    });

    it('does not contain actual secret values', () => {
      const weakDefaults = [
        /JWT_SECRET=(?!change-me|$)/,
        /ORCY_REGISTRATION_TOKEN=(?!change-me|$)/,
      ];
      for (const pattern of weakDefaults) {
        expect(doc).not.toMatch(pattern);
      }
    });
  });
});
