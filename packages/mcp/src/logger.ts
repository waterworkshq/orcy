type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

function getLogLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  if (env in LOG_LEVEL_PRIORITY) return env as LogLevel;
  return 'info';
}

let currentLevel: LogLevel = getLogLevel();

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLevel];
}

function formatMessage(level: LogLevel, message: string, data?: Record<string, unknown>): string {
  const entry: Record<string, unknown> = {
    level,
    ts: new Date().toISOString(),
    msg: message,
    ...(data ?? {}),
  };
  return JSON.stringify(entry);
}

export const logger = {
  debug(message: string, data?: Record<string, unknown>): void {
    if (shouldLog('debug')) {
      process.stderr.write(formatMessage('debug', message, data) + '\n');
    }
  },

  info(message: string, data?: Record<string, unknown>): void {
    if (shouldLog('info')) {
      process.stderr.write(formatMessage('info', message, data) + '\n');
    }
  },

  warn(message: string, data?: Record<string, unknown>): void {
    if (shouldLog('warn')) {
      process.stderr.write(formatMessage('warn', message, data) + '\n');
    }
  },

  error(message: string, data?: Record<string, unknown>): void {
    if (shouldLog('error')) {
      process.stderr.write(formatMessage('error', message, data) + '\n');
    }
  },
};
