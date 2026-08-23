CREATE TABLE IF NOT EXISTS notice_publication_batches (
  batch_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS notice_archive_staging (
  batch_id TEXT NOT NULL,
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (batch_id, source)
);

CREATE INDEX IF NOT EXISTS idx_notice_archive_staging_batch
ON notice_archive_staging(batch_id);

PRAGMA optimize;
