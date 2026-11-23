-- Deploy a Worker that accepts trigger-adjusted changes before applying this migration.
INSERT INTO security_storage_counts(name,rows) SELECT 'runtime_locks',COUNT(*) FROM runtime_locks;
CREATE TRIGGER security_count_add_runtime_lock AFTER INSERT ON runtime_locks
BEGIN
  UPDATE security_storage_counts SET rows=rows+1 WHERE name='runtime_locks';
END;
CREATE TRIGGER security_count_remove_runtime_lock AFTER DELETE ON runtime_locks
BEGIN
  UPDATE security_storage_counts SET rows=rows-1 WHERE name='runtime_locks';
END;
