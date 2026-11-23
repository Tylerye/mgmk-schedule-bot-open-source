-- Rebuild only secondary indexes. Apply all statements in one D1 batch.
DROP INDEX inbox_pending;
DROP INDEX inbox_user_pending;
CREATE INDEX inbox_pending ON inbox(update_id) WHERE status='pending';
CREATE INDEX inbox_user_pending ON inbox(user_id,update_id) WHERE status='pending';

DROP INDEX jobs_ready;
DROP INDEX jobs_user_pending;
CREATE INDEX jobs_ready ON jobs(priority,due) WHERE status='pending';
CREATE INDEX jobs_user_pending ON jobs(user_id,kind) WHERE status='pending';
CREATE INDEX jobs_failed ON jobs(id) WHERE status='failed';
