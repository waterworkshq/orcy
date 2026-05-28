const SENSITIVE_PATTERNS = [/daemon-[a-f0-9]{48}/gi, /[0-9a-f-]{36}-[a-f0-9]{32}/gi];

export function redact(input: string): string {
  let result = input;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

export function redactObject<T>(obj: T): T {
  const raw = JSON.stringify(obj);
  return JSON.parse(redact(raw)) as T;
}
