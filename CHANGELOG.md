# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.18.0 — 2026-06-11

### Bug Fixes

#### improve notification event type resolution ([`a104fbb`](https://github.com/waterworkshq/orcy/commit/a104fbbeba486d7594b163fea26a07ec66473ae7))

1. This commit replaces the heuristic notification event type mapping with a proper mapping based on automation trigger types, ensuring more accurate notifications for automation rules.



### Features

#### add notification system database schema and types ([`6c56edb`](https://github.com/waterworkshq/orcy/commit/6c56edbb1fcf930f7aaa16a6bf9204fce0a9abb7))

1. This change introduces the foundational database schema and TypeScript types for the notification system, including tables for events, deliveries, subscriptions, and retention policies. The implementation supports the upcoming Notification V2 system with comprehensive relationships and proper data modeling.

3. The schema includes:
4. Notification events table to track notification triggers
5. Deliveries table for recipient-specific notification states
6. Delivery attempts table for tracking notification delivery status
7. Subscriptions table for notification preferences
8. Digest items table for grouping related notifications
9. Retention policies table for managing notification lifecycle

11. This change establishes the data foundation for v0.18's notification automation system.


#### add notification repositories implementation ([`1b6ce9b`](https://github.com/waterworkshq/orcy/commit/1b6ce9bc5f429b2567e57f1589a676a40ee68a12))

1. This change implements the repository layer for the notification system, providing data access methods for all notification-related entities. The repositories encapsulate database operations and provide a clean API for the notification services.

3. Added repositories:
4. NotificationEvent: for managing notification events
5. NotificationDelivery: for tracking delivery status and metadata
6. NotificationDeliveryAttempt: for recording delivery attempts
7. NotificationSubscription: for managing user notification preferences
8. NotificationDigest: for grouping related notifications
9. NotificationRetentionPolicy: for managing notification lifecycle

11. The implementation follows repository pattern with proper error handling and type safety.


#### implement notification services and resolvers ([`0210b7d`](https://github.com/waterworkshq/orcy/commit/0210b7df15d29a836ba21d25724f6ea49d1a0a07))

1. This change adds the service layer components for the notification system, providing business logic for notification processing, subscription management, and template handling.

3. Added services:
4. NotificationCommandService: handles notification creation and modification commands
5. NotificationSubscriptionResolver: manages user notification preferences and subscriptions
6. NotificationTemplateService: provides template management for notification formatting

8. Includes unit tests for the command service to ensure proper functionality and error handling.

10. The services integrate with the repository layer to provide a complete notification system implementation.


#### add automation system schema and types ([`641ba88`](https://github.com/waterworkshq/orcy/commit/641ba8888aeb74957aa1f294277c7b65e98a2339))

1. This change introduces the database schema and TypeScript types for the automation system, enabling rule-based automation capabilities within the application.

3. Added components:
4. Database schema for automation rules and rule runs
5. Relations between automation entities and existing habitat entities
6. Comprehensive TypeScript types for automation rules, triggers, conditions, and actions
7. Test suite for the automation schema to ensure data integrity

9. The automation system supports various event types, conditions, and actions to enable flexible automation workflows across habitats.


#### implement automation repositories ([`0c820f3`](https://github.com/waterworkshq/orcy/commit/0c820f38676007fa495c7c3ca587c11a853b57c4))

1. This change adds repository implementations for the automation system, providing data access methods for automation rules and their execution runs.

3. Added components:
4. AutomationRule repository for CRUD operations on automation rules
5. AutomationRuleRun repository for tracking rule execution history
6. Comprehensive test suite for repository functionality

8. These repositories enable the automation system to persist and retrieve automation configurations and execution data.


#### implement core automation services ([`deb153d`](https://github.com/waterworkshq/orcy/commit/deb153d9bb0d3463811f797b03ca0949ab460878))

1. This change adds the core service implementations for the automation system, including context building, rule evaluation, and simulation capabilities.

3. Added services:
4. AutomationContextBuilder for constructing execution contexts
5. AutomationEvaluator for processing automation rules
6. AutomationSimulationService for testing rule execution
7. Comprehensive test suite for the evaluator service


#### add automation execution and template rendering services ([`5e77351`](https://github.com/waterworkshq/orcy/commit/5e773510772bf714978424cd29dd0e7facc9e0fd))

1. This change extends the automation system with execution and template rendering capabilities, completing the core automation workflow.

3. Added services:
4. AutomationExecutor for processing and executing automation rules
5. AutomationTemplateRenderer for rendering automation templates
6. Comprehensive test suite for the executor service


#### implement notification channel delivery handlers ([`1f90cca`](https://github.com/waterworkshq/orcy/commit/1f90cca45e47d2e87acf0a1c171e9e182f7dbad9))

1. This commit adds support for multiple notification channels including Discord, Slack, Webhook, and in-app notifications. Each channel has its own delivery service with proper error handling and attempt tracking. The main notification delivery service coordinates between channels and provides comprehensive delivery results.

3. The implementation includes:
4. Channel-specific delivery services for Discord, Slack, Webhook, and in-app notifications
5. Delivery attempt tracking with status updates
6. Error handling and logging for each delivery attempt
7. A centralized notification delivery service that routes to appropriate channels
8. Comprehensive test coverage for all notification channels


#### add automation event ingestion and scheduled scanning ([`db48c99`](https://github.com/waterworkshq/orcy/commit/db48c993836a7a5f7789d1421bc3d7003a953599))

1. This commit introduces automation event ingestion and scheduled scanning capabilities to the automation system. It adds services for processing automation events from various sources and running periodic scans to trigger automation rules based on system state.

3. The implementation includes:
4. New automation event service that ingests and processes events with proper guards against duplicates and rate limiting
5. New automation scan service that runs periodic scans for mission blocked, sprint ending, agent silent, and evidence gap scenarios
6. Integration with the SSE broadcaster to automatically process relevant events
7. Scheduled automation scans that run every 5 minutes
8. Comprehensive test coverage for event ingestion and scanning functionality

10. The system now supports both event-driven and scheduled automation triggers with proper tracking and error handling.


#### add notification digest generation and clearance services ([`6829751`](https://github.com/waterworkshq/orcy/commit/6829751ee58b754e3907a8afbf8a8c40a937f4be))

1. This commit introduces notification digest generation and clearance services to the notification system. It adds services for processing notification digests and running periodic clearance operations to manage notification lifecycle.

3. The implementation includes:
4. New notification digest service that generates and processes digests with proper grouping and delivery tracking
5. New notification clearance service that runs periodic clearance operations for expired notifications
6. Integration with the scheduler to automatically process digests and clearances at regular intervals
7. Scheduled notification digests that run every hour
8. Scheduled notification clearance that runs every 24 hours
9. Comprehensive test coverage for digest generation and clearance functionality

11. The system now supports automated notification processing with proper tracking and error handling.


#### add notification and automation rule routes ([`46427a6`](https://github.com/waterworkshq/orcy/commit/46427a651e8151947588cd8f27e1ac02d4816976))

1. This commit introduces new API routes for notifications and automation rules, enhancing the system's automation capabilities and notification management.

3. The implementation includes:
4. New notification routes for managing notification lifecycle and preferences
5. New automation rule routes for defining and executing automation workflows
6. Notification migration service for handling data transitions
7. Integration tests for the new routes to ensure proper functionality

9. The changes expand the API's automation and notification capabilities while maintaining existing functionality.


#### implement notification and automation tool handlers ([`1b38613`](https://github.com/waterworkshq/orcy/commit/1b3861383f6f981fb93b41c0bea3dc5f0e6fc90e))

1. This commit adds comprehensive tool handlers for notifications and automation functionality, expanding the MCP's self-service capabilities.

3. The implementation includes:
4. New notification tools for inbox management, delivery handling, and subscription control
5. New automation tools for rule simulation, execution tracking, and history viewing
6. Integration with existing API endpoints for seamless functionality
7. Comprehensive test coverage for the new tool handlers

9. These changes enhance the MCP's automation and notification capabilities while maintaining a clean separation of concerns between API and tool layers.


#### add automation settings tab and notification API endpoints ([`c0d47d3`](https://github.com/waterworkshq/orcy/commit/c0d47d33883b052e77b090f900ae46204bc35091))

1. This commit adds a new automation settings tab to the habitat settings dialog and implements comprehensive notification API endpoints in the UI layer.

3. The implementation includes:
4. New AutomationTab component for managing automation rules
5. Updated HabitatSettingsDialog to include the automation tab
6. Added notificationsV2 API endpoints for inbox, history, subscriptions, and delivery management
7. Added query keys for notifications and automation data fetching
8. Integration with existing notification and automation systems

10. These changes enhance the user interface for managing automation rules and provide comprehensive notification management capabilities.


#### add automation and notification audit projections ([`0fa2748`](https://github.com/waterworkshq/orcy/commit/0fa274840f05cb8f25b4b8dd64c6be6d77d0ff53))

1. This commit adds audit projection services for automation and notification systems to track their execution history and provenance.

3. The implementation includes:
4. New automationAuditProjection service for tracking rule executions, conditions, and actions
5. Updated audit types to include automation and notification sources
6. Added test coverage for the new audit projection functionality
7. Integration with existing audit infrastructure for consistent tracking

9. These changes provide comprehensive audit trails for the new automation and notification features, enabling debugging and compliance monitoring.



## 0.17.3 — 2026-06-10

### Refactors

#### centralize SSE event handling with registry module ([`971a571`](https://github.com/waterworkshq/orcy/commit/971a571296a5755b15d059b024808b1a9006577c))

1. This change replaces the triple-switch pattern across Zustand mutation, React Query invalidation, and toast/dropdown notification handling with a centralized SSE Event Registry. The new architecture allows registering SSE event types once and ensures they are covered by completeness tests.

3. The implementation includes:
4. A new SSE registry module at packages/ui/src/sse/
5. Updated useSSE hook to use the registry for cache invalidation
6. Updated useSSENotifications hook to use the registry for notification handling
7. Updated sseHandler slice to use the registry for state updates
8. Documentation updates in README.md and docs/ROADMAP.md

10. This change prepares the real-time UI event path for v0.18's workflow automation and Notification System V2 by establishing a centralized event handling architecture.



## 0.17.2 — 2026-06-10

### Performance

#### add effort metrics recalculation and transition debouncing ([`a52c609`](https://github.com/waterworkshq/orcy/commit/a52c60989e17b41720c552f5ec827ab5494b734a))

1. This change implements automatic recalculation of effort metrics when tasks are completed or approved, ensuring consistent actualMinutes values. It also introduces transition recalculation debouncing via the ORCY_TRANSITION_RECALC_DEBOUNCE environment variable to optimize performance in high-frequency transition scenarios.

3. The implementation adds error handling for effort metric recalculations and includes comprehensive test coverage for the new functionality. Additionally, it defines which task actions trigger notifications via the notifyTaskEvent system to prevent inconsistencies.
