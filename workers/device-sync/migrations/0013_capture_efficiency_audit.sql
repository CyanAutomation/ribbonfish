ALTER TABLE capture_targets ADD COLUMN wait_for_selector TEXT;

ALTER TABLE capture_jobs ADD COLUMN validator_outcome TEXT NOT NULL DEFAULT 'unknown'
  CHECK (validator_outcome IN ('unknown', 'disabled', 'unchanged', 'changed', 'no_stored_validator', 'unavailable', 'cached_asset_missing'));
ALTER TABLE capture_jobs ADD COLUMN result_kind TEXT NOT NULL DEFAULT 'unknown'
  CHECK (result_kind IN ('unknown', 'screenshot', 'validator_unchanged'));
ALTER TABLE capture_jobs ADD COLUMN scheduled_due_at INTEGER;
ALTER TABLE capture_jobs ADD COLUMN browser_ms_total INTEGER;
ALTER TABLE capture_jobs ADD COLUMN browser_ms_response_header INTEGER;
ALTER TABLE capture_jobs ADD COLUMN browser_ms_reserve INTEGER;
ALTER TABLE capture_jobs ADD COLUMN browser_ms_legacy_unknown INTEGER NOT NULL DEFAULT 1
  CHECK (browser_ms_legacy_unknown IN (0, 1));
CREATE INDEX IF NOT EXISTS capture_jobs_created_idx ON capture_jobs(created_at);

ALTER TABLE capture_history ADD COLUMN browser_ms_source TEXT NOT NULL DEFAULT 'unknown'
  CHECK (browser_ms_source IN ('unknown', 'response_header', 'reserve'));
CREATE INDEX IF NOT EXISTS capture_history_captured_idx ON capture_history(captured_at);

ALTER TABLE capture_decisions ADD COLUMN observed_at INTEGER;
ALTER TABLE capture_decisions ADD COLUMN observed_result TEXT
  CHECK (observed_result IN ('changed', 'unchanged', 'validator_unchanged', 'failed', 'budget_deferred'));
ALTER TABLE capture_decisions ADD COLUMN observed_delay_ms INTEGER
  CHECK (observed_delay_ms IS NULL OR observed_delay_ms >= 0);
