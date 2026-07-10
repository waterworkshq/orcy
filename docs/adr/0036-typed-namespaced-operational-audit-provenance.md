# Typed namespaced operational Audit Provenance

Canonical Audit Provenance includes optional typed `automation`, `notification`, and `plugin` context objects. Source-specific execution identity and trace/status context live in those namespaces; result payloads and domain state remain sanitized event metadata.

## Considered Options

- **Typed namespaced context (accepted).** Keeps provenance queryable and collision-free while preserving one canonical contract.
- **Metadata only.** Rejected because rule, notification, and plugin execution identity is trace context, not incidental payload.
- **Flat optional fields or an untyped details bag.** Rejected because future projection families would create collisions and weaken compile-time coverage.

## Consequences

- Operational projectors must not use double casts to bypass the shared contract.
- Raw Notification payloads, provider bodies, diffs, patches, content, and unsanitized execution output do not enter canonical provenance.
