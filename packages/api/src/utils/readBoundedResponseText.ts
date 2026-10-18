/** Maximum fetch-decoded response bytes retained for webhook diagnostics. */
const RESPONSE_PREFIX_BYTES = 8192;

/**
 * Read only a diagnostic prefix, then cancel without awaiting transport cleanup.
 * Fetch may prefetch and a read may expose a larger chunk; this bounds retained
 * application bytes, not socket traffic or the fetch implementation's buffers.
 */
export async function readBoundedResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let remaining = RESPONSE_PREFIX_BYTES;
  let text = "";
  let done = false;
  try {
    while (remaining > 0) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        return text + decoder.decode();
      }
      const prefix = next.value.subarray(0, remaining);
      text += decoder.decode(prefix, { stream: true });
      remaining -= prefix.byteLength;
    }
    // No final flush at an intentional byte cutoff: an incomplete final UTF-8
    // sequence is omitted, while complete malformed sequences still replace.
    return text;
  } finally {
    if (!done) {
      // An underlying cancel may reject or never settle. Neither should turn
      // an accepted HTTP response into a retry, or delay returning its summary.
      void reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}
