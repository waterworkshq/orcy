import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import {
  classifyPosture,
  validateSecurityConfig,
  assertSecurityConfigOrExit,
  type SecurityConfig,
  type ConfigValidationError,
} from '../config/security.js';

vi.mock('../lib/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

import { logger } from '../lib/logger.js';

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
}

describe('classifyPosture', () => {
  it('returns remote when NODE_ENV=production', () => {
    expect(classifyPosture('production', '127.0.0.1')).toBe('remote');
  });

  it('returns local-dev for localhost HOST when not production', () => {
    expect(classifyPosture(undefined, '127.0.0.1')).toBe('local-dev');
    expect(classifyPosture(undefined, 'localhost')).toBe('local-dev');
    expect(classifyPosture(undefined, '::1')).toBe('local-dev');
  });

  it('returns remote for non-localhost HOST when not production', () => {
    expect(classifyPosture(undefined, '0.0.0.0')).toBe('remote');
    expect(classifyPosture(undefined, '192.168.1.1')).toBe('remote');
    expect(classifyPosture(undefined, 'example.com')).toBe('remote');
  });

  it('defaults to local-dev when no env vars provided and HOST is default', () => {
    expect(classifyPosture(undefined, undefined)).toBe('local-dev');
  });
});

describe('validateSecurityConfig', () => {
  describe('local-dev posture', () => {
    it('accepts default JWT secret without error', () => {
      const { config, errors } = validateSecurityConfig({
        nodeEnv: 'development',
        host: '127.0.0.1',
        jwtSecret: 'dev-secret-change-in-production',
      });
      expect(errors).toHaveLength(0);
      expect(config.posture).toBe('local-dev');
      expect(config.isLocalDev).toBe(true);
    });

    it('allows missing registration token', () => {
      const { config, errors } = validateSecurityConfig({
        nodeEnv: 'development',
        host: '127.0.0.1',
        jwtSecret: 'some-secret',
        registrationToken: undefined,
      });
      expect(errors).toHaveLength(0);
      expect(config.allowOpenRegistration).toBe(true);
    });

    it('accepts relaxed mode only when explicitly local', () => {
      const { config, errors } = validateSecurityConfig({
        nodeEnv: 'development',
        host: '127.0.0.1',
      });
      expect(errors).toHaveLength(0);
      expect(config.isLocalDev).toBe(true);
    });
  });

  describe('remote / production posture', () => {
    it('fails when NODE_ENV=production without JWT_SECRET', () => {
      const { errors } = validateSecurityConfig({
        nodeEnv: 'production',
        host: '0.0.0.0',
        jwtSecret: 'dev-secret-change-in-production',
      });
      const jwtError = errors.find((e) => e.field === 'JWT_SECRET');
      expect(jwtError).toBeDefined();
      expect(jwtError!.message).toContain('strong secret');
    });

    it('fails when NODE_ENV=production with weak JWT_SECRET', () => {
      for (const weak of ['secret', 'changeme', 'password', 'test', 'change-me-to-a-random-secret-in-production']) {
        const { errors } = validateSecurityConfig({
          nodeEnv: 'production',
          host: '0.0.0.0',
          jwtSecret: weak,
          registrationToken: 'valid-token',
        });
        const jwtError = errors.find((e) => e.field === 'JWT_SECRET');
        expect(jwtError).toBeDefined();
      }
    });

    it('passes with strong JWT_SECRET in production', () => {
      const { errors } = validateSecurityConfig({
        nodeEnv: 'production',
        host: '0.0.0.0',
        jwtSecret: 'a8f3e2c1d4b5a6f7e8c9d0b1a2f3e4c5',
        registrationToken: 'valid-token',
      });
      expect(errors).toHaveLength(0);
    });

    it('fails when remote without ORCY_REGISTRATION_TOKEN and no dev override', () => {
      const { errors } = validateSecurityConfig({
        nodeEnv: 'production',
        host: '0.0.0.0',
        jwtSecret: 'a8f3e2c1d4b5a6f7e8c9d0b1a2f3e4c5',
        registrationToken: undefined,
        devAllowOpenRegistration: undefined,
      });
      const regError = errors.find((e) => e.field === 'ORCY_REGISTRATION_TOKEN');
      expect(regError).toBeDefined();
      expect(regError!.message).toContain('ORCY_REGISTRATION_TOKEN must be set');
    });

    it('passes remote without ORCY_REGISTRATION_TOKEN when dev override is set', () => {
      const { errors } = validateSecurityConfig({
        nodeEnv: 'production',
        host: '0.0.0.0',
        jwtSecret: 'a8f3e2c1d4b5a6f7e8c9d0b1a2f3e4c5',
        registrationToken: undefined,
        devAllowOpenRegistration: 'true',
      });
      expect(errors).toHaveLength(0);
    });

    it('fails remote with non-localhost HOST even in development', () => {
      const { config } = validateSecurityConfig({
        nodeEnv: 'development',
        host: '0.0.0.0',
        jwtSecret: 'dev-secret-change-in-production',
      });
      expect(config.posture).toBe('remote');
    });

    it('returns both JWT and registration errors at once', () => {
      const { errors } = validateSecurityConfig({
        nodeEnv: 'production',
        host: '0.0.0.0',
        jwtSecret: 'dev-secret-change-in-production',
        registrationToken: undefined,
      });
      expect(errors).toHaveLength(2);
    });
  });
});

describe('assertSecurityConfigOrExit', () => {
  const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
  const mockError = vi.spyOn(logger, 'error').mockImplementation(() => {});

  afterEach(() => {
    mockExit.mockClear();
    mockError.mockClear();
  });

  afterAll(() => {
    mockExit.mockRestore();
    mockError.mockRestore();
  });

  it('returns config when valid', () => {
    const config = assertSecurityConfigOrExit({
      nodeEnv: 'development',
      host: '127.0.0.1',
      jwtSecret: 'dev-secret-change-in-production',
    });
    expect(config.posture).toBe('local-dev');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('calls process.exit on invalid config', () => {
    expect(() =>
      assertSecurityConfigOrExit({
        nodeEnv: 'production',
        host: '0.0.0.0',
        jwtSecret: 'dev-secret-change-in-production',
      })
    ).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockError).toHaveBeenCalled();
  });
});
