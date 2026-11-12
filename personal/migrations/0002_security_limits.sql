ALTER TABLE inbox ADD COLUMN completed_at INTEGER;
ALTER TABLE jobs ADD COLUMN completed_at INTEGER;
CREATE INDEX IF NOT EXISTS inbox_completed ON inbox(status,completed_at);
CREATE INDEX IF NOT EXISTS jobs_completed ON jobs(status,completed_at);
CREATE TRIGGER IF NOT EXISTS security_cap_inbox BEFORE INSERT ON inbox WHEN NOT EXISTS(SELECT 1 FROM inbox WHERE update_id=NEW.update_id) AND (SELECT COUNT(*) FROM inbox)>=100000 BEGIN SELECT RAISE(ABORT,'technical storage limit reached'); END;
CREATE TRIGGER IF NOT EXISTS security_cap_jobs BEFORE INSERT ON jobs WHEN NOT EXISTS(SELECT 1 FROM jobs WHERE id=NEW.id) AND (SELECT COUNT(*) FROM jobs)>=100000 BEGIN SELECT RAISE(ABORT,'technical storage limit reached'); END;
CREATE TRIGGER IF NOT EXISTS security_cap_operations BEFORE INSERT ON operations WHEN NOT EXISTS(SELECT 1 FROM operations WHERE id=NEW.id) AND (SELECT COUNT(*) FROM operations)>=100000 BEGIN SELECT RAISE(ABORT,'technical storage limit reached'); END;
CREATE TRIGGER IF NOT EXISTS security_cap_settings BEFORE INSERT ON settings WHEN NOT EXISTS(SELECT 1 FROM settings WHERE key=NEW.key) AND (SELECT COUNT(*) FROM settings)>=100000 BEGIN SELECT RAISE(ABORT,'technical storage limit reached'); END;
CREATE TRIGGER IF NOT EXISTS security_cap_datasets BEFORE INSERT ON datasets WHEN NOT EXISTS(SELECT 1 FROM datasets WHERE id=NEW.id) AND (SELECT COUNT(*) FROM datasets)>=100000 BEGIN SELECT RAISE(ABORT,'technical storage limit reached'); END;
CREATE TRIGGER IF NOT EXISTS security_complete_inbox AFTER UPDATE OF status ON inbox WHEN NEW.status='done' AND NEW.completed_at IS NULL BEGIN UPDATE inbox SET completed_at=unixepoch()*1000 WHERE update_id=NEW.update_id; END;
CREATE TRIGGER IF NOT EXISTS security_complete_job AFTER UPDATE OF status ON jobs WHEN NEW.status IN ('done','superseded','cancelled') AND NEW.completed_at IS NULL BEGIN UPDATE jobs SET completed_at=unixepoch()*1000 WHERE id=NEW.id; END;

CREATE TRIGGER IF NOT EXISTS security_interactive_queue BEFORE INSERT ON jobs WHEN NEW.kind IN ('reply','callback','commands') AND NOT EXISTS(SELECT 1 FROM jobs WHERE id=NEW.id) AND ((SELECT COUNT(*) FROM jobs WHERE status='pending' AND kind IN ('reply','callback','commands'))>=500 OR (SELECT COUNT(*) FROM jobs WHERE user_id=NEW.user_id AND status='pending' AND kind IN ('reply','callback','commands'))>=5) BEGIN SELECT RAISE(ABORT,'interactive queue limit reached'); END;

CREATE TRIGGER IF NOT EXISTS security_pending_job AFTER UPDATE OF status ON jobs WHEN NEW.status='pending' AND NEW.completed_at IS NOT NULL BEGIN UPDATE jobs SET completed_at=NULL WHERE id=NEW.id; END;
