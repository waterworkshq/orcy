-- v0.22.3: Add last_scanned_at watermark to plugin_enrollments for detector catch-up scan (ADR-0015).
-- NULL means the detector has never been scanned (only events from enrollment onward are eligible).
ALTER TABLE plugin_enrollments ADD COLUMN `last_scanned_at` text;
