/**
 * Base application error with HTTP status, error code, and optional details.
 */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * Named error codes used throughout the application.
 */
export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  INVALID_TOKEN: 'INVALID_TOKEN',
  CAPABILITY_MISMATCH: 'CAPABILITY_MISMATCH',
  DOMAIN_MISMATCH: 'DOMAIN_MISMATCH',
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  BOARD_ACCESS_DENIED: 'BOARD_ACCESS_DENIED',
  INVALID_API_KEY: 'INVALID_API_KEY',
  REGISTRATION_TOKEN_INVALID: 'REGISTRATION_TOKEN_INVALID',
  SETUP_ALREADY_COMPLETED: 'SETUP_ALREADY_COMPLETED',
  QUALITY_GATES_NOT_MET: 'QUALITY_GATES_NOT_MET',
  TASK_BLOCKED: 'TASK_BLOCKED',
  UNSAFE_URL: 'UNSAFE_URL',
  BLOCKED_HEADERS: 'BLOCKED_HEADERS',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
} as const;

/**
 * Type guard to narrow an unknown error to an AppError.
 */
export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export function badRequest(message: string, details?: unknown): AppError {
  return new AppError(400, ErrorCodes.VALIDATION_ERROR, message, details);
}

export function unauthorized(message: string, code?: string, details?: unknown): AppError {
  return new AppError(401, code ?? ErrorCodes.UNAUTHORIZED, message, details);
}

export function forbidden(message: string, code?: string, details?: unknown): AppError {
  return new AppError(403, code ?? ErrorCodes.FORBIDDEN, message, details);
}

export function notFound(message: string, details?: unknown): AppError {
  return new AppError(404, ErrorCodes.NOT_FOUND, message, details);
}

export function conflict(message: string, details?: unknown): AppError {
  return new AppError(409, ErrorCodes.CONFLICT, message, details);
}

export function rateLimited(message = 'Too many requests'): AppError {
  return new AppError(429, ErrorCodes.RATE_LIMITED, message);
}

export function payloadTooLarge(message: string): AppError {
  return new AppError(413, ErrorCodes.PAYLOAD_TOO_LARGE, message);
}

export function internalError(message: string, details?: unknown): AppError {
  return new AppError(500, ErrorCodes.INTERNAL_ERROR, message, details);
}

export function serviceUnavailable(message: string, details?: unknown): AppError {
  return new AppError(503, ErrorCodes.INTERNAL_ERROR, message, details);
}

export function unprocessableEntity(message: string, code: string, details?: unknown): AppError {
  return new AppError(422, code, message, details);
}
