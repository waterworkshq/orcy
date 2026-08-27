# Core-owned authenticated System Plugin HTTP routes

Status: accepted · 2026-08-27  
Supersedes: ADR-0041

System Plugins retain an HTTP extension surface, but Orcy replaces unrestricted `FastifyPluginCallback` mounting with manifest-declared relative routes mapped to keyed request handlers. Core registers each route under `/api/v1/plugins/:pluginId/*` and deprecated `/api/plugins/:pluginId/*`, always installs local human-or-agent authentication, and contains handler faults to the request; plugins cannot select public, signed, realtime, daemon, remote, or Habitat-scoped policies.

## Considered options

- **Retire the consumerless contribution.** Safest and smallest, but rejected to preserve a bounded trajectory for authenticated operator-installed system extensions.
- **Wrap the raw callback in inherited authentication.** Rejected because the callback can still register undeclared routes and keeps manifest/runtime membership as two authorities.
- **Run handlers through managed invocation and quarantine.** Rejected because arbitrary requests could quarantine a plugin and no current consumer justifies the runtime machinery.

## Consequences

Plugin discovery remains operational and supplies one validated route catalog to the staged HTTP assembly. Structural declaration faults reject the whole plugin at load; there is no mount-time plugin execution, so ADR-0041's crash-loud activation case no longer exists. The surface intentionally ships without an in-tree consumer and must not be broadened for OAuth/webhook extraction; at the next stable plugin-contract review, continued lack of a concrete consumer is evidence to retire it.
