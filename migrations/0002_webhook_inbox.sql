CREATE TABLE IF NOT EXISTS telegram_inbox (
  update_id INTEGER PRIMARY KEY,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL
);
