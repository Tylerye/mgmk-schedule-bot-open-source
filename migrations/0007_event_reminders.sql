CREATE TABLE IF NOT EXISTS event_reminders (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  origin_id INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  retry_at INTEGER NOT NULL DEFAULT 0,
  sent_id INTEGER,
  prompt_id INTEGER,
  prompt_status TEXT NOT NULL DEFAULT 'pending',
  prompt_updated_at INTEGER NOT NULL,
  prompt_retry_at INTEGER NOT NULL DEFAULT 0,
  rendered_status TEXT,
  UNIQUE(chat_id,origin_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS event_reminder_active_target
  ON event_reminders(chat_id,target_id) WHERE status IN ('pending','sending');
CREATE INDEX IF NOT EXISTS event_reminder_due ON event_reminders(chat_id,status,due_at);
