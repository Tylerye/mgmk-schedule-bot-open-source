-- Keep only rows used by retention and delivery diagnostics in these indexes.
CREATE INDEX inbox_retention ON inbox(completed_at)
  WHERE status='done' AND payload='{}';
DROP INDEX inbox_completed;

CREATE INDEX operations_uncertain ON operations(status)
  WHERE status='uncertain' OR (status='started' AND method IN ('sendMessage','sendRichMessage','sendWidget'));
DROP INDEX operations_status;
