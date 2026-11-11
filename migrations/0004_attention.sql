CREATE TABLE IF NOT EXISTS attention_members (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS attention_requests (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  origin_key TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  test INTEGER NOT NULL,
  status TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  prompt_id INTEGER,
  confirmed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (chat_id, origin_key, test)
);
CREATE TABLE IF NOT EXISTS attention_parts (
  request_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  message_id INTEGER,
  retry_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (request_id, part)
);
CREATE TABLE IF NOT EXISTS attention_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attention_pending_idx ON attention_requests(status, updated_at);
CREATE TABLE IF NOT EXISTS attention_local_inbox (
  update_id INTEGER PRIMARY KEY,
  payload TEXT NOT NULL
);
