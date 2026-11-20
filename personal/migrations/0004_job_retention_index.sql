-- Queue lookups remain covered by jobs_ready and jobs_user_pending.
-- Only these completed jobs can enter the bounded retention sweep.
CREATE INDEX IF NOT EXISTS jobs_retention ON jobs(completed_at)
  WHERE status IN ('done','superseded','cancelled') AND kind IN ('callback','commands');
DROP INDEX IF EXISTS jobs_completed;
