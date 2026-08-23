export const scoringSettingsSchema = `
CREATE TABLE IF NOT EXISTS scoring_settings (
  id TEXT PRIMARY KEY,
  criteria TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
`;

export const focusGroupsSchema = `
CREATE TABLE IF NOT EXISTS focus_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
)
`;

export const focusRulesSchema = `
CREATE TABLE IF NOT EXISTS focus_rules (
  id TEXT PRIMARY KEY,
  group_id TEXT,
  name TEXT NOT NULL,
  keywords TEXT NOT NULL,
  operator TEXT NOT NULL,
  created_at TEXT NOT NULL
)
`;

export const noticePublicationBatchesSchema = `
CREATE TABLE IF NOT EXISTS notice_publication_batches (
  batch_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
)
`;

export const noticeArchiveStagingSchema = `
CREATE TABLE IF NOT EXISTS notice_archive_staging (
  batch_id TEXT NOT NULL,
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (batch_id, source)
)
`;

export const noticeArchiveStagingBatchIndexSchema = `
CREATE INDEX IF NOT EXISTS idx_notice_archive_staging_batch
ON notice_archive_staging(batch_id)
`;
