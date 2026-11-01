/**
 * Test-only constants shared by every seeded-harness config (#147).
 * This module must stay side-effect free — no config imports, no fs/env work —
 * so any config can import it without triggering another harness evaluation.
 */
export const API_PORT = 3147;
export const UI_PORT = 5147;
/** mkdtemp prefix shared with the teardown's exact-match ownership shape check. */
export const RUN_ROOT_PREFIX = "orcy-seeded-e2e-";
