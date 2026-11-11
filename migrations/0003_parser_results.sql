CREATE TABLE IF NOT EXISTS parser_results (
  job_id TEXT PRIMARY KEY REFERENCES parse_jobs(id),
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL
);
