/** Truncates an error message to `maxLen` characters, appending "..." when truncation occurs. */
export function redactError(msg: string, maxLen = 500): string {
  return msg.length > maxLen ? msg.slice(0, maxLen) + "..." : msg;
}

/** Truncates a response body to `maxLen` characters, appending "..." when truncation occurs. */
export function redactResponseBody(body: string, maxLen = 1000): string {
  return body.length > maxLen ? body.slice(0, maxLen) + "..." : body;
}