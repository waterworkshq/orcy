function formatError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  const msg = err.message;

  if (
    err.cause &&
    typeof err.cause === "object" &&
    err.cause !== null &&
    "code" in err.cause &&
    (err.cause as any).code === "ECONNREFUSED"
  ) {
    return "Cannot connect to the Orcy API. Is the server running?";
  }

  if (/fetch failed|ECONNREFUSED/i.test(msg)) {
    return "Cannot connect to the Orcy API. Is the server running?";
  }

  const apiMatch = msg.match(/^API (\d+):\s*(.*)/);
  if (apiMatch) {
    const status = Number(apiMatch[1]);
    const body = apiMatch[2];
    if (status === 401) return "Authentication failed. Check that ORCY_API_KEY is set correctly.";
    if (status === 403) return "Permission denied.";
    if (status === 404) return "Resource not found. Check the IDs you provided.";
    if (status >= 400 && status < 500) return `Client error: ${body || msg}`;
    if (status >= 500) return "Server error. Check the Orcy server logs.";
  }

  return msg;
}

type AsyncActionHandler = (...args: any[]) => Promise<void>;

/** Global {@link Command}-level error handler; formats errors and exits with the right code. */
export function withErrorHandling<T extends AsyncActionHandler>(fn: T): T {
  return (async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(formatError(err));
      process.exit(1);
    }
  }) as T;
}
