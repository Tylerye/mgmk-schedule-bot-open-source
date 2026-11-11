CREATE TABLE IF NOT EXISTS recruitments (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 30),
  status TEXT NOT NULL,
  message_id INTEGER,
  opened_at INTEGER,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  retry_at INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  rendered_version INTEGER NOT NULL DEFAULT -1,
  render_owner TEXT,
  render_until INTEGER NOT NULL DEFAULT 0,
  next_render_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(chat_id,target_id)
);
CREATE TABLE IF NOT EXISTS recruitment_members (
  recruitment_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sequence INTEGER NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(recruitment_id,user_id)
);
CREATE INDEX IF NOT EXISTS recruitment_active ON recruitment_members(recruitment_id,active,sequence);
CREATE INDEX IF NOT EXISTS recruitment_pending ON recruitments(status,updated_at);
