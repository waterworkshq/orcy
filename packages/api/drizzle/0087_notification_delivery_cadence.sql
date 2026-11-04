-- Required-default cadence end-to-end (owner decision 2026-11-03): the
-- RESOLVED cadence of a delivery is downstream scheduling authority. Additive
-- column-level DEFAULT 'immediate' (the push_epoch precedent, migration 0077):
-- every pre-existing row and every insert path that passes no cadence (the
-- deprecated test-only wrapper, direct repo producers) keeps legacy behavior.
-- No backfill: legacy rows were scheduled by recipient-specific
-- subscriptions, which remain a digest grouping source.
ALTER TABLE `notification_deliveries` ADD COLUMN `cadence` text NOT NULL DEFAULT 'immediate';
