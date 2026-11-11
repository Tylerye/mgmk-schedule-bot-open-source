CREATE TABLE IF NOT EXISTS announcement_ack (
  request_id TEXT PRIMARY KEY,
  opened_at INTEGER,
  expires_at INTEGER,
  closed_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  rendered_version INTEGER NOT NULL DEFAULT -1,
  render_until INTEGER NOT NULL DEFAULT 0,
  render_owner TEXT,
  next_render_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS announcement_audience (
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  part INTEGER NOT NULL,
  confirmed_at INTEGER,
  PRIMARY KEY(request_id,user_id)
);
CREATE TABLE IF NOT EXISTS announcement_reminders (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt_id INTEGER,
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS announcement_reminder_parts (
  reminder_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  members TEXT NOT NULL,
  status TEXT NOT NULL,
  message_id INTEGER,
  retry_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(reminder_id,part)
);
CREATE INDEX IF NOT EXISTS announcement_reminder_pending ON announcement_reminders(status,updated_at);
