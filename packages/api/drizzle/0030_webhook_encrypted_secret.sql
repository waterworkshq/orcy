-- v0.19 Phase E fix: Add encrypted_secret column to remote_webhook_endpoints
-- for AES-256-GCM encrypted signing secrets that survive process restarts.
-- The plaintext secret is encrypted using a key derived from JWT_SECRET
-- and stored here. On dispatch, the dispatcher decrypts it for HMAC signing.

ALTER TABLE `remote_webhook_endpoints` ADD COLUMN `encrypted_secret` text;
