import { personalQuota } from './quota.js';
import { dateInTimezone } from '../dates.js';
const stoppedDays = new WeakMap();
const idleReadEstimate = new WeakMap();
const replaceJob = "payload=excluded.payload,revision=excluded.revision,status='pending',completed_at=NULL";
export const JOB_CONFLICT_UPDATE = "ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,priority=CASE WHEN jobs.status='pending' AND jobs.epoch=excluded.epoch THEN MIN(jobs.priority,excluded.priority) ELSE excluded.priority END,"
  + "due=CASE WHEN jobs.status='pending' AND jobs.epoch=excluded.epoch THEN MIN(jobs.due,excluded.due) ELSE excluded.due END,"
  + replaceJob;
// D1 and the future SQLite runtime share this small async SQL interface.
// All mutable data below belongs to the separate personal database.
export class PersonalStore {
  constructor(db, env = {}) { this.db = db; this.quota = personalQuota(env); this.canRecover = Boolean(env.LEGACY); this.read = 0; this.written = 0; }
  measure(result) {
    this.read += result?.meta?.rows_read ?? 0;
    this.written += result?.meta?.rows_written ?? 0;
    return result;
  }
  statement(sql, args = []) { return this.db.prepare(sql).bind(...args); }
  async all(sql, ...args) { return this.measure(await this.statement(sql, args).all()).results; }
  async first(sql, ...args) { return (await this.all(sql, ...args))[0] ?? null; }
  async run(sql, ...args) { return this.measure(await this.statement(sql, args).run()); }
  async batch(statements) {
    if (!statements.length) return [];
    const isJob = sql => sql.startsWith("INSERT INTO jobs(id,user_id,epoch,kind,date,priority,due,payload)");
    const jobs = statements.filter(([sql]) => isJob(sql)).length;
    let offset = jobs;
    // Reserve a unique range once, in the same transaction as all job writes.
    const batch = jobs ? [this.statement("UPDATE job_revision_sequence SET value=value+? WHERE id=1", [jobs])] : [];
    for (let [sql, ...args] of statements) {
      if (isJob(sql)) {
        sql = sql.replace("priority,due,payload)", "priority,due,payload,revision)")
          .replace("VALUES(?,?,?,?,?,?,?,?)", "VALUES(?,?,?,?,?,?,?,?,(SELECT value-? FROM job_revision_sequence WHERE id=1))")
          .replace("revision=jobs.revision+1", "revision=excluded.revision");
        args.splice(8, 0, --offset);
      }
      batch.push(this.statement(sql, args));
    }
    const results = await this.db.batch(batch);
    results.forEach(result => this.measure(result));
    return jobs ? results.slice(1) : results;
  }
  async setting(key, fallback = null) {
    const row = await this.first("SELECT value FROM settings WHERE key=?", key);
    return row ? JSON.parse(row.value) : fallback;
  }
  setSetting(key, value) {
    return this.run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE settings.value IS NOT excluded.value", key, JSON.stringify(value));
  }
  async user(id) {
    const row = await this.first("SELECT u.*, p.value AS auto_pin, EXISTS(SELECT 1 FROM settings WHERE key=?) AS has_homework "
      + "FROM users u LEFT JOIN settings p ON p.key=? WHERE u.user_id=?", `homework:${id}`, `auto-pin:${id}`, id);
    return row && { ...row, auto_pin: row.auto_pin === null ? true : JSON.parse(row.auto_pin) };
  }
  async groups() { return (await this.all("SELECT payload FROM catalog")).map(r => JSON.parse(r.payload)); }
  async schedules(group) {
    return (await this.all("SELECT s.payload FROM snapshots s JOIN active_versions a ON a.dataset_id=s.dataset_id WHERE s.group_id=? ORDER BY a.date", group)).map(r => JSON.parse(r.payload));
  }
  async upcomingSchedules(group, today) {
    const rows = await this.all("SELECT s.payload FROM active_versions a CROSS JOIN snapshots s "
      + "WHERE a.date>=? AND s.dataset_id=a.dataset_id AND s.group_id=? ORDER BY a.date LIMIT 2", today, group);
    return rows.map(row => JSON.parse(row.payload));
  }
  async schedule(group, date) {
    const row = await this.first("SELECT s.payload FROM active_versions a JOIN snapshots s ON s.dataset_id=a.dataset_id WHERE a.date=? AND s.group_id=?", date, group);
    return row ? JSON.parse(row.payload) : null;
  }
  async schedulesForDates(group, dates) {
    if (dates.length === 1) {
      const schedule = await this.schedule(group, dates[0]);
      return schedule ? [schedule] : [];
    }
    const rows = await this.all("SELECT s.payload FROM json_each(?) dates CROSS JOIN active_versions a ON a.date=dates.value "
      + "JOIN snapshots s ON s.dataset_id=a.dataset_id AND s.group_id=?", JSON.stringify(dates), group);
    return rows.map(row => JSON.parse(row.payload));
  }
  campaignReceipt(userId, campaign, messageId = null) {
    // The status index scans unrelated successful sends for a bound GLOB.
    // Both bounds use the primary key. ':' immediately precedes ';' in ASCII.
    const prefix = `${userId}:alert:${campaign}`;
    return this.first("SELECT result FROM operations WHERE id>=? AND id<? AND method='sendMessage' AND +status='succeeded'"
      + (messageId === null ? "" : " AND json_extract(result,'$.message_id')=?") + " ORDER BY rowid LIMIT 1",
    prefix + ":", prefix + ";", ...(messageId === null ? [] : [messageId]));
  }
  async previewSchedules(group, date) {
    // Arrow buttons need only the neighboring published dates for this group.
    const active = " FROM active_versions a CROSS JOIN snapshots s ON s.dataset_id=a.dataset_id AND s.group_id=? ";
    const rows = await this.all("SELECT a.date,s.payload" + active + "WHERE a.date=? "
      + "UNION ALL SELECT * FROM (SELECT a.date,NULL" + active + "WHERE a.date<? ORDER BY a.date DESC LIMIT 1) "
      + "UNION ALL SELECT * FROM (SELECT a.date,NULL" + active + "WHERE a.date>? ORDER BY a.date LIMIT 1)",
      group, date, group, date, group, date);
    return rows.map(row => row.payload ? JSON.parse(row.payload) : { date: row.date });
  }
  async weekSchedules(group, start, end) {
    const rows = await this.all("SELECT a.date, s.payload, NULL AS effective_from "
      + "FROM active_versions a LEFT JOIN snapshots s ON s.dataset_id=a.dataset_id AND s.group_id=? "
      + "WHERE a.date BETWEEN ? AND ? UNION ALL "
      + "SELECT NULL, p.value, json_extract(m.value,'$.effectiveFrom') FROM settings m JOIN settings p ON p.key=? "
      + "WHERE m.key='weekly:manifest' AND json_extract(m.value,'$.effectiveFrom')<=? "
      + "AND EXISTS (SELECT 1 FROM json_each(m.value,'$.groups') WHERE value=?) ORDER BY 1",
    group, start, end, "weekly:" + group, end, group);
    const plan = rows.find(row => row.effective_from);
    return { schedules: rows.filter(row => row.date && row.payload).map(row => JSON.parse(row.payload)),
      publishedDates: rows.filter(row => row.date).map(row => row.date),
      plan: plan ? { ...JSON.parse(plan.payload), effectiveFrom: plan.effective_from } : null };
  }
  async card(user, date) {
    const row = await this.first("SELECT * FROM cards WHERE user_id=? AND group_id=? AND date=?", user.user_id, user.group_id, date);
    return row ? { ...row, parts: JSON.parse(row.parts), schedule: row.schedule_payload ? JSON.parse(row.schedule_payload) : null } : null;
  }
  jobStatement(user, kind, date = "", { priority = 2, due = Date.now(), payload = {}, replacePending = false } = {}) {
    const id = `${user.user_id}:${kind}:${date}`;
    const conflict = replacePending
      ? "ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,priority=excluded.priority,due=excluded.due," + replaceJob
      : JOB_CONFLICT_UPDATE;
    return ["INSERT INTO jobs(id,user_id,epoch,kind,date,priority,due,payload) VALUES(?,?,?,?,?,?,?,?) "
      + conflict.replace('revision=excluded.revision', 'revision=jobs.revision+1'), id, user.user_id, user.epoch, kind, date, priority, due, JSON.stringify(payload)];
  }
  async enqueue(user, kind, date, options) { return this.batch([this.jobStatement(user, kind, date, options)]); }
  async lock(id, now, action) {
    const token = crypto.randomUUID();
    const row = await this.first("INSERT INTO locks(user_id,token,expires_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET "
      + "token=excluded.token,expires_at=excluded.expires_at WHERE locks.expires_at<=? RETURNING token", id, token, now + 90000, now);
    if (row?.token !== token) return false;
    try { await action(token); return true; }
    finally { await this.run("UPDATE locks SET expires_at=0 WHERE user_id=? AND token=?", id, token); }
  }
  backgroundPaused(row) {
    return row.rows_written >= this.quota.background || row.rows_read >= 800000 || row.requests >= 22000;
  }
  budgetLimits(lane = 'interactive') {
    return lane === 'service' ? [28000, 950000, this.quota.written]
      : lane === 'background' ? [22000, 800000, this.quota.background]
      : lane === 'source' ? [26000, 900000, this.quota.source]
      : [27900, 948000, this.quota.written - 100];
  }
  recoveryCandidate(now) {
    if (!this.canRecover) return ["0"];
    return ["((EXISTS(SELECT 1 FROM settings WHERE key='source-error' AND value<>'null') "
      + "OR EXISTS(SELECT 1 FROM datasets WHERE status='staging' AND generation<? AND date>=?)) "
      + "AND NOT EXISTS(SELECT 1 FROM settings WHERE key='recovery' AND "
      + "(json_extract(value,'$.at')>? OR (json_extract(value,'$.day')=? AND "
      + "COALESCE(json_extract(value,'$.count'),3)>=3))))",
    now.getTime() - 300000, dateInTimezone(now, "Europe/Minsk"),
    now.getTime() - 20 * 60000, now.toISOString().slice(0, 10)];
  }
  async accountIdleTick(now) {
    const day = now.toISOString().slice(0, 10), cached = stoppedDays.get(this.db);
    if (cached?.day === day && cached.lane === 'interactive' && cached.until > now.getTime()) return false;
    // Probe jobs_ready(status,priority,due) once per supported priority.
    // Unknown priorities conservatively wake the router, including legacy jobs.
    // Match the normal router admission headroom, even for the last idle tick.
    const estimate = idleReadEstimate.get(this.db) ?? 8;
    const [recovery, ...recoveryArgs] = this.recoveryCandidate(now);
    const result = await this.run("UPDATE budgets SET requests=requests+2,rows_read=rows_read+?,rows_written=rows_written+2"
      + " WHERE day=? AND requests+2<22000 AND rows_read+2000<800000 AND rows_written+20<?"
      + " AND NOT EXISTS(SELECT 1 FROM inbox WHERE status='pending')"
      + " AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.status='pending' AND j.priority IN (-2,-1,0,1,2,3,4,5) AND j.due<=?"
      + " AND EXISTS(SELECT 1 FROM users u WHERE u.user_id=j.user_id AND u.blocked=0))"
      + " AND NOT EXISTS(SELECT 1 FROM jobs WHERE status='pending' AND priority < -2)"
      + " AND NOT EXISTS(SELECT 1 FROM jobs WHERE status='pending' AND priority > 5)"
      + " AND NOT EXISTS(SELECT 1 FROM fanout WHERE status='pending')"
      + " AND NOT EXISTS(SELECT 1 FROM users WHERE paused=0 AND blocked=0 AND next_due<=?)"
      + " AND NOT (rows_written+220<? AND " + recovery + ")",
      estimate, day, this.quota.background, now.getTime(), now.getTime(), this.quota.source, ...recoveryArgs);
    if (!result.meta.changes) return false;
    const measured = this.read + 1;
    if (estimate !== measured || this.written !== 1) {
      this.reserved = { read: estimate, written: 2 };
      await this.flushBudget(now);
      idleReadEstimate.set(this.db, measured);
    }
    return true;
  }
  async budget(now = new Date(), requests = 1, { service = false, router = false, userWork = false, lane = service ? 'service' : 'interactive' } = {}) {
    const day = now.toISOString().slice(0, 10); // Account daily quotas use UTC.
    const cached = stoppedDays.get(this.db);
    // Exhausting background/source allowance must never cache a manual stop.
    if (!service && cached?.day === day && cached.lane === lane && cached.until > now.getTime()) return {mode:"stopped"};
    this.reserved = { read: service ? 500 : 2000, written: service || router ? 20 : userWork ? 100 : 200 };
    // The service allowance is INSIDE the unchanged daily ceiling. Lightweight
    // orchestration does not reserve the full delivery batch's write allowance.
    const limits = this.budgetLimits(lane);
    const row = await this.first("INSERT INTO budgets(day,requests,rows_read,rows_written) VALUES(?,?,?,?) ON CONFLICT(day) DO UPDATE SET requests=requests+excluded.requests,rows_read=rows_read+excluded.rows_read,rows_written=rows_written+excluded.rows_written WHERE requests+excluded.requests<? AND rows_read+excluded.rows_read<? AND rows_written+excluded.rows_written<? RETURNING *", day, requests, this.reserved.read, this.reserved.written, ...limits);
    if (!row) {
      if (!service) stoppedDays.set(this.db, { day, lane, until: now.getTime() + 60000 });
      this.reserved = null;
      return {mode:'stopped'};
    }
    return { ...row, mode: this.backgroundPaused(row) ? 'saving' : 'normal' };
  }
  async flushBudget(now = new Date()) {
    // Measured D1 meta includes index writes. Reserve 2 additional writes/reads
    // for this accounting query and boundary races rather than undercount it.
    if (!this.reserved) return;
    await this.run("UPDATE budgets SET rows_read=rows_read+?,rows_written=rows_written+? WHERE day=?",
      this.read + 2 - this.reserved.read, this.written + 2 - this.reserved.written, now.toISOString().slice(0, 10));
    this.reserved = null;
  }
}
