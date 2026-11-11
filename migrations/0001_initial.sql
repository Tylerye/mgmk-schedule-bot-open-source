CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_locks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  locked_until INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id INTEGER PRIMARY KEY,
  processed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parse_jobs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  schedule_date TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  source_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'complete', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  dispatched_at TEXT,
  completed_at TEXT,
  error TEXT,
  UNIQUE(source_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS parse_jobs_status_idx ON parse_jobs(status, updated_at);

CREATE TABLE IF NOT EXISTS state_import (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  imported_at TEXT NOT NULL
);
