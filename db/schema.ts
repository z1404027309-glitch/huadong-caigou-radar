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
