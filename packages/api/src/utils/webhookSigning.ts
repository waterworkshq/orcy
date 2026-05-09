import { createHmac, randomBytes } from 'crypto';

export function generateSecret(): string {
  return randomBytes(32).toString('hex');
}

export function signPayload(payload: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}
