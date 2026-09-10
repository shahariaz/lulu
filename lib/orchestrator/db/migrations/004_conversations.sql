-- 004_conversations.sql: Durable Council and Architect conversations

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('COUNCIL','ARCHITECT')),
  title TEXT,
  idea_description TEXT,
  blueprint_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system','user','assistant')),
  agent_role TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_convmsg_conversation ON conversation_messages(conversation_id);
CREATE INDEX idx_conversations_project ON conversations(project_id);
