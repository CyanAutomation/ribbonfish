ALTER TABLE capture_targets ADD COLUMN schedule_reviewed_at INTEGER;

-- Existing targets were created as part of a playlist save with an explicit
-- schedule choice (or the published default), so preserve their eligibility.
UPDATE capture_targets SET schedule_reviewed_at = created_at;
