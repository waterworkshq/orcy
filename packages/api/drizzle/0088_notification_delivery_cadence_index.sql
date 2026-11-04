-- Covering index for the digest-cadence source lookup
-- (listDigestCandidateRecipientsByCadence): eq(cadence) + IN(status) prefix,
-- with the grouped (habitat, recipient) columns carried in the index so the
-- GROUP BY never touches the table.
CREATE INDEX `idx_notification_deliveries_digest_cadence`
  ON `notification_deliveries` (`cadence`, `status`, `habitat_id`, `recipient_type`, `recipient_id`);
