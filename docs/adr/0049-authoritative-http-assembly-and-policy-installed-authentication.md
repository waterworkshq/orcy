# Authoritative HTTP assembly with policy-installed authentication

Status: accepted · 2026-08-27

Orcy will construct and register its production HTTP application through one staged assembly boundary. Every route has a typed effective authentication policy that installs its core-owned guard and feeds the production-derived inventory; missing policy prevents readiness, while object-level authorization remains a separate later layer. Production boot receives only a narrow lifecycle/runtime handle, so new routes cannot bypass the authority by registering directly on Fastify.

## Considered options

- **Observe tagged middleware.** Lower migration cost, but inherited hooks and explicit anonymous routes still need a second tracking mechanism.
- **Describe independently wired middleware.** Rejected because metadata and enforcement can drift while tests remain green.
- **Keep copied route lists and source conventions.** Rejected because they cannot prove that the served application and inspected application are the same.

## Consequences

`anonymous` means no credential; `credentialed_ingress` means a core verifier authenticates a non-local credential without establishing a local human/agent principal. Native Fastify route config declares the closed policy, a root installer applies it at the required lifecycle stage, and homogeneous route scopes may supply an inherited effective policy. `/api/v1` and deprecated `/api` remain behaviorally paired for this release, verified ingress drives raw-body eligibility, and the executable is structurally forbidden from constructing or registering routes outside the assembly.
