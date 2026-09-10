-- 003_features_and_acceptance.sql: Feature hierarchy and verifiable acceptance criteria

CREATE TABLE features (
  id TEXT PRIMARY KEY,
  epic_id TEXT NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  linked_requirement_ids_json TEXT NOT NULL DEFAULT '[]',
  order_index INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'PLANNED'
    CHECK (status IN ('PLANNED','IN_PROGRESS','COMPLETED','CANCELLED')),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_features_epic ON features(epic_id);
CREATE INDEX idx_features_project ON features(project_id);

ALTER TABLE tasks ADD COLUMN feature_id TEXT REFERENCES features(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN acceptance_criteria_json TEXT NOT NULL DEFAULT '[]';
CREATE INDEX idx_tasks_feature ON tasks(feature_id);
