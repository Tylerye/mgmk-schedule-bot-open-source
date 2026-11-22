-- Minute probes need only undelivered commands. Completed history stays out of the index.
CREATE INDEX IF NOT EXISTS teacher_inbox_pending_retry ON teacher_inbox(teacher_id,retry_at)
WHERE status='pending';
