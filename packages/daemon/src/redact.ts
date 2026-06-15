const SENSITIVE_PATTERNS = [/daemon-[a-f0-9]{48}/gi, /[0-9a-f-]{36}-[a-f0-9]{32}/gi];

/** Replaces any token-shaped substring in `input` (daemon tokens, agent API keys) with `[REDACTED]`. */
export function redact(input: string): string {
  let result = input;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

/** JSON round-trips `obj` through {@link redact} so nested string fields lose tokens. */
export function redactObject<T>(obj: T): T {
  const raw = JSON.stringify(obj);
  return JSON.parse(redact(raw)) as T;
}
