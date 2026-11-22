import { mergeCatalog, groupKey } from "./catalog.js";
import { JOB_CONFLICT_UPDATE } from './store.js';

const validDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
export const MAX_STAGE_SCHEDULES = 12;
export const MAX_STAGE_BYTES = 196608;

const validHash = v => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const text = (v, max = 3000) => typeof v === "string" && v.length <= max;
const time = v => typeof v === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(v);

export function compactSchedule(schedule) {
  const lesson = l => ({ number: l.number, variants: l.variants.map(v => ({ subject: v.subject, room: v.room, teacher: v.teacher })),
    notes: l.notes.map(n => ({ text: n.text })) });
  return { ...schedule, rows: undefined, lessons: schedule.lessons.map(lesson),
    notes: schedule.notes.map(n => ({ text: n.text })), statuses: schedule.statuses.map(n => ({ text: n.text })),
    timeline: schedule.timeline.map(e => e.type === "lesson" ? { type: "lesson", ...lesson(e), start: e.start, end: e.end } : e) };
}
export function validSchedule(s, dataset, manifest) {
  if (!s || !validDate(s.date) || s.date !== dataset.date || s.canonicalGroup !== groupKey(s.group) || !manifest[s.canonicalGroup]
    || s.hash !== manifest[s.canonicalGroup] || !validHash(s.hash) || !text(s.displayGroup, 40) || !Array.isArray(s.lessons)
    || s.lessons.length > 24 || !Array.isArray(s.timeline) || s.timeline.length > 60 || !Array.isArray(s.notes) || !Array.isArray(s.statuses)) return false;
  const note = n => n && text(n.text);
  const validLesson = l => Number.isInteger(l.number) && l.number > 0 && l.number <= 24 && Array.isArray(l.variants)
    && l.variants.length > 0 && l.variants.length <= 12 && l.variants.every(v => text(v.subject) && v.subject.trim() && text(v.room) && text(v.teacher))
    && Array.isArray(l.notes) && l.notes.length <= 30 && l.notes.every(note);
  return new Set(s.lessons.map(l => l.number)).size === s.lessons.length && s.lessons.every(validLesson)
    && s.notes.length <= 50 && s.statuses.length <= 50 && s.notes.every(note) && s.statuses.every(note)
    && s.timeline.every(e => ["lesson", "break", "large_break", "lunch", "curator_hour", "information_hour"].includes(e.type)
      && time(e.start) && time(e.end) && e.start < e.end && (e.type !== "lesson" || validLesson(e)))
    && s.timeline.filter(e => e.type === "lesson").length === s.lessons.length
    && s.lessons.every(l => JSON.stringify(l) === JSON.stringify((({ type, start, end, ...l }) => l)(s.timeline.find(e => e.type === "lesson" && e.number === l.number) ?? {})));
}

export async function mergeCatalogObservations(store, observations, seedVersion) {
  if (!Array.isArray(observations) || observations.length > 10 || observations.some(o => !o || !validDate(o.date))) throw new Error("Invalid catalog batch");
  const catalog = mergeCatalog([], observations);
  // Merge only touched groups, under the write transaction. Two simultaneously
  // uploaded PDFs must not replace one another's dates or aliases.
  const statements = catalog.map(group => [
    "INSERT INTO catalog(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=json_set(catalog.payload,"
    + "'$.dates',json((SELECT json_group_array(value) FROM (SELECT value FROM json_each(catalog.payload,'$.dates') UNION SELECT value FROM json_each(excluded.payload,'$.dates') ORDER BY value))),"
    + "'$.sourceLabels',json((SELECT json_group_array(value) FROM (SELECT value FROM json_each(catalog.payload,'$.sourceLabels') UNION SELECT value FROM json_each(excluded.payload,'$.sourceLabels'))))) "
    + "WHERE EXISTS(SELECT value FROM json_each(excluded.payload,'$.dates') EXCEPT SELECT value FROM json_each(catalog.payload,'$.dates')) "
    + "OR EXISTS(SELECT value FROM json_each(excluded.payload,'$.sourceLabels') EXCEPT SELECT value FROM json_each(catalog.payload,'$.sourceLabels'))",
    group.id, JSON.stringify(group),
  ]);
  if (validHash(seedVersion)) statements.push([
    "INSERT INTO settings(key,value) VALUES('catalog-seed-version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE settings.value<>excluded.value",
    JSON.stringify(seedVersion),
  ]);
  await store.batch(statements);
}

export async function beginDataset(store, input) {
  if (!validHash(input.id) || !validDate(input.date) || !Number.isSafeInteger(input.generation) || input.generation <= 0
    || !input.manifest || typeof input.manifest !== "object" || Array.isArray(input.manifest) || Object.keys(input.manifest).length < 1
    || Object.keys(input.manifest).length > 200 || Object.entries(input.manifest).some(([id, hash]) => !/^\d{1,3}[\p{L}]{1,6}$/u.test(id) || !validHash(hash))
    || !Array.isArray(input.observations) || input.observations.length > 10) throw new Error("Invalid dataset manifest");
  // Catalog discovery is independent of which schedules parsed successfully.
  if (input.observations.length) await mergeCatalogObservations(store, input.observations);
  const existing = await store.first("SELECT * FROM datasets WHERE id=?", input.id);
  const manifest = JSON.stringify(input.manifest);
  if (existing && (existing.manifest !== manifest || existing.date !== input.date || existing.generation !== input.generation)) throw new Error("Dataset identity conflict");
  await store.run("INSERT OR IGNORE INTO datasets(id,date,generation,manifest,expected_count,source_id,fingerprint) VALUES(?,?,?,?,?,?,?)",
    input.id, input.date, input.generation, manifest, Object.keys(input.manifest).length,
    typeof input.sourceId === "string" ? input.sourceId.slice(0, 100) : null, typeof input.fingerprint === "string" ? input.fingerprint.slice(0, 1000) : null);
}

export async function stageSchedules(store, id, schedules) {
  const dataset = await store.first("SELECT * FROM datasets WHERE id=?", id);
  if (!dataset || !Array.isArray(schedules) || schedules.length > MAX_STAGE_SCHEDULES || !schedules.length) throw new Error("Invalid staging batch");
  const manifest = JSON.parse(dataset.manifest);
  if (schedules.some(s => !validSchedule(s, dataset, manifest))) throw new Error("Invalid staged schedule");
  if (dataset.status === "ready") return;
  await store.batch(schedules.map(s => ["INSERT INTO snapshots(dataset_id,group_id,hash,payload) VALUES(?,?,?,?) "
    + "ON CONFLICT(dataset_id,group_id) DO UPDATE SET hash=excluded.hash,payload=excluded.payload WHERE snapshots.payload<>excluded.payload", id, s.canonicalGroup, s.hash, JSON.stringify(s)]));
}

export async function finishDataset(store, id) {
  const dataset = await store.first("SELECT * FROM datasets WHERE id=?", id);
  if (!dataset) throw new Error("Unknown dataset");
  if (dataset.status === "ready") return false;
  const rows = await store.all("SELECT group_id,hash FROM snapshots WHERE dataset_id=?", id);
  const manifest = JSON.parse(dataset.manifest);
  if (rows.length !== dataset.expected_count || rows.some(r => manifest[r.group_id] !== r.hash)) throw new Error("Incomplete dataset; delivery prohibited");
  // Activation and creation of fanout cursors are one transaction. Generations
  // are assigned by the existing source job; older jobs cannot replace newer.
  const results = await store.batch([
    ["UPDATE datasets SET status='ready' WHERE id=?", id],
    ["UPDATE datasets SET status='superseded' WHERE date=? AND generation<? AND status='staging'", dataset.date, dataset.generation],
    ["INSERT OR IGNORE INTO fanout(dataset_id,group_id) SELECT s.dataset_id,s.group_id FROM snapshots s WHERE s.dataset_id=? "
      + "AND EXISTS(SELECT 1 FROM users u WHERE u.group_id=s.group_id AND u.paused=0 AND u.blocked=0) "
      + "AND NOT EXISTS(SELECT 1 FROM active_versions a WHERE a.date=? AND a.generation>=?) "
      + "AND NOT EXISTS(SELECT 1 FROM snapshots old JOIN active_versions a ON old.dataset_id=a.dataset_id WHERE a.date=? AND old.group_id=s.group_id AND old.hash=s.hash)",
      id, dataset.date, dataset.generation, dataset.date],
    ["INSERT INTO active_versions(date,dataset_id,generation) VALUES(?,?,?) ON CONFLICT(date) DO UPDATE SET dataset_id=excluded.dataset_id,generation=excluded.generation "
      + "WHERE active_versions.generation<excluded.generation", dataset.date, id, dataset.generation],
    ...(dataset.source_id ? [["INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      `source:${dataset.source_id}`, JSON.stringify({ fingerprint: dataset.fingerprint, date: dataset.date })]] : []),
  ]);
  return Number(results[3]?.meta?.changes) > 0;
}

export async function fanoutBatch(store, now = Date.now()) {
  // Do not spend one minute per empty group before reaching the pilot owner.
  // New/resumed subscribers obtain their own current snapshots on entry.
  await store.run("UPDATE fanout SET status='done' WHERE status='pending' "
    + "AND EXISTS(SELECT 1 FROM datasets d WHERE d.id=fanout.dataset_id AND d.status='ready') "
    + "AND NOT EXISTS(SELECT 1 FROM users u WHERE u.group_id=fanout.group_id AND u.paused=0 AND u.blocked=0 AND u.user_id>fanout.cursor)");
  const event = await store.first("SELECT f.*,d.date FROM fanout f JOIN datasets d ON d.id=f.dataset_id WHERE f.status='pending' AND d.status='ready' ORDER BY d.generation DESC LIMIT 1");
  if (!event) return;
  const active = await store.first("SELECT dataset_id FROM active_versions WHERE date=?", event.date);
  if (active?.dataset_id !== event.dataset_id) { await store.run("UPDATE fanout SET status='superseded' WHERE dataset_id=? AND status='pending'", event.dataset_id); return; }
  // A batch spans subscribed groups in one bounded transaction,
  // rather than making late groups wait behind one HTTP invocation per group.
  // Reserve a revision range once; unused revisions are harmless gaps. All
  // selection and cursor advancement happens under the same D1 transaction,
  // so concurrent pumps cannot requeue recipients from a completed batch.
  // At most 24 new jobs (6 D1 writes each), 24 cursor/index updates
  // (2 each), and one sequence write fit the existing 200-write reservation.
  const limit = 24;
  // Jobs do not change subscription eligibility. Reuse the same bounded set
  // for allocation, enqueue and progress inside this transaction.
  const recipients = "SELECT u.user_id,u.group_id,u.epoch FROM fanout f "
    + "CROSS JOIN users u ON u.group_id=f.group_id "
    + "WHERE f.dataset_id=? AND f.status='pending' AND u.paused=0 AND u.blocked=0 AND u.user_id>f.cursor "
    + "AND EXISTS(SELECT 1 FROM active_versions WHERE date=? AND dataset_id=f.dataset_id) "
    + "ORDER BY f.group_id,u.user_id LIMIT ?";
  await store.batch([
    ["UPDATE job_revision_sequence SET value=value+? WHERE id=1 AND EXISTS(" + recipients + ")", limit, event.dataset_id, event.date, 1],
    ["INSERT INTO jobs(id,user_id,epoch,kind,date,priority,due,payload,revision) "
      + "SELECT CAST(u.user_id AS TEXT)||':card:'||?,u.user_id,u.epoch,'card',?,1,?,'{}',"
      + "(SELECT value FROM job_revision_sequence WHERE id=1)-?+ROW_NUMBER() OVER (ORDER BY u.group_id,u.user_id) "
      + "FROM (" + recipients + ") u WHERE 1 " + JOB_CONFLICT_UPDATE,
      event.date, event.date, now, limit, event.dataset_id, event.date, limit],
    ["WITH progress AS MATERIALIZED (SELECT group_id,MAX(user_id) next_cursor FROM (" + recipients + ") GROUP BY group_id) "
      + "UPDATE fanout SET cursor=COALESCE((SELECT next_cursor FROM progress WHERE group_id=fanout.group_id),cursor),"
      + "status=CASE WHEN EXISTS(SELECT 1 FROM users u WHERE u.group_id=fanout.group_id AND u.paused=0 AND u.blocked=0 "
      + "AND u.user_id>COALESCE((SELECT next_cursor FROM progress WHERE group_id=fanout.group_id),fanout.cursor)) "
      + "THEN 'pending' ELSE 'done' END WHERE dataset_id=? AND status='pending' AND group_id IN (SELECT group_id FROM progress)",
      event.dataset_id, event.date, limit, event.dataset_id],
  ]);
}
