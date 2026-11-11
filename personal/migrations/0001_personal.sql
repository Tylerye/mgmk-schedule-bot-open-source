-- A SEPARATE database. Never apply this to the existing bot/teacher database.
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE catalog (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE datasets (id TEXT PRIMARY KEY, date TEXT NOT NULL, generation INTEGER NOT NULL,
  manifest TEXT NOT NULL, expected_count INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'staging', source_id TEXT, fingerprint TEXT);
CREATE TABLE snapshots (dataset_id TEXT NOT NULL, group_id TEXT NOT NULL, hash TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(dataset_id,group_id), FOREIGN KEY(dataset_id) REFERENCES datasets(id));
CREATE INDEX datasets_staging ON datasets(status,generation);
CREATE TABLE active_versions (date TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, generation INTEGER NOT NULL);
CREATE TABLE users (user_id INTEGER PRIMARY KEY, language TEXT NOT NULL DEFAULT 'ru', group_id TEXT,
  epoch INTEGER NOT NULL DEFAULT 1, screen TEXT NOT NULL DEFAULT 'language',
  sound INTEGER NOT NULL DEFAULT 1, changes INTEGER NOT NULL DEFAULT 1, pin INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0, support_seen INTEGER NOT NULL DEFAULT 0,
  pin_message_id INTEGER, pin_date TEXT, next_due INTEGER, last_api_at INTEGER NOT NULL DEFAULT 0);
CREATE INDEX users_group_active ON users(group_id,paused,blocked,user_id);
CREATE INDEX users_due ON users(paused,blocked,next_due);
CREATE TABLE inbox (update_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', received_at INTEGER NOT NULL);
CREATE INDEX inbox_pending ON inbox(status,update_id);
CREATE TABLE jobs (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, epoch INTEGER NOT NULL,
  kind TEXT NOT NULL, date TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL, due INTEGER NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'pending');
CREATE INDEX jobs_ready ON jobs(status,priority,due);
CREATE TABLE cards (user_id INTEGER NOT NULL, group_id TEXT NOT NULL, date TEXT NOT NULL,
  parts TEXT NOT NULL DEFAULT '[]', mode TEXT NOT NULL DEFAULT 'compact', schedule_hash TEXT, schedule_payload TEXT,
  PRIMARY KEY(user_id,group_id,date));
CREATE TABLE operations (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL,
  result TEXT, started_at INTEGER NOT NULL);
CREATE INDEX operations_status ON operations(status);
CREATE TABLE locks (user_id INTEGER PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE fanout (dataset_id TEXT NOT NULL, group_id TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(dataset_id,group_id));
CREATE INDEX fanout_pending ON fanout(status);
CREATE TABLE budgets (day TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0, rows_read INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0);
CREATE TABLE rate_gate (key TEXT PRIMARY KEY, next_at INTEGER NOT NULL);
