import {validGroupResult} from "./result-schema.js";
import { D1StateStore, withStateLock } from "./d1-store.js";

// Receiving a parsed PDF must never wait for Telegram or the global state lease.
export async function queueParserResult(database, job, payload) {
  if (!validGroupResult(payload?.schedule) || !payload || typeof payload !== "object" || Array.isArray(payload) || !payload.schedule
    || payload.schedule.date !== job.schedule_date || payload.document?.id !== job.source_id
    || !Array.isArray(payload.schedule.lessons) || payload.schedule.lessons.length > 64
    || (payload.schedule.timeline !== undefined && (!Array.isArray(payload.schedule.timeline) || payload.schedule.timeline.length > 128))) {
    return false;
  }
  await database.prepare("INSERT OR IGNORE INTO parser_results (job_id, payload, received_at) VALUES (?, ?, ?)")
    .bind(job.id, JSON.stringify(payload), new Date().toISOString()).run();
  return true;
}

export async function drainParserResults(database) {
  if (!await database.prepare("SELECT 1 FROM parser_results LIMIT 1").first()) return { acquired: true, value: 0 };
  return withStateLock(database, async () => {
    const rows = await database.prepare(
      "SELECT r.job_id, r.payload, j.source_id, j.schedule_date, j.status, j.created_at "
      + "FROM parser_results r JOIN parse_jobs j ON j.id = r.job_id ORDER BY j.created_at LIMIT 10",
    ).all();
    const store = new D1StateStore(database);
    await store.load();
    for (const job of rows.results) {
      const newer = await database.prepare(
        "SELECT 1 FROM parse_jobs WHERE schedule_date = ? AND status = 'complete' AND created_at > ? "
        + "AND COALESCE(json_extract(source_json,'$.audience'),'students') != 'teachers' LIMIT 1",
      ).bind(job.schedule_date, job.created_at).first();
      if (job.status !== "complete" && !newer) {
        const payload = JSON.parse(job.payload);
        store.state.documents[job.source_id] = payload.document;
        store.state.schedules[job.schedule_date] = {
          ...(store.state.schedules[job.schedule_date] ?? {}),
          schedule: payload.schedule,
          scheduleHash: payload.schedule.hash,
          sourceId: job.source_id,
          parsedAt: new Date().toISOString(),
        };
        store.state.health.lastParserSuccessAt = new Date().toISOString();
        store.state.health.nextLiveReconcileAt = 0;
        await store.save();
      }
      // A crash after state.save is safe: replay preserves the Telegram message
      // reference and the schedule hash, so reconciliation will not post twice.
      await database.prepare("UPDATE parse_jobs SET status = 'complete', completed_at = ?, updated_at = ?, error = NULL WHERE id = ?")
        .bind(new Date().toISOString(), new Date().toISOString(), job.job_id).run();
      await database.prepare("DELETE FROM parser_results WHERE job_id = ?").bind(job.job_id).run();
    }
    return rows.results.length;
  });
}
