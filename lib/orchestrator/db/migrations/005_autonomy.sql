-- 005_autonomy.sql: Project-level ownership policy for automatic transitions

ALTER TABLE projects ADD COLUMN autonomy_mode TEXT NOT NULL DEFAULT 'GUIDED'
  CHECK (autonomy_mode IN ('GUIDED','SUPERVISED','AUTONOMOUS'));
