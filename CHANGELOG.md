# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.18.3 — 2026-06-12

### Refactors

#### migrate agents data from Zustand to React Query ([`d28006f`](https://github.com/waterworkshq/orcy/commit/d28006f157970021d3fd7643dd01822484de4c0f))

1. Replace direct Zustand agent state management with React Query's useAgents hook across all UI components. This change centralizes agent data fetching, caching, and synchronization, improving performance and consistency. The agent slice has been simplified to maintain only a placeholder array for backward compatibility.


#### replace Zustand state management with React Query ([`60d6e56`](https://github.com/waterworkshq/orcy/commit/60d6e566d2d78fa737a7f830b62ba90f863dcd1a))

1. Remove comment-related state management from task slice and update SSE handlers to use React Query cache invalidation instead of direct state updates. Components now fetch comments directly through React Query hooks, simplifying the store and improving data consistency.


#### migrate habitat components to use React Query board data ([`ac5f23a`](https://github.com/waterworkshq/orcy/commit/ac5f23a7e5a19d0d09df1330d13f475ef1e022f7))

1. Replace direct store access with React Query's useBoard hook across habitat components. Update AgentPanel, FilterBar, and HabitatPage to accept habitatId prop and fetch board data through React Query instead of Zustand store. This change centralizes data fetching and improves consistency with the new data management approach.


#### remove Zustand dependencies from habitat components ([`42e833c`](https://github.com/waterworkshq/orcy/commit/42e833c3bd291229b75a239e347c69d61b56b776))

1. Replace direct Zustand store access with React Query hooks across habitat components. Remove habitatStore imports and replace with useMissionTasks, useBoardTasks, and useAgents hooks. Update task actions, delegation, review, and detail panel hooks to work with React Query data instead of Zustand state. Remove store mutations from SSE handlers and rely on cache invalidation only.



### Tests

#### update habitat component tests for React Query integration ([`e7e9572`](https://github.com/waterworkshq/orcy/commit/e7e9572b9e7976b52b0ab4bbd6a493045d27e8a3))

1. Update BulkActionBar and CreateMissionForm tests to work with React Query instead of Zustand. Replace store mocks with query client mocks and update test assertions to reflect new data fetching patterns. Remove direct store mutation calls and replace with cache invalidation patterns.



## 0.18.2 — 2026-06-12

### Refactors

#### extract route logic to service layer ([`e6c231f`](https://github.com/waterworkshq/orcy/commit/e6c231fac3dc070ec186f8542224f7106a51648a))

1. Move complex business logic from route handlers to dedicated service functions. The integrations route now uses promoteIntakeCandidate service function, while the pulse route delegates to postMissionPulseSignal service function. This separation improves code organization, reduces route handler complexity, and enhances testability by isolating business logic.


#### extract route logic to service layer ([`ea1f67d`](https://github.com/waterworkshq/orcy/commit/ea1f67dcc29cbf5f36e27e43e4329962cb27480e))

1. Extract authentication, daemon, integration, and mission route logic to dedicated service functions. This change improves code organization, separates concerns, and enhances maintainability of route handlers. The service layer now handles business logic while routes focus on HTTP concerns.



## 0.18.1 — 2026-06-12

### Refactors

#### move column resolution logic to repository ([`fc5b8ab`](https://github.com/waterworkshq/orcy/commit/fc5b8abedeff8c462500695f9f3767b90b36a559))

1. Move resolveImportColumn from services/integrations/columnResolver to repositories/column.ts and update all imports to use the new location. This change improves code organization by placing column-related functionality in the repository layer.

3. The function was moved to maintain better separation of concerns, as column resolution is a data access operation that belongs in the repository layer rather than the services layer. All dependent services have been updated to use the new import path.


#### extract database operations to repository layer ([`590d316`](https://github.com/waterworkshq/orcy/commit/590d3161a3dc74d791d440e566310b9e0a0d60b9))

1. Extract database query logic from anomalyService, auditExportService, dependencyService, and predictionService into dedicated repository modules. This change improves code organization by separating data access concerns from business logic.

3. The repository pattern implementation centralizes database operations, making services cleaner and more focused on their core responsibilities. Each service now delegates data access to its corresponding repository module, improving maintainability and testability.


#### extract database operations to repository modules ([`459c79b`](https://github.com/waterworkshq/orcy/commit/459c79be5910deea0fd6bc97ea496f07474739d2))

1. Extract database query logic from auditArchivalService, boardHealthService, sprintService, and webhook services into dedicated repository modules. This change improves code organization by separating data access concerns from business logic.

3. The repository pattern implementation centralizes database operations, making services cleaner and more focused on their core responsibilities. Each service now delegates data access to its corresponding repository module, improving maintainability and testability.


#### split repositories into specialized modules ([`78a7271`](https://github.com/waterworkshq/orcy/commit/78a7271e6dcde5680411336b2bf8eb4d47ee3ce6))

1. Separate daemon and task repositories into specialized modules for better organization and maintainability. The daemon repository is split into daemonAgent, daemonInstance, and daemonSession modules, while the task repository is divided into taskCrud, taskQueries, and taskStateMachine modules. This modular approach improves code organization by separating concerns and makes the repository layer more granular and easier to understand.
