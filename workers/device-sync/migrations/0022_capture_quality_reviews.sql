CREATE TABLE IF NOT EXISTS capture_quality_reviews (
  capture_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  quality TEXT NOT NULL CHECK (quality IN ('complete', 'incomplete', 'uncertain')),
  reviewer TEXT NOT NULL,
  reviewed_at INTEGER NOT NULL,
  PRIMARY KEY (capture_id, job_id),
  FOREIGN KEY (capture_id, job_id) REFERENCES capture_history(capture_id, job_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS capture_quality_reviews_reviewed_idx
  ON capture_quality_reviews(reviewed_at, quality);
