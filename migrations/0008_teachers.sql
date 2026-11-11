CREATE TABLE IF NOT EXISTS teacher_users (
  teacher_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE,
  notifications INTEGER NOT NULL DEFAULT 1,
  pinned_message_id INTEGER,
  enrolled_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS teacher_schedules (
  teacher_id TEXT NOT NULL,
  date TEXT NOT NULL,
  hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  source_created_at TEXT NOT NULL,
  PRIMARY KEY (teacher_id, date)
);
CREATE TABLE IF NOT EXISTS teacher_documents (
  source_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  source_created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS teacher_publications (
  teacher_id TEXT NOT NULL,
  date TEXT NOT NULL,
  message_id INTEGER,
  hash TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (teacher_id, date)
);
CREATE TABLE IF NOT EXISTS teacher_inbox (
  update_id INTEGER PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS teacher_notices (
  teacher_id TEXT NOT NULL,
  date TEXT NOT NULL,
  revision INTEGER NOT NULL,
  hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(teacher_id,date,revision)
);
CREATE TABLE IF NOT EXISTS teacher_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
