import { logger } from '../lib/logger.js';

export type SecurityPosture = 'local-dev' | 'remote';

export interface SecurityConfig {
  posture: SecurityPosture;
  isLocalDev: boolean;
  jwtSecret: string;
  registrationToken: string | undefined;
  allowOpenRegistration: boolean;
}

const LOCALHOST_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const WEAK_SECRETS = new Set([
  'dev-secret-change-in-production',
  'change-me-to-a-random-secret-in-production',
  'secret',
  'changeme',
  'password',
  'test',
]);

function isLocalhost(host: string): boolean {
  return LOCALHOST_HOSTS.has(host.toLowerCase());
}

export function classifyPosture(
  nodeEnv: string | undefined,
  host: string | undefined,
): SecurityPosture {
  const env = nodeEnv ?? process.env.NODE_ENV;
  const h = host ?? process.env.HOST ?? '127.0.0.1';

  if (env === 'production') return 'remote';
  if (isLocalhost(h)) return 'local-dev';
  return 'remote';
}

export interface ConfigValidationError {
  field: string;
  message: string;
}

export function validateSecurityConfig(
  overrides?: Partial<{
    nodeEnv: string;
    host: string;
    jwtSecret: string;
    registrationToken: string | undefined;
    devAllowOpenRegistration: string | undefined;
  }>,
): { config: SecurityConfig; errors: ConfigValidationError[] } {
  const nodeEnv = overrides?.nodeEnv ?? process.env.NODE_ENV;
  const host = overrides?.host ?? process.env.HOST ?? '127.0.0.1';
  const jwtSecret = overrides?.jwtSecret ?? process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  const registrationToken = overrides?.registrationToken ?? process.env.ORCY_REGISTRATION_TOKEN;
  const devAllowOpen = overrides?.devAllowOpenRegistration ?? process.env.ORCY_DEV_ALLOW_OPEN_REGISTRATION;

  const posture = classifyPosture(nodeEnv, host);
  const isLocalDev = posture === 'local-dev';

  const errors: ConfigValidationError[] = [];

  if (posture === 'remote') {
    if (!jwtSecret || WEAK_SECRETS.has(jwtSecret)) {
      errors.push({
        field: 'JWT_SECRET',
        message: 'JWT_SECRET must be set to a strong secret in remote/production mode',
      });
    }

    if (!registrationToken && devAllowOpen !== 'true') {
      errors.push({
        field: 'ORCY_REGISTRATION_TOKEN',
        message:
          'ORCY_REGISTRATION_TOKEN must be set in remote/production mode, or set ORCY_DEV_ALLOW_OPEN_REGISTRATION=true for explicit dev override',
      });
    }
  }

  return {
    config: {
      posture,
      isLocalDev,
      jwtSecret,
      registrationToken: registrationToken || undefined,
      allowOpenRegistration: isLocalDev || devAllowOpen === 'true',
    },
    errors,
  };
}

export function assertSecurityConfigOrExit(
  overrides?: Parameters<typeof validateSecurityConfig>[0],
): SecurityConfig {
  const { config, errors } = validateSecurityConfig(overrides);

  if (errors.length > 0) {
    for (const error of errors) {
      logger.error({ field: error.field, message: error.message }, 'Security config error');
    }
    process.exit(1);
  }

  return config;
}
