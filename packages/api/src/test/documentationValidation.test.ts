import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { AUTH_POLICY_IDS } from '../authPolicy.js';

const DOCS_DIR = resolve(import.meta.dirname, '../../../..', 'docs');
const ROOT_DIR = resolve(import.meta.dirname, '../../../..');

function readDoc(name: string): string {
  return readFileSync(resolve(DOCS_DIR, name), 'utf-8');
}

function readRootFile(name: string): string {
  return readFileSync(resolve(ROOT_DIR, name), 'utf-8');
}

interface BaselineRoute {
  method: string;
  path: string;
  authKind: string;
}

/**
 * Behavior-derived route facts from the regen-gated route baseline
 * (see routeSurfaceCharacterization.test.ts) — never a hand-maintained
 * route list. Documentation guards use these as the truth the prose must
 * state, so removing a semantic distinction from the docs fails here.
 */
function readBaselineRoutes(mode: 'apiOnly' | 'uiInstalled' | 'fixturePlugin'): BaselineRoute[] {
  const fixturePath = resolve(import.meta.dirname, 'fixtures/routeBaseline', `${mode}.json`);
  return JSON.parse(readFileSync(fixturePath, 'utf-8')).routes;
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
    const securityDoc = readDoc('SECURITY.md');
    // Guard both boundaries before slicing: a missing heading would otherwise
    // make substring(x, -1) swap its arguments and fail confusingly.
    const authStart = doc.indexOf('## Authentication');
    const authEnd = doc.indexOf('## Error Responses');
    expect(authStart, 'API.md must keep its ## Authentication heading').toBeGreaterThan(-1);
    expect(authEnd, 'API.md must keep the ## Error Responses heading that bounds the auth section').toBeGreaterThan(authStart);
    const authSection = doc.substring(authStart, authEnd);

    // SECURITY.md's closed-catalog statement lives in its Route-Level Auth
    // Summary — scope the agreement check to that section, not the whole file.
    const secStart = securityDoc.indexOf('### Route-Level Auth Summary');
    const secEnd = securityDoc.indexOf('### Auth Middleware by Route Group');
    expect(secStart, 'SECURITY.md must keep its Route-Level Auth Summary heading').toBeGreaterThan(-1);
    expect(secEnd, 'SECURITY.md must keep the Auth Middleware by Route Group heading that bounds the summary').toBeGreaterThan(secStart);
    const securityAuthSummary = securityDoc.substring(secStart, secEnd);

    it('documents agent identity binding', () => {
      expect(doc).toMatch(/agent.*identity.*derived.*from.*API.*key/i);
    });

    it('documents policy-installed authentication with a 401 outcome', () => {
      // ADR-0049 phrasing: policy-installed authentication. Pins both the
      // declaration-installs-enforcement statement and the 401 outcome.
      expect(authSection).toMatch(/Every route declares its authentication policy.*declaration installs the enforcement guard/i);
      expect(authSection).toContain('401 Unauthorized');
    });

    it('documents every policy in the production closed catalog', () => {
      // Truth source: the production catalog itself (AUTH_POLICY_IDS), not a
      // copied list. Collapsing the prose to human/agent auth drops policy IDs
      // and fails here.
      for (const policy of AUTH_POLICY_IDS) {
        expect(authSection, `API.md authentication section must mention policy "${policy}"`).toContain(policy);
        expect(securityAuthSummary, `SECURITY.md Route-Level Auth Summary must mention policy "${policy}"`).toContain(policy);
      }
    });

    it('describes the anonymous surface as examples with the installed-only static UI', () => {
      // Behavior-derived truth: the assembled surface has no /app routes in
      // API-only mode and serves /app/* anonymously only when the UI is
      // installed — so the prose must present examples (not an exhaustive
      // enumeration) and must state the /app/* anonymity conditionally.
      const apiOnly = readBaselineRoutes('apiOnly');
      const uiInstalled = readBaselineRoutes('uiInstalled');
      expect(apiOnly.filter((r) => r.path.startsWith('/app'))).toHaveLength(0);
      expect(
        uiInstalled.filter((r) => r.path.startsWith('/app') && r.authKind === 'anonymous').length,
      ).toBeGreaterThan(0);

      expect(authSection).toMatch(/for example/i);
      expect(authSection).toMatch(/not exhaustive|representative/i);
      // Load-bearing conditional-UI discriminator: "installed" must couple to
      // the /app/* mention in the same sentence. The bare /install/i form was
      // satisfiable by "declaration installs the enforcement guard".
      expect(authSection).toMatch(/installed[^.]{0,120}\/app\/\*/i);
    });

    it('scopes current/deprecated parity to the local API groups and keeps /api/shared independent', () => {
      // Behavior-derived truth: every remote_participant route lives only
      // under /api/shared — none exists under /api/v1 — so the 1:1 mirror
      // claim must be scoped to the paired local groups and must exclude the
      // shared namespace in the same breath, not imply every /api/* route has
      // a current twin.
      const apiOnly = readBaselineRoutes('apiOnly');
      const remoteParticipantRoutes = apiOnly.filter((r) => r.authKind === 'remote_participant');
      expect(remoteParticipantRoutes.length).toBeGreaterThan(0);
      expect(
        remoteParticipantRoutes.filter((r) => r.path.startsWith('/api/v1')),
        'fixture drift: remote_participant routes unexpectedly exist under /api/v1',
      ).toHaveLength(0);

      const parityAt = authSection.indexOf('1:1');
      expect(parityAt, 'the 1:1 parity claim must exist').toBeGreaterThan(-1);
      const parityContext = authSection.slice(parityAt, parityAt + 400);
      expect(parityContext).toContain('/api/shared');
      expect(parityContext).toMatch(/counterpart|independent|separate|not part of/i);
    });

    it('includes the remote-participant key in the realtime credential set', () => {
      // authenticateRealtime checks X-Orcy-Remote-Key first, delegating to
      // remoteParticipantAuth — remote participants open SSE channels with
      // their remote key, so the documented credential set must include it.
      const realtimeRow = authSection.split('\n').find((line) => line.startsWith('| `realtime` |'));
      expect(realtimeRow, 'realtime credential row must exist').toBeDefined();
      expect(realtimeRow).toContain('X-Orcy-Remote-Key');
      expect(realtimeRow).toContain('stream token');
    });

    it('scopes the daemon and registration rows to their actual routes', () => {
      // Behavior-derived: daemon-policy routes exist only under
      // /api/v1/daemon/* and deprecated /api/daemon/*; the registration
      // policy guards both agent registration and daemon self-registration.
      const daemonRow = authSection.split('\n').find((line) => line.startsWith('| `daemon` |'));
      expect(daemonRow, 'daemon credential row must exist').toBeDefined();
      expect(daemonRow).toContain('/api/v1/daemon');
      expect(daemonRow).toContain('/api/daemon');
      expect(daemonRow).not.toMatch(/standalone `?\/daemon\/\*/);

      const registrationRow = authSection.split('\n').find((line) => line.startsWith('| `registration` |'));
      expect(registrationRow, 'registration credential row must exist').toBeDefined();
      expect(registrationRow).toContain('daemon');
    });

    it('qualifies the rejection claim with the local-dev open registration posture', () => {
      // registrationAuth returns early when no token is configured: local-dev
      // posture accepts registration with no credential at all, so the
      // universal rejection sentence must disclose that exception itself.
      const claimAt = authSection.indexOf('Every other policy');
      expect(claimAt, 'the universal rejection claim must exist').toBeGreaterThan(-1);
      const claim = authSection.slice(claimAt, claimAt + 700);
      expect(claim).toMatch(/only when one is configured/);
      expect(claim).toMatch(/local-dev posture|open in local/i);
    });

    it('names the mirrored manual-invite exception inside the shared namespace scope', () => {
      // The /api/shared path space hosts two registrations: the separately
      // mounted Remote Participant API, and the deprecated twins of the
      // mirrored /shared/invites/* manual-invite routes. The prose must not
      // call the whole path space remote-only — it must name the exception.
      const parityAt = authSection.indexOf('1:1');
      expect(parityAt, 'the 1:1 parity claim must exist').toBeGreaterThan(-1);
      const parityContext = authSection.slice(parityAt, parityAt + 500);
      expect(parityContext).toContain('/api/shared');
      expect(parityContext).toMatch(/\/shared\/invites\/\*/);
      expect(parityContext).toMatch(/part of the (paired|mirrored|local)/i);
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
