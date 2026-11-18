/**
 * Finding Triage's preflight-gated tag, retained for its attestation and test
 * harnesses. ENFORCEMENT_MIGRATION_TAGS lists every guarded test exclusion.
 */
export const ENFORCEMENT_MIGRATION_TAG = "0068_finding_triage_lifecycle_enforcement";
export const ENUM_CHECK_MIGRATION_TAG = "0090_documented_enum_check_constraints";
export const ENFORCEMENT_MIGRATION_TAGS = [
  ENFORCEMENT_MIGRATION_TAG,
  ENUM_CHECK_MIGRATION_TAG,
] as const;
