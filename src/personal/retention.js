// No deletion occurs unless an operator explicitly enables it AND requests apply.
// Schedules, users, cards, send receipts and uncertain work are never candidates.
const DAY = 86400000;
export async function retentionCandidates(store, now = Date.now()) {
  const inbox = await store.first("SELECT COUNT(*) count FROM (SELECT update_id FROM inbox WHERE status='done' AND completed_at<? AND payload='{}' LIMIT 101)", now - 7 * DAY);
  const jobs = await store.first("SELECT COUNT(*) count FROM (SELECT id FROM jobs WHERE status IN ('done','superseded','cancelled') AND kind IN ('callback','commands') AND completed_at<? LIMIT 101)", now - 30 * DAY);
  return { inbox: Math.min(100, inbox.count), jobs: Math.min(100, jobs.count), bounded: true, more: inbox.count > 100 || jobs.count > 100 };
}
export async function maintainPersonalRecords(store, { now = Date.now(), enabled = false, dryRun = true } = {}) {
  const candidates = await retentionCandidates(store, now);
  if (!enabled || dryRun) return { ...candidates, applied: false };
  // One shared limit of 100 rows, with conditions repeated in the write.
  const inbox = await store.run("DELETE FROM inbox WHERE update_id IN (SELECT update_id FROM inbox WHERE status='done' AND completed_at<? AND payload='{}' ORDER BY completed_at LIMIT 100)", now - 7 * DAY);
  const removed = Number(inbox.meta?.changes ?? 0);
  if (removed < 100) await store.run("DELETE FROM jobs WHERE id IN (SELECT id FROM jobs WHERE status IN ('done','superseded','cancelled') AND kind IN ('callback','commands') AND completed_at<? ORDER BY completed_at LIMIT ?)", now - 30 * DAY, 100 - removed);
  return { ...candidates, applied: true };
}
