-- 002_epics_and_sprints.sql: Hierarchical epics and sprint planning schema

CREATE TABLE IF NOT EXISTS epics (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  baseline_id TEXT REFERENCES requirements_baselines(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  order_index INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sprints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  goal TEXT,
  start_date INTEGER,
  end_date INTEGER,
  status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED')),
  created_at INTEGER NOT NULL
);

-- Add epic_id, sprint_id, and linked_requirement_ids_json to tasks table
ALTER TABLE tasks ADD COLUMN epic_id TEXT REFERENCES epics(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN linked_requirement_ids_json TEXT NOT NULL DEFAULT '[]';

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_epics_project ON epics(project_id);
CREATE INDEX IF NOT EXISTS idx_epics_baseline ON epics(baseline_id);
CREATE INDEX IF NOT EXISTS idx_sprints_project ON sprints(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_epic ON tasks(epic_id);
CREATE INDEX IF NOT EXISTS idx_tasks_sprint ON tasks(sprint_id);
